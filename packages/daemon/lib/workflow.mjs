import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { now, compareVersions, bumpVersion, parseRow } from './store.mjs';
import { git, run } from './run.mjs';
import { ADD_IMAGE } from './claude.mjs';

const pad = (id) => String(id).padStart(4, '0');

export function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function lane(name, onSettled) {
  let tail = Promise.resolve();
  let depth = 0;
  return {
    get busy() {
      return depth > 0;
    },
    push(label, fn) {
      depth++;
      const job = tail.then(fn).catch((err) => {
        console.error(`[${name}] ${label} crashed`, err);
      }).finally(() => {
        depth--;
        onSettled();
      });
      tail = job;
      return job;
    },
  };
}

/**
 * A project's request lifecycle: notes -> summarize -> implement in a worktree
 * -> preview -> land, plus version switching. Everything a project needs is
 * passed in, so the daemon can run any number of these side by side.
 */
export function createWorkflow(project, { store, events, claude, releases }) {
  const { db, getSetting, setSetting, getRequest, updateRequest, notesFor, listVersions } = store;
  const { changed, logEvent, notifyDev } = events;
  const { summarize, implement } = claude;
  const { build, dedupeAgainstCurrent, ensureDeps, linkDeps, switchCurrent, thumbnail } = releases;
  const { paths } = project;

  // ---------------------------------------------------------------- lanes
  // Lane A runs Claude implementations, strictly one at a time. Lane B runs
  // publishes, discards and version switches, which are quick, so a five-minute
  // implementation never blocks the owner's ◀ ▶.

  const implementLane = lane(`${project.id}:implement`, changed);
  const publishLane = lane(`${project.id}:publish`, changed);

  function setStatus(id, status, extra = {}) {
    const req = updateRequest(id, { status, ...extra });
    logEvent(id, 'status', status);
    changed();
    return req;
  }

  // ---------------------------------------------------------------- notes

  function draftNotes() {
    return db.prepare('SELECT * FROM notes WHERE request_id IS NULL ORDER BY id').all().map((r) => parseRow('notes', r));
  }

  async function waitForTranscripts(noteIds, timeoutMs = 10 * 60_000) {
    const start = Date.now();
    for (;;) {
      const pending = noteIds.filter(
        (id) => db.prepare('SELECT status FROM notes WHERE id = ?').get(id)?.status === 'transcribing',
      );
      if (!pending.length || Date.now() - start > timeoutMs) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const said = (note) => note.transcript || note.typed_text || note.live_caption || '';

  function noteForPrompt(note) {
    return {
      said: said(note),
      page: note.route,
      pointed_at: note.pointed ?? undefined,
      attachments: note.attachments.map((a) => ({ name: a.name, path: a.path })),
    };
  }

  // ---------------------------------------------------------------- summarize

  async function showAt(ref, file) {
    const res = await git(project.repo, ['show', `${ref}:${file}`], { allowFail: true });
    return res.code === 0 ? res.stdout : null;
  }

  async function summaryInput(req, notes, previous) {
    const ref = `refs/tags/${req.base_version}`;
    // Projects can describe themselves with scripts/site-map.mjs (route ->
    // component -> content files); without one the summarizer works from the
    // notes alone.
    const siteMapRes = existsSync(join(paths.site, 'scripts', 'site-map.mjs'))
      ? await run('node', ['scripts/site-map.mjs'], { cwd: paths.site })
      : null;
    const siteMap = siteMapRes?.code === 0 ? JSON.parse(siteMapRes.stdout) : { pages: [] };
    const routes = new Set(notes.map((n) => n.route).filter(Boolean));
    const content = {};
    for (const page of siteMap.pages) {
      const matches = [...routes].some((r) => r === page.route || (page.route.includes(':') && r.startsWith(page.route.split('/:')[0] + '/')));
      if (!matches) continue;
      for (const c of page.content) {
        if (c.file && c.file.endsWith('.json')) content[c.file] = JSON.parse((await showAt(ref, c.file)) ?? 'null');
      }
    }
    const siteJson = await showAt(ref, 'src/content/site.json');
    if (siteJson) content['src/content/site.json'] = JSON.parse(siteJson);
    return {
      notes: notes.map(noteForPrompt),
      site_map: siteMap,
      content,
      viewing_version: req.base_version,
      latest_version: req.latest_at_creation,
      ...(previous && {
        // A second pass after the owner answered questions (or edited the list).
        current_checklist: previous.items.map(({ include, ...item }) => ({ ...item, keep: include })),
        answered_questions: previous.questions.filter((q) => q.answer?.trim()).map((q) => ({ question: q.ask, answer: q.answer })),
      }),
    };
  }

  function fallbackSummary(notes) {
    const text = notes.map(said).filter(Boolean).join(' / ');
    return {
      items: [{
        title: 'Owner request (unsummarized)',
        owner_summary: text || '(empty note)',
        route: notes[0]?.route ?? '/',
        targets: [],
        kind: 'other',
        attachments: notes.flatMap((n) => n.attachments.map((a) => a.name)),
        confidence: 'low',
        source_quote: text,
      }],
      questions: [],
      version_bump: 'patch',
      fallback: true,
    };
  }

  async function runSummarizer(id, previous) {
    const req = getRequest(id);
    const notes = notesFor(id);
    await waitForTranscripts(notes.map((n) => n.id));
    const fresh = notesFor(id);
    let summary;
    let cost = 0;
    for (let attempt = 1; attempt <= 2 && !summary; attempt++) {
      try {
        ({ summary, cost } = await summarize(await summaryInput(req, fresh, previous)));
      } catch (err) {
        logEvent(id, 'dev', `summarizer attempt ${attempt} failed: ${err.message}`);
      }
    }
    if (!summary) {
      summary = fallbackSummary(fresh);
      notifyDev(`Request #${pad(id)}: summarizer failed twice, using the raw transcript.`);
    }
    summary.items = summary.items.map((item) => ({ ...item, include: true }));
    summary.questions = summary.questions.map((q) => ({ ...q, answer: '' }));
    // Keep earlier answers for the implementer once their questions are gone.
    if (previous) {
      const answered = previous.questions.filter((q) => q.answer?.trim()).map((q) => ({ question: q.ask, answer: q.answer }));
      summary.answered = [...(previous.answered ?? []), ...answered];
    }
    setStatus(id, 'awaiting_review', { summary, cost_usd: req.cost_usd + cost });
  }

  /** Turn the draft notes (or the given ones) into a request and summarize them. */
  function createRequest(noteIds) {
    const ids = noteIds?.length ? noteIds : draftNotes().map((n) => n.id);
    if (!ids.length) throw httpError(400, 'Record or type a note first.');
    const live = getSetting('live_version');
    const latest = getSetting('latest_version');
    const ts = now();
    const { lastInsertRowid } = db
      .prepare('INSERT INTO requests (status, created_at, updated_at, base_version, latest_at_creation) VALUES (?, ?, ?, ?, ?)')
      .run('summarizing', ts, ts, live, latest);
    const id = Number(lastInsertRowid);
    const mark = db.prepare('UPDATE notes SET request_id = ? WHERE id = ? AND request_id IS NULL');
    for (const noteId of ids) mark.run(id, noteId);
    logEvent(id, 'status', 'summarizing');
    changed();
    runSummarizer(id).catch((err) => {
      setStatus(id, 'failed', { error: err.message });
      notifyDev(`Request #${pad(id)} failed while summarizing: ${err.message}`);
    });
    return id;
  }

  /** Owner edits to the checklist and answers to questions. */
  function reviseRequest(id, { items, questions }) {
    const req = mustGet(id);
    const summary = { ...req.summary };
    if (Array.isArray(items)) {
      summary.items = summary.items.map((item, i) => ({
        ...item,
        include: items[i]?.include ?? item.include,
        owner_summary: (items[i]?.owner_summary ?? item.owner_summary).trim() || item.owner_summary,
      }));
    }
    if (Array.isArray(questions)) {
      summary.questions = summary.questions.map((q, i) => ({ ...q, answer: questions[i]?.answer ?? q.answer }));
    }
    updateRequest(id, { summary });
    changed();
  }

  // ---------------------------------------------------------------- implement

  function implementerMessage(req, notes) {
    const items = req.summary.items.filter((i) => i.include);
    return [
      `Implement ${project.name} live-edit request #${pad(req.id)} for ${project.ownerName}.`,
      `Photos she attached are under ${paths.uploads}.`,
      '',
      '```json',
      JSON.stringify(
        {
          request_id: pad(req.id),
          owner: project.ownerName,
          builds_on_version: req.base_version,
          items: items.map((item, i) => ({
            item: i + 1,
            title: item.title,
            owner_summary: item.owner_summary,
            source_quote: item.source_quote,
            route: item.route,
            targets: item.targets,
            kind: item.kind,
            attachments: item.attachments,
          })),
          answers: [
            ...(req.summary.answered ?? []),
            ...req.summary.questions.filter((q) => q.answer).map((q) => ({ question: q.ask, answer: q.answer })),
          ],
          notes: notes.map(noteForPrompt),
        },
        null,
        2,
      ),
      '```',
    ].join('\n');
  }

  function followupMessage(req, text, notes) {
    return [
      `${project.ownerName} looked at the preview of request #${pad(req.id)} and says:`,
      '',
      `> ${text.replace(/\n/g, '\n> ')}`,
      '',
      notes.length ? `Context from her notes:\n\`\`\`json\n${JSON.stringify(notes.map(noteForPrompt), null, 2)}\n\`\`\`` : '',
      'Adjust the change accordingly (same commit format), run the build, and give the full report again for every item.',
      '',
      // Resumed sessions lean on their own history; restate the ground rules
      // right next to the new instruction.
      `Reminder: photos are handled with \`node ${ADD_IMAGE}\` (\`--info\`, \`--crop left,top,width,height\`, \`--aspect W:H --position …\`), run from the worktree. Commands outside your allowed tools are refused, so don't retry them in other forms; use the tools you have.`,
    ].join('\n');
  }

  async function ensureWorktree(req) {
    if (req.worktree && existsSync(req.worktree)) {
      linkDeps(req.worktree);
      return req;
    }
    const slug = (req.summary.items.find((i) => i.include)?.title ?? 'change')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'change';
    const branch = req.branch ?? `edit/${pad(req.id)}-${slug}`;
    const worktree = join(paths.worktrees, pad(req.id));
    const exists = (await git(project.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })).code === 0;
    await git(project.repo, exists ? ['worktree', 'add', worktree, branch] : ['worktree', 'add', '-b', branch, worktree, `refs/tags/${req.base_version}`]);
    // Dependencies before Claude starts, so its own `npm run build` works.
    await ensureDeps(worktree);
    linkDeps(worktree);
    return updateRequest(req.id, { branch, worktree });
  }

  async function commitLeftovers(req) {
    const dirty = await git(req.worktree, ['status', '--porcelain']);
    if (!dirty) return;
    await git(req.worktree, ['add', '-A']);
    await git(req.worktree, ['commit', '-m', `Live edit #${pad(req.id)}: remaining changes\n\nLive-Edit-Request: ${pad(req.id)}`]);
  }

  const throttle = (fn, ms) => {
    let last = '';
    let at = 0;
    return (line) => {
      if (line === last && Date.now() - at < ms) return;
      last = line;
      at = Date.now();
      fn(line);
    };
  };

  /** Lane A job: first implementation, a follow-up, or a resume after restart. */
  async function implementJob(id, { followup, resumeAfterRestart } = {}) {
    let req = mustGet(id);
    req = await ensureWorktree(req);
    setStatus(id, 'implementing', { error: null });

    const resume = Boolean(req.session_id);
    const sessionId = req.session_id ?? randomUUID();

    const notes = notesFor(id);
    const message = resumeAfterRestart
      ? 'You were interrupted. Check `git status` and `git log`, finish any remaining items, run the build, and give the full report.'
      : followup
        ? followupMessage(req, followup.text, followup.notes)
        : implementerMessage(req, notes);

    const progress = throttle((line) => logEvent(id, 'progress', line), 1500);
    let result = await implement({ cwd: req.worktree, sessionId, resume, message, addDirs: [paths.uploads], onProgress: progress });
    let cost = result.cost;
    // Only remember the session once Claude has actually created it: an id
    // saved before a crash would make every retry try to --resume a session
    // that doesn't exist.
    if (!resume && result.ran) updateRequest(id, { session_id: sessionId });

    if (!result.ok) {
      req = updateRequest(id, { cost_usd: req.cost_usd + cost });
      return fail(id, `The change didn't finish (${result.error ?? 'unknown error'}).`);
    }
    await commitLeftovers(mustGet(id));

    setStatus(id, 'building');
    let built = await build(req.worktree, join(paths.previews, `req-${id}`));
    // Permission, disk and output-folder problems are the server's, not the
    // code's: don't send Claude off to "fix" them.
    const environmental = (log) => /EACCES|EPERM|ENOSPC|EROFS|prepare-out-dir/.test(log);
    if (!built.ok && !environmental(built.log)) {
      logEvent(id, 'progress', 'Fixing a build problem…');
      const retry = await implement({
        cwd: req.worktree, sessionId, resume: true, addDirs: [paths.uploads], onProgress: progress,
        message: `The production build fails. Fix it (same commit format) and report again.\n\n\`\`\`\n${built.log}\n\`\`\``,
      });
      cost += retry.cost;
      if (retry.ok) result = retry;
      await commitLeftovers(mustGet(id));
      built = await build(req.worktree, join(paths.previews, `req-${id}`));
    }
    req = updateRequest(id, { cost_usd: mustGet(id).cost_usd + cost, report: result.report });
    if (!built.ok) {
      return fail(id, environmental(built.log)
        ? `The server couldn't build the preview (a problem on the server, not with the change).\n${built.log}`
        : `The site wouldn't build after the change.\n${built.log}`);
    }

    const commits = Number(await git(req.worktree, ['rev-list', '--count', `refs/tags/${req.base_version}..HEAD`]));
    const needs = (result.report?.items ?? []).filter((i) => i.status === 'needs_clarification');
    if (commits === 0) {
      if (needs.length) return setStatus(id, 'needs_answers');
      return fail(id, 'Nothing was changed.');
    }
    setStatus(id, 'ready_for_preview');
  }

  function fail(id, error) {
    setStatus(id, 'failed', { error });
    notifyDev(`Request #${pad(id)} failed: ${error.split('\n')[0]}`);
  }

  function submitRequest(id) {
    const req = mustGet(id);
    if (req.status !== 'awaiting_review') throw httpError(409, `Request is ${req.status}.`);
    const { items, questions } = req.summary;
    const answeredOpen = questions.some((q) => q.item === null && q.answer?.trim());
    if (!items.some((i) => i.include) || answeredOpen) {
      // Her answers can turn into new checklist items: rethink the list first,
      // keeping what she's already edited, and bring it back for review.
      if (!answeredOpen && !questions.some((q) => q.answer?.trim())) throw httpError(400, 'Tick a change or answer the question first.');
      setStatus(id, 'summarizing');
      runSummarizer(id, req.summary).catch((err) => fail(id, err.message));
      return { rethinking: true };
    }
    setStatus(id, 'queued');
    implementLane.push(`implement #${id}`, () => implementJob(id).catch((err) => fail(id, err.message)));
  }

  /** "Not quite", or answers to the implementer's questions. */
  async function followupRequest(id, { text = '', noteIds = [] }) {
    const req = mustGet(id);
    if (!['ready_for_preview', 'needs_answers', 'failed'].includes(req.status)) throw httpError(409, `Request is ${req.status}.`);
    const mark = db.prepare('UPDATE notes SET request_id = ? WHERE id = ? AND request_id IS NULL');
    for (const noteId of noteIds) mark.run(id, noteId);
    setStatus(id, 'queued');
    implementLane.push(`followup #${id}`, async () => {
      try {
        await waitForTranscripts(noteIds);
        const notes = noteIds.map((n) => parseRow('notes', db.prepare('SELECT * FROM notes WHERE id = ?').get(n))).filter(Boolean);
        const combined = [text, ...notes.map(said)].filter(Boolean).join('\n');
        if (!mustGet(id).session_id) return await implementJob(id);
        await implementJob(id, { followup: { text: combined || 'Please try again.', notes } });
      } catch (err) {
        fail(id, err.message);
      }
    });
  }

  // ---------------------------------------------------------------- publish

  function changelogEntry(tag, lines) {
    const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    return `## ${tag} — ${date}\n${lines.map((l) => `- ${l}`).join('\n')}\n`;
  }

  function writeVersionFiles(dir, tag, lines) {
    const version = tag.slice(1);
    const pkgPath = join(dir, 'package.json');
    const pkg = readFileSync(pkgPath, 'utf8');
    writeFileSync(pkgPath, pkg.replace(/"version": "[^"]+"/, `"version": "${version}"`)); // first = top-level
    const lockPath = join(dir, 'package-lock.json');
    if (existsSync(lockPath)) {
      // The lockfile repeats the root version at the top and under packages[""].
      const name = JSON.parse(pkg).name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const lock = readFileSync(lockPath, 'utf8').replace(new RegExp(`("name": "${name}",\\s*"version": ")[^"]+`, 'g'), `$1${version}`);
      writeFileSync(lockPath, lock);
    }
    const clPath = join(dir, 'CHANGELOG.md');
    const cl = existsSync(clPath) ? readFileSync(clPath, 'utf8') : '# Changes to the website\n\n';
    const at = cl.indexOf('\n## ');
    const entry = changelogEntry(tag, lines);
    writeFileSync(clPath, at >= 0 ? `${cl.slice(0, at + 1)}${entry}\n${cl.slice(at + 1)}` : `${cl.trimEnd()}\n\n${entry}`);
  }

  async function bringUpToDate(req, latest) {
    logEvent(req.id, 'progress', 'Combining with the latest published changes…');
    const merge = await git(req.worktree, ['merge', '--no-edit', `refs/tags/${latest}`], { allowFail: true });
    if (merge.code !== 0) {
      const resolved = await implement({
        cwd: req.worktree, sessionId: req.session_id, resume: true, role: 'resolver', addDirs: [paths.uploads],
        message: `Merging ${latest} into this request's branch hit conflicts. Resolve them and complete the merge.`,
        onProgress: (line) => logEvent(req.id, 'progress', line),
      });
      updateRequest(req.id, { cost_usd: mustGet(req.id).cost_usd + resolved.cost });
      const conflicted = await git(req.worktree, ['diff', '--name-only', '--diff-filter=U']);
      const merging = existsSync(join(await git(req.worktree, ['rev-parse', '--git-dir']), 'MERGE_HEAD'));
      if (!resolved.ok || conflicted || merging) {
        await git(req.worktree, ['merge', '--abort'], { allowFail: true });
        throw new Error(`couldn't combine with ${latest} automatically`);
      }
    }
    const built = await build(req.worktree, join(paths.previews, `req-${req.id}`));
    if (!built.ok) throw new Error(`build failed after combining with ${latest}:\n${built.log}`);
  }

  async function publishJob(id) {
    let req = mustGet(id);
    if (req.status !== 'ready_for_preview') throw httpError(409, `Request is ${req.status}.`);
    setStatus(id, 'publishing');
    const site = paths.site;
    const latest = getSetting('latest_version');
    const headBefore = await git(site, ['rev-parse', 'HEAD']);
    let restored = false;
    let newTag = null;

    try {
      if (latest !== req.latest_at_creation) {
        // Other versions were published while this waited: keep them (§3.3).
        await bringUpToDate(req, latest);
      } else if (req.base_version !== latest) {
        // the owner went back to an older version and changed that (§3.3).
        await git(site, ['read-tree', '-u', '--reset', `refs/tags/${req.base_version}`]);
        await git(site, ['commit', '--allow-empty', '-m', `Restore ${req.base_version}\n\nLive-Edit-Restore: ${req.base_version}\nLive-Edit-Request: ${pad(id)}`]);
        restored = true;
      }

      const items = req.summary.items.filter((i) => i.include);
      const reportFor = (n) => req.report?.items?.find((r) => r.item === n);
      // The implementer's final notes describe what actually shipped (after any
      // "not quite" rounds); the approved checklist wording is the fallback.
      const lines = items
        .map((item, i) => ({ item, r: reportFor(i + 1) }))
        .filter(({ r }) => !r || r.status === 'done')
        .map(({ item, r }) => r?.note?.trim() || item.owner_summary);
      if (!lines.length) lines.push(`Changes from request #${pad(id)}`);

      const maxTag = listVersions().at(-1).tag;
      newTag = bumpVersion(maxTag, req.summary.version_bump);
      const title = items[0]?.title ?? `request #${pad(id)}`;

      const merge = await git(site, ['merge', '--no-ff', '--no-edit', '-m', `Live edit #${pad(id)} → ${newTag}: ${title}\n\nLive-Edit-Request: ${pad(id)}`, req.branch], { allowFail: true });
      if (merge.code !== 0) throw new Error(`merge into ${project.siteBranch} failed: ${merge.stderr || merge.stdout}`);

      const route = items.find((i) => i.route && i.route !== '*')?.route ?? '/';
      logEvent(id, 'progress', 'Getting the new version ready…');
      await cutRelease({ newTag, lines, route, requestId: id, basedOn: req.base_version });
      if (restored) {
        for (const v of listVersions()) {
          if (!v.set_aside_by && compareVersions(v.tag, req.base_version) > 0 && v.tag !== newTag) {
            db.prepare('UPDATE versions SET set_aside_by = ? WHERE tag = ?').run(newTag, v.tag);
          }
        }
      }

      await git(project.repo, ['worktree', 'remove', '--force', req.worktree], { allowFail: true });
      rmSync(join(paths.previews, `req-${id}`), { recursive: true, force: true });
      setStatus(id, 'published', { version: newTag, worktree: null });
      notifyDev(`${project.ownerName} published ${newTag}: ${lines.join('; ')} (git show ${newTag})`);
    } catch (err) {
      // Put the site branch back exactly as it was; nothing went live.
      if (newTag) await git(site, ['tag', '-d', newTag], { allowFail: true });
      await git(site, ['merge', '--abort'], { allowFail: true });
      await git(site, ['reset', '--hard', headBefore], { allowFail: true });
      rmSync(join(paths.releases, newTag ?? '__none__'), { recursive: true, force: true });
      setStatus(id, 'ready_for_preview', { error: `Publishing didn't work: ${err.message}` });
      notifyDev(`Publishing request #${pad(id)} failed: ${err.message.split('\n')[0]}`);
    }
  }

  /**
   * Turn the site worktree's HEAD into a published version: stamp the version
   * and changelog into that commit, tag it, build the release, make it live in
   * both containers, and record it for History. Throws on failure; callers roll
   * the site branch back.
   */
  async function cutRelease({ newTag, lines, route = '/', requestId = null, basedOn, awaitThumbnail = false }) {
    const site = paths.site;
    writeVersionFiles(site, newTag, lines);
    await git(site, ['add', 'package.json', 'package-lock.json', 'CHANGELOG.md']);
    await git(site, ['commit', '--amend', '--no-edit']);
    await git(site, ['tag', '-a', newTag, '-m', `${newTag}\n\n${lines.map((l) => `- ${l}`).join('\n')}`]);

    const out = join(paths.releases, newTag);
    const built = await build(site, out);
    if (!built.ok) throw new Error(`release build failed:\n${built.log}`);
    dedupeAgainstCurrent(out);

    await switchCurrent(newTag);
    setSetting('live_version', newTag);
    setSetting('latest_version', newTag);
    db.prepare('INSERT INTO versions (tag, request_id, based_on, published_at, lines, route) VALUES (?, ?, ?, ?, ?, ?)')
      .run(newTag, requestId, basedOn, now(), JSON.stringify(lines), route);

    // The History thumbnail is a nicety: don't make the owner's Publish wait on it.
    const thumbJob = thumbnail(newTag, route).then((thumb) => {
      if (thumb) db.prepare('UPDATE versions SET thumbnail = ? WHERE tag = ?').run(thumb, newTag);
      changed();
    });
    if (awaitThumbnail) await thumbJob;
  }

  /**
   * Release dev work that has been committed onto the site branch (in the
   * publishing worktree) on top of the latest version — the dev's route to
   * production (LIVE-EDITS.md §3.4), giving it a version the owner can step back from.
   */
  async function releaseSiteHead({ bump = 'minor', lines, route = '/' }) {
    if (!lines?.length) throw new Error('give at least one owner-facing changelog line');
    const site = paths.site;
    const latest = getSetting('latest_version');
    const head = await git(site, ['rev-parse', 'HEAD']);
    const latestCommit = await git(site, ['rev-parse', `refs/tags/${latest}^{commit}`]);
    if (head === latestCommit) throw new Error(`nothing to release: ${project.siteBranch} is still at ${latest}`);
    if ((await git(site, ['merge-base', '--is-ancestor', latestCommit, head], { allowFail: true })).code !== 0) {
      throw new Error(`${project.siteBranch} doesn't build on ${latest}`);
    }
    if (await git(site, ['status', '--porcelain'])) throw new Error('the publishing worktree has uncommitted changes');

    const newTag = bumpVersion(listVersions().at(-1).tag, bump);
    try {
      await cutRelease({ newTag, lines, route, basedOn: latest, awaitThumbnail: true }); // a CLI exits right after
    } catch (err) {
      await git(site, ['tag', '-d', newTag], { allowFail: true });
      await git(site, ['reset', '--hard', head], { allowFail: true });
      rmSync(join(paths.releases, newTag), { recursive: true, force: true });
      throw err;
    }
    notifyDev(`${project.devName} released ${newTag}: ${lines.join('; ')} (git show ${newTag})`);
    return newTag;
  }

  function publishRequest(id) {
    const req = mustGet(id);
    if (req.status !== 'ready_for_preview') throw httpError(409, `Request is ${req.status}.`);
    updateRequest(id, { error: null });
    return publishLane.push(`publish #${id}`, () => publishJob(id));
  }

  function discardRequest(id) {
    const req = mustGet(id);
    if (['implementing', 'building', 'publishing', 'published'].includes(req.status)) throw httpError(409, `Request is ${req.status}.`);
    return publishLane.push(`discard #${id}`, async () => {
      const r = mustGet(id);
      if (r.worktree) await git(project.repo, ['worktree', 'remove', '--force', r.worktree], { allowFail: true });
      if (r.branch) await git(project.repo, ['branch', '-D', r.branch], { allowFail: true });
      rmSync(join(paths.previews, `req-${id}`), { recursive: true, force: true });
      setStatus(id, 'discarded', { worktree: null });
    });
  }

  // ---------------------------------------------------------------- versions

  function switchLive({ version, step }) {
    const versions = listVersions();
    const pick = (live) => {
      if (!step) return version;
      const at = versions.findIndex((v) => v.tag === live);
      return versions[at + Math.sign(step)]?.tag;
    };
    const target = pick(getSetting('live_version'));
    if (!target || !versions.some((v) => v.tag === target)) throw httpError(400, step ? 'There is no version that way.' : 'No such version.');

    return publishLane.push('switch', async () => {
      const live = getSetting('live_version');
      if (target === live) return;
      await switchCurrent(target);
      setSetting('live_version', target);
      notifyDev(`${project.ownerName} switched the live site from ${live} to ${target}.`);
    });
  }

  // ---------------------------------------------------------------- startup

  /** Pick up whatever a restart interrupted (LIVE-EDITS.md §7). */
  async function recover() {
    const site = paths.site;
    for (const req of db.prepare("SELECT id, status, session_id FROM requests WHERE status IN ('summarizing','queued','implementing','building','publishing')").all()) {
      if (req.status === 'summarizing') {
        runSummarizer(req.id).catch((err) => fail(req.id, err.message));
      } else if (req.status === 'publishing') {
        const latest = getSetting('latest_version');
        await git(site, ['merge', '--abort'], { allowFail: true });
        await git(site, ['reset', '--hard', `refs/tags/${latest}`], { allowFail: true });
        setStatus(req.id, 'ready_for_preview', { error: 'Publishing was interrupted; please press Publish again.' });
      } else {
        setStatus(req.id, 'queued');
        implementLane.push(`resume #${req.id}`, () =>
          implementJob(req.id, { resumeAfterRestart: Boolean(req.session_id) }).catch((err) => fail(req.id, err.message)),
        );
      }
    }
  }

  // ---------------------------------------------------------------- helpers

  function mustGet(id) {
    const req = getRequest(id);
    if (!req) throw httpError(404, 'No such request.');
    return req;
  }

  return {
    implementLane, publishLane, draftNotes, createRequest, reviseRequest, submitRequest, followupRequest,
    publishRequest, discardRequest, switchLive, releaseSiteHead, recover,
  };
}

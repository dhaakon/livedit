#!/usr/bin/env node
// Live-edits daemon. Serves every project in the daemon config
// (~/.config/live-edits/daemon.json):
//   /p/<project>/…  any project, by id
//   /…              the default project — the URLs a hosted preview's nginx
//                   proxies /_live-edits/ to, so existing sites keep working.
// Each project has its own token, store, event stream and job lanes.
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { createReadStream, existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { BAR_DIST, loadConfig } from './lib/config.mjs';
import { now, parseRow } from './lib/store.mjs';
import { transcribe } from './lib/transcribe.mjs';
import { openProject } from './lib/project.mjs';
import { httpError } from './lib/workflow.mjs';

const config = loadConfig();
const { daemon } = config;

const projects = new Map();
for (const [id, projectConfig] of config.projects) {
  const p = openProject(projectConfig, daemon);
  // A release-landing project needs a first version (bin/init-site.mjs) before
  // it can take requests; don't let one unready project stop the others.
  p.ready = projectConfig.landing !== 'release' || Boolean(p.store.getSetting('live_version'));
  if (!p.ready) console.error(`[${id}] no live version yet: run \`node bin/init-site.mjs --project ${id}\``);
  projects.set(id, p);
}

const app = Fastify({ logger: { level: 'info' }, bodyLimit: 2 * 1024 * 1024 });
await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024, files: 12 } });

app.setErrorHandler((err, req, reply) => {
  const code = err.statusCode ?? 500;
  if (code >= 500) req.log.error(err);
  reply.code(code).send({ error: err.message });
});

/** Liveness and which projects this daemon serves (no paths or secrets). */
app.get('/healthz', () => ({
  ok: true,
  default: config.defaultProject,
  projects: [...projects.values()].map((p) => ({ id: p.config.id, name: p.config.name, landing: p.config.landing, ready: p.ready })),
}));

const STATUS_VISIBLE_DAYS = 3;
const safeName = (name) => basename(name || 'file').replace(/[^\w.-]+/g, '_').slice(-80);

/** Every per-project route. Registered for the default project and under /p/:project. */
async function projectRoutes(app, { resolveProject }) {
  app.decorateRequest('project', null);

  app.addHook('onRequest', async (req, reply) => {
    const project = resolveProject(req);
    if (!project) return reply.code(404).send({ error: 'No such project.' });
    req.project = project;
    if (!req.routeOptions.url?.includes('/api/')) return undefined;
    // One token per project (LIVE-EDITS.md §6). The bar learns it from ?edit=<token>.
    const { token } = project.config;
    const given = req.headers['x-live-edits-token'] ?? new URL(req.url, 'http://x').searchParams.get('token');
    if (token && given !== token) return reply.code(401).send({ error: 'Enter the access code to make changes.' });
    if (!project.ready) return reply.code(503).send({ error: 'This project has no published version yet.' });
    return undefined;
  });

  // ------------------------------------------------------------ static bits

  app.get('/bar.js', (req, reply) => {
    const file = join(BAR_DIST, 'bar.js');
    if (!existsSync(file)) return reply.code(404).type('application/javascript').send('/* edit bar not built */');
    return reply.header('Cache-Control', 'no-cache').type('application/javascript').send(createReadStream(file));
  });

  app.get('/thumbs/:file', (req, reply) => {
    const file = join(req.project.config.paths.thumbs, basename(req.params.file));
    if (!existsSync(file)) return reply.code(404).send();
    return reply.type('image/png').send(createReadStream(file));
  });

  app.get('/audio/:file', (req, reply) => {
    const file = join(req.project.config.paths.audio, basename(req.params.file));
    if (!existsSync(file)) return reply.code(404).send();
    return reply.type(extname(file) === '.mp4' ? 'audio/mp4' : 'audio/webm').send(createReadStream(file));
  });

  /** Choose what the preview host serves for this browser: the live release, a
   * past version, or a pending request's preview (a cookie read by nginx). */
  app.get('/view', (req, reply) => {
    const { paths } = req.project.config;
    const { target = 'live', path = '/', nobar } = req.query;
    const safePath = typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') ? path : '/';
    const cookies = [];
    if (target === 'live') {
      cookies.push('le_view=; Path=/; Max-Age=0; SameSite=Lax');
    } else if (/^v\d+\.\d+\.\d+$/.test(target) ? req.project.releases.releaseExists(target) : /^req-\d+$/.test(target) && existsSync(join(paths.previews, target, 'index.html'))) {
      cookies.push(`le_view=${target}; Path=/; SameSite=Lax`);
    } else {
      throw httpError(404, 'That version is not available.');
    }
    if (nobar) cookies.push('le_nobar=1; Path=/; SameSite=Lax');
    return reply.header('Set-Cookie', cookies).header('Cache-Control', 'no-store').redirect(safePath);
  });

  // ------------------------------------------------------------ state

  function state(project) {
    const { store, workflow, config: cfg } = project;
    const versions = store.listVersions().map((v) => ({
      tag: v.tag,
      date: v.published_at,
      lines: v.lines,
      route: v.route,
      based_on: v.based_on,
      set_aside_by: v.set_aside_by,
      thumbnail: v.thumbnail ? `thumbs/${v.thumbnail}` : null,
    }));
    const notes = workflow.draftNotes().map(publicNote);
    const since = new Date(Date.now() - STATUS_VISIBLE_DAYS * 86_400_000).toISOString();
    const requests = store.db
      .prepare("SELECT * FROM requests WHERE status != 'discarded' AND (status != 'published' OR updated_at > ?) ORDER BY id DESC LIMIT 20")
      .all(since)
      .map((r) => parseRow('requests', r))
      .map((r) => ({
        id: r.id,
        status: r.status,
        created_at: r.created_at,
        base_version: r.base_version,
        latest_at_creation: r.latest_at_creation,
        summary: r.summary,
        report: r.report,
        version: r.version,
        error: r.error,
        has_preview: existsSync(join(cfg.paths.previews, `req-${r.id}`, 'index.html')),
        progress: store.db
          .prepare("SELECT message FROM events WHERE request_id = ? AND kind = 'progress' ORDER BY id DESC LIMIT 5")
          .all(r.id)
          .map((e) => e.message)
          .reverse(),
      }));
    return {
      project: cfg.id,
      name: cfg.name,
      owner: cfg.ownerName,
      dev: cfg.devName,
      live: store.getSetting('live_version'),
      latest: store.getSetting('latest_version'),
      versions,
      notes,
      requests,
      working: workflow.implementLane.busy,
    };
  }

  function publicNote(n) {
    return {
      id: n.id,
      created_at: n.created_at,
      route: n.route,
      status: n.status,
      said: n.transcript || n.typed_text || n.live_caption || '',
      audio: n.audio_path ? `audio/${basename(n.audio_path)}` : null,
      pointed: n.pointed ? { edit_id: n.pointed.edit_id, text: n.pointed.text?.slice(0, 80) } : null,
      attachments: n.attachments.map((a) => a.name),
    };
  }

  app.get('/api/state', (req) => state(req.project));

  app.get('/api/events', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write('data: {"type":"hello"}\n\n');
    const remove = req.project.events.addClient(reply);
    req.raw.on('close', remove);
    return reply; // keep the stream open
  });

  app.get('/api/requests/:id/events', (req) =>
    req.project.store.db.prepare('SELECT at, kind, message FROM events WHERE request_id = ? ORDER BY id').all(Number(req.params.id)),
  );

  // ------------------------------------------------------------ notes

  app.post('/api/notes', async (req) => {
    const { store, events, config: cfg } = req.project;
    const { db } = store;
    const fields = {};
    const files = [];
    for await (const part of req.parts()) {
      if (part.type === 'file') files.push({ field: part.fieldname, name: part.filename, mime: part.mimetype, data: await part.toBuffer() });
      else fields[part.fieldname] = part.value;
    }
    const audio = files.find((f) => f.field === 'audio' && f.data.length > 0);
    const typed = (fields.typed ?? '').trim();
    if (!audio && !typed && !files.some((f) => f.field === 'attachments')) throw httpError(400, 'That note was empty.');

    let pointed = null;
    try {
      pointed = fields.pointed ? JSON.parse(fields.pointed) : null;
    } catch {
      pointed = null;
    }

    const { lastInsertRowid } = db
      .prepare('INSERT INTO notes (created_at, route, status, live_caption, typed_text, pointed) VALUES (?, ?, ?, ?, ?, ?)')
      .run(now(), fields.route ?? '/', audio ? 'transcribing' : 'ready', fields.caption ?? null, typed || null, pointed ? JSON.stringify(pointed) : null);
    const id = Number(lastInsertRowid);

    const attachments = [];
    for (const f of files.filter((f) => f.field === 'attachments')) {
      const path = join(cfg.paths.uploads, `${id}-${safeName(f.name)}`);
      await writeFile(path, f.data);
      attachments.push({ name: safeName(f.name), path });
    }
    let audioPath = null;
    if (audio) {
      audioPath = join(cfg.paths.audio, `${id}${/mp4|aac|m4a/.test(audio.mime) ? '.mp4' : '.webm'}`);
      await writeFile(audioPath, audio.data);
    }
    db.prepare('UPDATE notes SET attachments = ?, audio_path = ? WHERE id = ?').run(JSON.stringify(attachments), audioPath, id);
    events.changed();

    if (audioPath) {
      transcribe(audioPath, daemon.whisperUrl)
        .then((text) => db.prepare('UPDATE notes SET transcript = ?, status = ? WHERE id = ?').run(text, text ? 'ready' : 'failed', id))
        .catch((err) => {
          req.log.error(err, 'transcription failed');
          const fallback = fields.caption?.trim();
          db.prepare('UPDATE notes SET status = ?, transcript = ? WHERE id = ?').run(fallback ? 'ready' : 'failed', fallback || null, id);
        })
        .finally(events.changed);
    }
    return { id };
  });

  app.delete('/api/notes/:id', async (req) => {
    req.project.store.db.prepare('DELETE FROM notes WHERE id = ? AND request_id IS NULL').run(Number(req.params.id));
    req.project.events.changed();
    return { ok: true };
  });

  // ------------------------------------------------------------ requests

  app.post('/api/requests', async (req) => ({ id: req.project.workflow.createRequest(req.body?.noteIds) }));
  app.patch('/api/requests/:id', async (req) => {
    req.project.workflow.reviseRequest(Number(req.params.id), req.body ?? {});
    return { ok: true };
  });
  app.post('/api/requests/:id/submit', async (req) => ({ ok: true, ...req.project.workflow.submitRequest(Number(req.params.id)) }));
  app.post('/api/requests/:id/followup', async (req) => {
    await req.project.workflow.followupRequest(Number(req.params.id), req.body ?? {});
    return { ok: true };
  });
  app.post('/api/requests/:id/publish', async (req) => {
    req.project.workflow.publishRequest(Number(req.params.id));
    return { ok: true };
  });
  app.post('/api/requests/:id/discard', async (req) => {
    req.project.workflow.discardRequest(Number(req.params.id));
    return { ok: true };
  });

  app.post('/api/live', async (req) => {
    await req.project.workflow.switchLive(req.body ?? {});
    return { ok: true, live: req.project.store.getSetting('live_version') };
  });
}

await app.register(projectRoutes, { resolveProject: () => projects.get(config.defaultProject) });
await app.register(projectRoutes, { prefix: '/p/:project', resolveProject: (req) => projects.get(req.params.project) });

for (const p of projects.values()) if (p.ready) await p.workflow.recover();
await app.listen({ host: daemon.host, port: daemon.port });

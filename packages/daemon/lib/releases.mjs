import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, linkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { git, run } from './run.mjs';

/**
 * The release landing adapter (LIVE-EDITS.md §3.2): shared deps, builds,
 * release folders behind a `current` symlink, thumbnails. One per project.
 */
export function createReleases(project, daemon) {
  const { paths } = project;

  return { ensureDeps, linkDeps, build, dedupeAgainstCurrent, releaseExists, currentRelease, switchCurrent, rebuildRelease, thumbnail };

  /** One shared node_modules for every build worktree, installed from the site
   * branch's lockfile. Reinstalled only when the lockfile changes. */
  async function ensureDeps(fromDir) {
    mkdirSync(paths.deps, { recursive: true });
    const stamp = createHash('sha1').update(dependencyFingerprint(fromDir)).digest('hex');
    const stampFile = join(paths.deps, '.lock-sha1');
    if (existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp && existsSync(join(paths.deps, 'node_modules'))) return;

    for (const f of ['package.json', 'package-lock.json', '.npmrc']) {
      if (existsSync(join(fromDir, f))) copyFileSync(join(fromDir, f), join(paths.deps, f));
    }
    // vite and friends are devDependencies; always install them, whatever
    // NODE_ENV the server happens to run with.
    const res = await run('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], {
      cwd: paths.deps,
      env: { NODE_ENV: 'development' },
      timeoutMs: 15 * 60_000,
    });
    if (res.code !== 0) throw new Error(`npm ci failed: ${res.stderr.slice(-2000)}`);
    writeFileSync(stampFile, stamp);
  }

  /** What the shared install depends on: the lockfile minus the site's own
   * version number, which every publish bumps without changing any packages. */
  function dependencyFingerprint(dir) {
    const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
    delete lock.version;
    if (lock.packages?.['']) delete lock.packages[''].version;
    return JSON.stringify(lock);
  }

  /** Point a worktree's node_modules at the shared install. */
  function linkDeps(worktree) {
    const target = join(worktree, 'node_modules');
    if (!existsSync(target)) symlinkSync(join(paths.deps, 'node_modules'), target, 'dir');
  }

  /** vite build of a worktree into outDir. Returns { ok, log }. */
  async function build(worktree, outDir) {
    await ensureDeps(worktree);
    linkDeps(worktree);
    const res = await run(join(paths.deps, 'node_modules', '.bin', 'vite'), ['build', '--outDir', outDir, '--emptyOutDir'], {
      cwd: worktree,
      timeoutMs: 10 * 60_000,
    });
    return { ok: res.code === 0, log: (res.stdout + res.stderr).slice(-6000) };
  }

  function sha1(file) {
    return createHash('sha1').update(readFileSync(file)).digest('hex');
  }

  function* walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(full);
      else if (entry.isFile()) yield full;
    }
  }

  /** Replace files identical to the current release with hard links, so
   * unchanged photos cost no disk (LIVE-EDITS.md §3.2). */
  function dedupeAgainstCurrent(releaseDir) {
    const current = join(paths.releases, 'current');
    if (!existsSync(current)) return 0;
    let saved = 0;
    for (const file of walk(releaseDir)) {
      const rel = relative(releaseDir, file);
      const prev = join(current, rel);
      if (!existsSync(prev)) continue;
      const a = statSync(file);
      const b = statSync(prev);
      if (a.size !== b.size || a.ino === b.ino || a.size < 4096) continue;
      if (sha1(file) !== sha1(prev)) continue;
      unlinkSync(file);
      linkSync(prev, file);
      saved += a.size;
    }
    return saved;
  }

  function releaseExists(tag) {
    return existsSync(join(paths.releases, tag, 'index.html'));
  }

  function currentRelease() {
    const link = join(paths.releases, 'current');
    return existsSync(link) && lstatSync(link).isSymbolicLink() ? readlinkSync(link) : null;
  }

  /** Atomically point releases/current (served by both nginx containers) at a
   * release, and mirror it to the git ref the dev can inspect. */
  async function switchCurrent(tag) {
    if (!releaseExists(tag)) await rebuildRelease(tag);
    const tmp = join(paths.releases, `.current-${process.pid}-${Date.now()}`);
    symlinkSync(tag, tmp); // relative, so it resolves inside the containers too
    renameSync(tmp, join(paths.releases, 'current'));
    await git(project.repo, ['update-ref', project.liveRef, `refs/tags/${tag}`]);
  }

  /** Build any tagged version from scratch into releases/<tag>. */
  async function rebuildRelease(tag) {
    const tmp = join(paths.tmp, `release-${tag}`);
    await git(project.repo, ['worktree', 'remove', '--force', tmp], { allowFail: true });
    rmSync(tmp, { recursive: true, force: true });
    await git(project.repo, ['worktree', 'add', '--detach', tmp, `refs/tags/${tag}`]);
    try {
      const out = join(paths.releases, tag);
      const res = await build(tmp, out);
      if (!res.ok) throw new Error(`build of ${tag} failed:\n${res.log}`);
      dedupeAgainstCurrent(out);
    } finally {
      await git(project.repo, ['worktree', 'remove', '--force', tmp], { allowFail: true });
    }
  }

  /** Small screenshot of a version's page for the History panel. Best effort. */
  async function thumbnail(tag, route = '/') {
    mkdirSync(paths.thumbs, { recursive: true });
    const out = join(paths.thumbs, `${tag}.png`);
    if (!project.previewSiteUrl) return null;
    const url = `${project.previewSiteUrl}/_live-edits/view?target=${encodeURIComponent(tag)}&path=${encodeURIComponent(route || '/')}&nobar=1`;
    // Only screenshot if the preview host is up and knows this version.
    const probe = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (probe?.status !== 302) return null;
    const res = await run(
      daemon.chrome,
      [
        '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
        '--window-size=1280,800', '--force-device-scale-factor=0.4', '--virtual-time-budget=6000',
        `--user-data-dir=${join(paths.tmp, 'chrome')}`,
        `--screenshot=${out}`, url,
      ],
      { timeoutMs: 60_000 },
    );
    return res.code === 0 && existsSync(out) ? `${tag}.png` : null;
  }
}

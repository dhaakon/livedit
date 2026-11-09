// One-time (idempotent) setup of the live-edits system (LIVE-EDITS.md §8,
// phase 0): creates the `site` branch and v1.0.0 tag, the publishing
// worktree, the shared node_modules, the v1.0.0 release, and points
// releases/current at it.
//
//   node bin/init-site.mjs [--project <id>] [--from <ref>]   (default ref: HEAD of the project's checkout)
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, projectFromArgs } from '../lib/config.mjs';
import { now } from '../lib/store.mjs';
import { git } from '../lib/run.mjs';
import { openProject } from '../lib/project.mjs';

const daemonConfig = loadConfig();
const config = projectFromArgs(daemonConfig);
const { store, releases } = openProject(config, daemonConfig.daemon);
const { db, getSetting, setSetting } = store;
const { build, currentRelease, releaseExists, switchCurrent, thumbnail } = releases;

const fromArg = process.argv.indexOf('--from');
const from = fromArg > 0 ? process.argv[fromArg + 1] : 'HEAD';
const { paths, siteBranch } = config;
const FIRST = 'v1.0.0';

// openProject() above has already created every data folder, as this user,
// before docker compose mounts them; otherwise Docker creates missing mount
// sources owned by root.

const hasRef = async (ref) => (await git(config.repo, ['rev-parse', '--verify', '--quiet', ref], { allowFail: true })).code === 0;

if (!(await hasRef(`refs/heads/${siteBranch}`))) {
  await git(config.repo, ['branch', siteBranch, from]);
  console.log(`created branch ${siteBranch} at ${from}`);
}

const changelog = (ref) => git(config.repo, ['show', `${ref}:CHANGELOG.md`], { allowFail: true });
const firstLines = async () => {
  const res = await changelog(siteBranch);
  const block = res.code === 0 ? res.stdout.split('\n## ')[1] ?? '' : '';
  const lines = block.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
  return lines.length ? lines : ['The redesigned website'];
};

if (!(await hasRef(`refs/tags/${FIRST}`))) {
  const lines = await firstLines();
  await git(config.repo, ['tag', '-a', FIRST, siteBranch, '-m', `${FIRST}\n\n${lines.map((l) => `- ${l}`).join('\n')}`]);
  console.log(`tagged ${FIRST}`);
}

if (!existsSync(join(paths.site, '.git'))) {
  if (existsSync(paths.site) && readdirSync(paths.site).length === 0) rmSync(paths.site, { recursive: true });
  await git(config.repo, ['worktree', 'add', paths.site, siteBranch]);
  console.log(`publishing worktree at ${paths.site}`);
}

if (!releaseExists(FIRST)) {
  console.log(`building ${FIRST}…`);
  const res = await build(paths.site, join(paths.releases, FIRST));
  if (!res.ok) {
    console.error(res.log);
    process.exit(1);
  }
}

if (!currentRelease()) await switchCurrent(FIRST);

if (!db.prepare('SELECT 1 FROM versions WHERE tag = ?').get(FIRST)) {
  db.prepare('INSERT INTO versions (tag, published_at, lines, route) VALUES (?, ?, ?, ?)').run(FIRST, now(), JSON.stringify(await firstLines()), '/');
}
if (!getSetting('live_version')) setSetting('live_version', currentRelease() ?? FIRST);
if (!getSetting('latest_version')) setSetting('latest_version', FIRST);

const thumb = await thumbnail(FIRST, '/');
if (thumb) db.prepare('UPDATE versions SET thumbnail = ? WHERE tag = ?').run(thumb, FIRST);
console.log(`ready: live ${getSetting('live_version')}, latest ${getSetting('latest_version')}${thumb ? '' : ' (no thumbnail yet: is the preview container up?)'}`);
process.exit(0);

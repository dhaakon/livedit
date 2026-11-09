// Daemon and project configuration.
//
// The daemon reads one JSON file (default ~/.config/live-edits/daemon.json,
// or $LIVE_EDITS_CONFIG) listing the projects it serves. Each project's
// secrets and overrides live in that project's own (gitignored) env file —
// parsed per project, never loaded into process.env, so two projects can't
// see each other's tokens.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/** This package (packages/daemon): prompts, schemas and bin tools live here. */
export const DAEMON_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The built edit bar (packages/bar/dist). */
export const BAR_DIST = resolve(DAEMON_DIR, '..', 'bar', 'dist');

export const CONFIG_PATH = resolve(
  process.env.LIVE_EDITS_CONFIG ?? join(homedir(), '.config', 'live-edits', 'daemon.json'),
);

const LANDING_MODES = new Set(['release']); // 'patch' and 'commit' arrive with the extension (EDITOR-EXTENSION-PLAN.md §5.4)

function readJson(path) {
  if (!existsSync(path)) {
    throw new Error(`No daemon config at ${path}. Create it (see README.md) or set LIVE_EDITS_CONFIG.`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readEnvFile(path) {
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
}

/** Resolve one project's settings: registry entry, then its env file overrides. */
function projectConfig(id, entry, daemon) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`project id "${id}" must be lowercase letters, digits and dashes`);
  if (!entry.repo || !isAbsolute(entry.repo)) throw new Error(`project ${id}: "repo" must be an absolute path`);
  const repo = resolve(entry.repo);
  const env = readEnvFile(resolve(repo, entry.envFile ?? '.env'));
  const pick = (name, fallback) => env[name] ?? fallback;

  const landing = entry.landing ?? 'release';
  if (!LANDING_MODES.has(landing)) throw new Error(`project ${id}: landing "${landing}" is not supported yet`);

  const data = resolve(repo, pick('LIVE_EDITS_DATA', entry.data ?? '.live-edits'));
  return {
    id,
    name: entry.name ?? id,
    repo,
    data,
    landing,
    token: pick('LIVE_EDITS_TOKEN', entry.token ?? ''),

    /** Branch holding every published version (release landing). */
    siteBranch: pick('LIVE_EDITS_SITE_BRANCH', entry.siteBranch ?? 'site'),
    liveRef: 'refs/live-edits/current',
    previewSiteUrl: pick('LIVE_EDITS_PREVIEW_URL', entry.previewSiteUrl ?? ''),

    paths: {
      db: join(data, 'live-edits.db'),
      site: join(data, 'site'), // worktree on the site branch, used for publishing
      worktrees: join(data, 'worktrees'),
      releases: join(data, 'releases'),
      previews: join(data, 'previews'),
      audio: join(data, 'audio'),
      uploads: join(data, 'uploads'),
      thumbs: join(data, 'thumbs'),
      deps: join(data, 'deps'), // one node_modules shared by every build worktree
      logs: join(data, 'logs'),
      tmp: join(data, 'tmp'),
    },

    summarizerModel: pick('LIVE_EDITS_SUMMARIZER_MODEL', entry.summarizerModel ?? daemon.summarizerModel),
    implementerModel: pick('LIVE_EDITS_IMPLEMENTER_MODEL', entry.implementerModel ?? daemon.implementerModel),
    implementerBudgetUsd: String(pick('LIVE_EDITS_IMPLEMENTER_BUDGET', entry.implementerBudgetUsd ?? daemon.implementerBudgetUsd)),

    /** Optional command run with one argument (the message) for dev notifications. */
    notifyCmd: pick('LIVE_EDITS_NOTIFY_CMD', entry.notifyCmd ?? ''),
    ownerName: pick('LIVE_EDITS_OWNER', entry.owner ?? 'the owner'),
    devName: pick('LIVE_EDITS_DEV', entry.dev ?? 'the developer'),
  };
}

/** Load the daemon config and every project in it. */
export function loadConfig(path = CONFIG_PATH) {
  const raw = readJson(path);
  const daemon = {
    host: raw.host ?? '127.0.0.1',
    port: Number(raw.port ?? 21784),
    whisperUrl: raw.whisperUrl ?? 'http://127.0.0.1:21782/inference',
    chrome: raw.chrome ?? '/usr/bin/google-chrome',
    claude: raw.claude ?? 'claude',
    summarizerModel: raw.summarizerModel ?? 'claude-sonnet-5',
    implementerModel: raw.implementerModel ?? 'claude-opus-5-5',
    implementerBudgetUsd: raw.implementerBudgetUsd ?? 5,
  };
  const projects = new Map(
    Object.entries(raw.projects ?? {}).map(([id, entry]) => [id, projectConfig(id, entry, daemon)]),
  );
  if (!projects.size) throw new Error(`${path} lists no projects`);
  const defaultProject = raw.defaultProject ?? [...projects.keys()][0];
  if (!projects.has(defaultProject)) throw new Error(`defaultProject "${defaultProject}" is not in projects`);
  return { path, daemon, projects, defaultProject };
}

/** Which project a CLI should act on: --project <id>, else the default. */
export function projectFromArgs(config, argv = process.argv) {
  const at = argv.indexOf('--project');
  const id = at > 0 ? argv[at + 1] : config.defaultProject;
  const project = config.projects.get(id);
  if (!project) throw new Error(`unknown project "${id}" (known: ${[...config.projects.keys()].join(', ')})`);
  return project;
}

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The dev checkout this server belongs to (two levels above tools/live-edits). */
export const REPO = resolve(here, '..', '..', '..');

// Secrets and overrides live in the repo's (gitignored) .env, shared with
// docker compose.
const envFile = join(REPO, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = (name, fallback) => process.env[name] ?? fallback;

export const DATA = resolve(env('LIVE_EDITS_DATA', join(REPO, '.live-edits')));

export const config = {
  repo: REPO,
  data: DATA,
  tool: resolve(here, '..'),
  host: env('LIVE_EDITS_HOST', '0.0.0.0'),
  port: Number(env('LIVE_EDITS_PORT', 21784)),
  token: env('LIVE_EDITS_TOKEN', ''),

  /** Branch holding every published version (LIVE-EDITS.md §3). */
  siteBranch: env('LIVE_EDITS_SITE_BRANCH', 'site'),
  liveRef: 'refs/live-edits/current',

  paths: {
    db: join(DATA, 'live-edits.db'),
    site: join(DATA, 'site'), // worktree on the site branch, used for publishing
    worktrees: join(DATA, 'worktrees'),
    releases: join(DATA, 'releases'),
    previews: join(DATA, 'previews'),
    audio: join(DATA, 'audio'),
    uploads: join(DATA, 'uploads'),
    thumbs: join(DATA, 'thumbs'),
    deps: join(DATA, 'deps'), // one node_modules shared by every build worktree
    logs: join(DATA, 'logs'),
  },

  whisperUrl: env('WHISPER_URL', 'http://127.0.0.1:21782/inference'),
  previewSiteUrl: env('LIVE_EDITS_PREVIEW_URL', 'http://127.0.0.1:21783'),
  chrome: env('CHROME_BIN', '/usr/bin/google-chrome'),

  claude: env('CLAUDE_BIN', 'claude'),
  summarizerModel: env('LIVE_EDITS_SUMMARIZER_MODEL', 'claude-sonnet-5'),
  implementerModel: env('LIVE_EDITS_IMPLEMENTER_MODEL', 'claude-opus-5-5'),
  implementerBudgetUsd: env('LIVE_EDITS_IMPLEMENTER_BUDGET', '5'),

  /** Optional command run with one argument (the message) for dev notifications. */
  notifyCmd: env('LIVE_EDITS_NOTIFY_CMD', ''),
  ownerName: env('LIVE_EDITS_OWNER', 'the owner'),
  devName: env('LIVE_EDITS_DEV', 'David'),
};

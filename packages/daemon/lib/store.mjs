// One SQLite store per project (its .live-edits/live-edits.db). Opening a
// store creates the schema if it's new, so existing databases are used as-is.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id    INTEGER,
  created_at    TEXT NOT NULL,
  route         TEXT,
  status        TEXT NOT NULL,            -- transcribing | ready | failed
  audio_path    TEXT,
  transcript    TEXT,
  live_caption  TEXT,
  typed_text    TEXT,
  pointed       TEXT,                     -- JSON
  attachments   TEXT NOT NULL DEFAULT '[]' -- JSON [{name, path}]
);
CREATE TABLE IF NOT EXISTS requests (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  status              TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  base_version        TEXT NOT NULL,      -- live version the change builds on
  latest_at_creation  TEXT NOT NULL,      -- newest version when it started
  summary             TEXT,               -- JSON from the summarizer, owner-edited
  report              TEXT,               -- JSON from the implementer
  branch              TEXT,
  worktree            TEXT,
  session_id          TEXT,
  version             TEXT,
  cost_usd            REAL NOT NULL DEFAULT 0,
  error               TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  INTEGER,
  at          TEXT NOT NULL,
  kind        TEXT NOT NULL,              -- progress | status | error | dev
  message     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
  tag           TEXT PRIMARY KEY,
  request_id    INTEGER,
  based_on      TEXT,
  published_at  TEXT NOT NULL,
  lines         TEXT NOT NULL,            -- JSON [owner-language summary lines]
  route         TEXT,
  thumbnail     TEXT,
  set_aside_by  TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`;

export const now = () => new Date().toISOString();

const JSON_COLS = { notes: ['pointed', 'attachments'], requests: ['summary', 'report'], versions: ['lines'] };

export function parseRow(table, row) {
  if (!row) return row;
  const out = { ...row };
  for (const col of JSON_COLS[table] ?? []) {
    if (typeof out[col] === 'string') out[col] = JSON.parse(out[col]);
  }
  return out;
}

export function openStore(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
  const setSetting = (key, value) =>
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);

  const getRequest = (id) => parseRow('requests', db.prepare('SELECT * FROM requests WHERE id = ?').get(id));

  function updateRequest(id, fields) {
    const entries = Object.entries({ ...fields, updated_at: now() }).map(([k, v]) => [
      k,
      v !== null && typeof v === 'object' ? JSON.stringify(v) : v,
    ]);
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE requests SET ${sets} WHERE id = ?`).run(...entries.map(([, v]) => v), id);
    return getRequest(id);
  }

  const notesFor = (requestId) =>
    db.prepare('SELECT * FROM notes WHERE request_id = ? ORDER BY id').all(requestId).map((r) => parseRow('notes', r));

  const listVersions = () =>
    db.prepare('SELECT * FROM versions').all().map((r) => parseRow('versions', r)).sort((a, b) => compareVersions(a.tag, b.tag));

  return { db, getSetting, setSetting, getRequest, updateRequest, notesFor, listVersions, close: () => db.close() };
}

export function parseVersion(tag) {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!m) throw new Error(`not a version tag: ${tag}`);
  return m.slice(1).map(Number);
}

export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export function bumpVersion(tag, kind) {
  const [maj, min, pat] = parseVersion(tag);
  if (kind === 'major') return `v${maj + 1}.0.0`;
  if (kind === 'minor') return `v${maj}.${min + 1}.0`;
  return `v${maj}.${min}.${pat + 1}`;
}

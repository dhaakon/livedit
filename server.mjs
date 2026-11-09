// Live-edits server (LIVE-EDITS.md §6). Reached by the edit bar through the
// preview nginx at /_live-edits/*, which strips that prefix.
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { config } from './lib/config.mjs';
import { db, now, getSetting, listVersions, parseRow } from './lib/db.mjs';
import { addClient, changed } from './lib/events.mjs';
import { transcribe } from './lib/transcribe.mjs';
import { releaseExists } from './lib/releases.mjs';
import {
  createRequest, reviseRequest, submitRequest, followupRequest, publishRequest, discardRequest,
  switchLive, draftNotes, recover, implementLane, httpError,
} from './lib/workflow.mjs';

const { paths } = config;
for (const dir of Object.values(paths)) if (!dir.endsWith('.db')) mkdirSync(dir, { recursive: true });

const app = Fastify({ logger: { level: 'info' }, bodyLimit: 2 * 1024 * 1024 });
await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024, files: 12 } });

// ---------------------------------------------------------------- auth
// One shared token (LIVE-EDITS.md §6). The bar learns it from ?edit=<token>.
app.addHook('onRequest', async (req, reply) => {
  if (!config.token || !req.url.startsWith('/api/')) return;
  const given = req.headers['x-live-edits-token'] ?? new URL(req.url, 'http://x').searchParams.get('token');
  if (given !== config.token) reply.code(401).send({ error: 'Enter the access code to make changes.' });
});

app.setErrorHandler((err, req, reply) => {
  const code = err.statusCode ?? 500;
  if (code >= 500) req.log.error(err);
  reply.code(code).send({ error: err.message });
});

// ---------------------------------------------------------------- static bits

app.get('/bar.js', (req, reply) => {
  const file = join(config.tool, 'bar', 'dist', 'bar.js');
  if (!existsSync(file)) return reply.code(404).type('application/javascript').send('/* edit bar not built */');
  reply.header('Cache-Control', 'no-cache').type('application/javascript').send(createReadStream(file));
});

app.get('/thumbs/:file', (req, reply) => {
  const file = join(paths.thumbs, basename(req.params.file));
  if (!existsSync(file)) return reply.code(404).send();
  reply.type('image/png').send(createReadStream(file));
});

app.get('/audio/:file', (req, reply) => {
  const file = join(paths.audio, basename(req.params.file));
  if (!existsSync(file)) return reply.code(404).send();
  reply.type(extname(file) === '.mp4' ? 'audio/mp4' : 'audio/webm').send(createReadStream(file));
});

/** Choose what the preview host serves for this browser: the live release, a
 * past version, or a pending request's preview (a cookie read by nginx). */
app.get('/view', (req, reply) => {
  const { target = 'live', path = '/', nobar } = req.query;
  const safePath = typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') ? path : '/';
  const cookies = [];
  if (target === 'live') {
    cookies.push('le_view=; Path=/; Max-Age=0; SameSite=Lax');
  } else if (/^v\d+\.\d+\.\d+$/.test(target) ? releaseExists(target) : /^req-\d+$/.test(target) && existsSync(join(paths.previews, target, 'index.html'))) {
    cookies.push(`le_view=${target}; Path=/; SameSite=Lax`);
  } else {
    throw httpError(404, 'That version is not available.');
  }
  if (nobar) cookies.push('le_nobar=1; Path=/; SameSite=Lax');
  reply.header('Set-Cookie', cookies).header('Cache-Control', 'no-store').redirect(safePath);
});

// ---------------------------------------------------------------- state

const STATUS_VISIBLE_DAYS = 3;

function state() {
  const versions = listVersions().map((v) => ({
    tag: v.tag,
    date: v.published_at,
    lines: v.lines,
    route: v.route,
    based_on: v.based_on,
    set_aside_by: v.set_aside_by,
    thumbnail: v.thumbnail ? `thumbs/${v.thumbnail}` : null,
  }));
  const notes = draftNotes().map(publicNote);
  const since = new Date(Date.now() - STATUS_VISIBLE_DAYS * 86_400_000).toISOString();
  const requests = db
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
      has_preview: existsSync(join(paths.previews, `req-${r.id}`, 'index.html')),
      progress: db
        .prepare("SELECT message FROM events WHERE request_id = ? AND kind = 'progress' ORDER BY id DESC LIMIT 5")
        .all(r.id)
        .map((e) => e.message)
        .reverse(),
    }));
  return {
    owner: config.ownerName,
    dev: config.devName,
    live: getSetting('live_version'),
    latest: getSetting('latest_version'),
    versions,
    notes,
    requests,
    working: implementLane.busy,
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

app.get('/api/state', () => state());

app.get('/api/events', (req, reply) => {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.write('data: {"type":"hello"}\n\n');
  const remove = addClient(reply);
  req.raw.on('close', remove);
  return reply; // keep the stream open
});

app.get('/api/requests/:id/events', (req) =>
  db.prepare('SELECT at, kind, message FROM events WHERE request_id = ? ORDER BY id').all(Number(req.params.id)),
);

// ---------------------------------------------------------------- notes

const safeName = (name) => basename(name || 'file').replace(/[^\w.-]+/g, '_').slice(-80);

app.post('/api/notes', async (req) => {
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
    const path = join(paths.uploads, `${id}-${safeName(f.name)}`);
    await writeFile(path, f.data);
    attachments.push({ name: safeName(f.name), path });
  }
  let audioPath = null;
  if (audio) {
    audioPath = join(paths.audio, `${id}${/mp4|aac|m4a/.test(audio.mime) ? '.mp4' : '.webm'}`);
    await writeFile(audioPath, audio.data);
  }
  db.prepare('UPDATE notes SET attachments = ?, audio_path = ? WHERE id = ?').run(JSON.stringify(attachments), audioPath, id);
  changed();

  if (audioPath) {
    transcribe(audioPath)
      .then((text) => db.prepare("UPDATE notes SET transcript = ?, status = ? WHERE id = ?").run(text, text ? 'ready' : 'failed', id))
      .catch((err) => {
        req.log.error(err, 'transcription failed');
        const fallback = fields.caption?.trim();
        db.prepare('UPDATE notes SET status = ?, transcript = ? WHERE id = ?').run(fallback ? 'ready' : 'failed', fallback || null, id);
      })
      .finally(changed);
  }
  return { id };
});

app.delete('/api/notes/:id', async (req) => {
  db.prepare('DELETE FROM notes WHERE id = ? AND request_id IS NULL').run(Number(req.params.id));
  changed();
  return { ok: true };
});

// ---------------------------------------------------------------- requests

app.post('/api/requests', async (req) => ({ id: createRequest(req.body?.noteIds) }));
app.patch('/api/requests/:id', async (req) => {
  reviseRequest(Number(req.params.id), req.body ?? {});
  return { ok: true };
});
app.post('/api/requests/:id/submit', async (req) => {
  submitRequest(Number(req.params.id));
  return { ok: true };
});
app.post('/api/requests/:id/followup', async (req) => {
  await followupRequest(Number(req.params.id), req.body ?? {});
  return { ok: true };
});
app.post('/api/requests/:id/publish', async (req) => {
  publishRequest(Number(req.params.id));
  return { ok: true };
});
app.post('/api/requests/:id/discard', async (req) => {
  discardRequest(Number(req.params.id));
  return { ok: true };
});

app.post('/api/live', async (req) => {
  await switchLive(req.body ?? {});
  return { ok: true, live: getSetting('live_version') };
});

// ---------------------------------------------------------------- start

if (!getSetting('live_version')) {
  console.error('No live version yet. Run `npm run init-site` in tools/live-edits first.');
  process.exit(1);
}
await recover();
await app.listen({ host: config.host, port: config.port });

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import { db, now } from './db.mjs';
import { run } from './run.mjs';

const clients = new Set();

/** Register an SSE response; returns an unsubscribe function. */
export function addClient(reply) {
  clients.add(reply);
  return () => clients.delete(reply);
}

function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const reply of clients) {
    try {
      reply.raw.write(data);
    } catch {
      clients.delete(reply);
    }
  }
}

/** Something in the state changed: bars refetch /api/state. */
export function changed() {
  broadcast({ type: 'changed' });
}

/** Record a request event (progress/status/error), and push it live. */
export function logEvent(requestId, kind, message) {
  db.prepare('INSERT INTO events (request_id, at, kind, message) VALUES (?, ?, ?, ?)').run(requestId, now(), kind, message);
  broadcast({ type: 'event', requestId, kind, message });
}

// Keepalive so proxies (nginx, ngrok) don't drop idle event streams.
setInterval(() => broadcast({ type: 'ping' }), 25_000).unref();

/** Tell the dev something happened (LIVE-EDITS.md §7). Always logged; also
 * sent through LIVE_EDITS_NOTIFY_CMD when configured. */
export function notifyDev(message) {
  mkdirSync(config.paths.logs, { recursive: true });
  appendFileSync(join(config.paths.logs, 'notifications.log'), `${now()} ${message}\n`);
  console.log(`[notify] ${message}`);
  if (config.notifyCmd) {
    run('sh', ['-c', `${config.notifyCmd} "$1"`, 'notify', message]).catch((err) =>
      console.error('notify failed', err),
    );
  }
}

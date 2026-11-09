import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { now } from './store.mjs';
import { run } from './run.mjs';

/**
 * One project's live event stream (SSE to its bars), request event log, and
 * dev notifications. Each project has its own, so a bar only hears about the
 * project it's editing.
 */
export function createEvents(project, store) {
  const clients = new Set();

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

  // Keepalive so proxies (nginx, ngrok) don't drop idle event streams.
  setInterval(() => broadcast({ type: 'ping' }), 25_000).unref();

  return {
    /** Register an SSE response; returns an unsubscribe function. */
    addClient(reply) {
      clients.add(reply);
      return () => clients.delete(reply);
    },

    /** Something in the state changed: bars refetch /api/state. */
    changed() {
      broadcast({ type: 'changed' });
    },

    /** Record a request event (progress/status/error), and push it live. */
    logEvent(requestId, kind, message) {
      store.db.prepare('INSERT INTO events (request_id, at, kind, message) VALUES (?, ?, ?, ?)').run(requestId, now(), kind, message);
      broadcast({ type: 'event', requestId, kind, message });
    },

    /** Tell the dev something happened (LIVE-EDITS.md §7). Always logged; also
     * sent through the project's LIVE_EDITS_NOTIFY_CMD when configured. */
    notifyDev(message) {
      mkdirSync(project.paths.logs, { recursive: true });
      appendFileSync(join(project.paths.logs, 'notifications.log'), `${now()} ${message}\n`);
      console.log(`[${project.id}] [notify] ${message}`);
      if (project.notifyCmd) {
        run('sh', ['-c', `${project.notifyCmd} "$1"`, 'notify', message]).catch((err) => console.error('notify failed', err));
      }
    },
  };
}

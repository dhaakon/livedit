import { mkdirSync } from 'node:fs';
import { openStore } from './store.mjs';
import { createEvents } from './events.mjs';
import { createClaude } from './claude.mjs';
import { createReleases } from './releases.mjs';
import { createWorkflow } from './workflow.mjs';

/**
 * Everything one project needs at runtime: its config, its own SQLite store,
 * event stream, Claude bindings, landing adapter and workflow (with its own
 * job lanes). Projects share nothing but the daemon process.
 */
export function openProject(project, daemon) {
  for (const [name, dir] of Object.entries(project.paths)) {
    // The publishing worktree is created by `git worktree add`; the db is a file.
    if (name !== 'db' && name !== 'site') mkdirSync(dir, { recursive: true });
  }
  const store = openStore(project.paths.db);
  const events = createEvents(project, store);
  const claude = createClaude(project, daemon);
  const releases = createReleases(project, daemon);
  const workflow = createWorkflow(project, { store, events, claude, releases });
  return { config: project, daemon, store, events, releases, workflow };
}

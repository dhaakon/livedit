// Rebuild one published version's release folder from its tag (LIVE-EDITS.md §3.5).
//   node bin/rebuild-release.mjs [--project <id>] v1.4.0
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, projectFromArgs } from '../lib/config.mjs';
import { openProject } from '../lib/project.mjs';

const daemonConfig = loadConfig();
const config = projectFromArgs(daemonConfig);
const { currentRelease, rebuildRelease } = openProject(config, daemonConfig.daemon).releases;

const tag = process.argv.slice(2).find((a) => /^v\d+\.\d+\.\d+$/.test(a));
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) {
  console.error('usage: node bin/rebuild-release.mjs [--project <id>] vX.Y.Z');
  process.exit(1);
}
if (currentRelease() !== tag) rmSync(join(config.paths.releases, tag), { recursive: true, force: true });
await rebuildRelease(tag);
console.log(`rebuilt ${tag}`);
process.exit(0);

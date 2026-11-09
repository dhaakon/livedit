// Rebuild one published version's release folder from its tag (LIVE-EDITS.md §3.5).
//   node bin/rebuild-release.mjs v1.4.0
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../lib/config.mjs';
import { currentRelease, rebuildRelease } from '../lib/releases.mjs';

const tag = process.argv[2];
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) {
  console.error('usage: node bin/rebuild-release.mjs vX.Y.Z');
  process.exit(1);
}
if (currentRelease() !== tag) rmSync(join(config.paths.releases, tag), { recursive: true, force: true });
await rebuildRelease(tag);
console.log(`rebuilt ${tag}`);

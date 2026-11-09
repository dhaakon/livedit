// Release dev work committed on the site branch as a new version — the same
// steps as the owner's Publish (version, changelog, tag, release build, live
// switch, History entry), so it can be stepped back from like any other.
//
//   node bin/release-site.mjs --bump minor --route / --line "What changed, for the owner" [--line …]
//
// Run while the live-edits server is idle (no publish in progress).
import { releaseSiteHead } from '../lib/workflow.mjs';

const args = process.argv.slice(2);
const all = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const one = (name, fallback) => all(name)[0] ?? fallback;

const tag = await releaseSiteHead({ bump: one('bump', 'minor'), route: one('route', '/'), lines: all('line') });
console.log(`released ${tag}`);
process.exit(0);

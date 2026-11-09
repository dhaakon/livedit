import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { config } from './config.mjs';
import { run } from './run.mjs';

const schema = (name) => readFileSync(join(config.tool, 'schemas', `${name}.json`), 'utf8');
const ADD_IMAGE = join(config.tool, 'bin', 'add-image.mjs');

/** Prompt file path, with {{ADD_IMAGE}} filled in with this checkout's photo tool. */
function prompt(name) {
  const text = readFileSync(join(config.tool, 'prompts', `${name}.md`), 'utf8').replaceAll('{{ADD_IMAGE}}', ADD_IMAGE);
  const dir = join(config.data, 'tmp', 'prompts');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${name}.md`);
  writeFileSync(out, text);
  return out;
}

/** Voice notes -> checklist (LIVE-EDITS.md §4.1). No tools, schema-enforced. */
export async function summarize(input) {
  const res = await run(
    config.claude,
    [
      '-p',
      '--model', config.summarizerModel,
      '--output-format', 'json',
      '--tools', '',
      '--max-budget-usd', '0.5',
      '--json-schema', schema('summary'),
      '--append-system-prompt-file', prompt('summarizer'),
    ],
    { input: JSON.stringify(input, null, 2), cwd: config.data, timeoutMs: 5 * 60_000 },
  );
  const out = parseJson(res.stdout);
  if (res.code !== 0 || !out || out.is_error || !out.structured_output) {
    throw new Error(`summarizer failed: ${out?.result || res.stderr || res.stdout}`.slice(0, 2000));
  }
  return { summary: out.structured_output, cost: out.total_cost_usd ?? 0 };
}

const IMPLEMENTER_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'Bash(npm run build)', 'Bash(git status)', 'Bash(git status:*)', 'Bash(git diff:*)',
  'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git log:*)', 'Bash(git show:*)',
  `Bash(node ${ADD_IMAGE}:*)`, 'Bash(node scripts/add-image.mjs:*)', 'Bash(node scripts/site-map.mjs)',
];

/**
 * Run the implementer (or the merge resolver) in a worktree (§4.2). Streams
 * progress through `onProgress(line)` in owner-friendly words. Starts a new
 * session with `sessionId`, or continues it when `resume` is true.
 */
export async function implement({ cwd, sessionId, resume, message, role = 'implementer', addDirs = [], onProgress }) {
  const args = [
    '-p',
    '--model', config.implementerModel,
    resume ? '--resume' : '--session-id', sessionId,
    '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits',
    '--max-budget-usd', String(config.implementerBudgetUsd),
    '--json-schema', schema('implementation'),
    '--append-system-prompt-file', prompt(role),
    '--allowedTools', ...IMPLEMENTER_TOOLS,
  ];
  for (const dir of addDirs) args.push('--add-dir', dir);
  // A bare "--" ends the variadic --allowedTools list before the prompt.
  args.push('--', message);

  let result = null;
  const res = await run(config.claude, args, {
    cwd,
    timeoutMs: 45 * 60_000,
    onStdoutLine: (line) => {
      const event = parseJson(line);
      if (!event) return;
      if (event.type === 'result') result = event;
      if (event.type === 'assistant') {
        for (const block of event.message?.content ?? []) {
          if (block.type === 'tool_use') {
            const text = describeTool(block.name, block.input, cwd);
            if (text) onProgress?.(text);
          }
        }
      }
    },
  });

  return {
    ok: res.code === 0 && result && !result.is_error,
    report: result?.structured_output ?? null,
    cost: result?.total_cost_usd ?? 0,
    error: result?.is_error ? `${result.subtype}: ${result.result ?? ''}` : res.code !== 0 ? res.stderr.slice(-2000) : null,
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// --- Owner-friendly progress lines --------------------------------------

const PAGE_NAMES = {
  home: 'Home page', about: 'About page', services: 'Services page', gallery: 'Gallery',
  galleries: 'Gallery albums', blog: 'Blog', 'blog-post': 'Blog posts', contact: 'Contact page',
  'not-found': 'Missing-page screen', site: 'header and footer', testimonials: 'Testimonials',
};

function friendlyFile(file, cwd) {
  const rel = file.startsWith('/') ? relative(cwd, file) : file;
  let m;
  if ((m = /^src\/content\/blog\/(.+)\.md$/.exec(rel))) return `the blog post “${m[1].replace(/-/g, ' ')}”`;
  if ((m = /^src\/content\/galleries\//.exec(rel))) return 'the gallery albums';
  if ((m = /^src\/content\/(\w[\w-]*)\.json$/.exec(rel))) return `the ${PAGE_NAMES[m[1]] ?? m[1]} wording`;
  if ((m = /^src\/routes\/([\w-]+)\/\w+\.module\.scss$/.exec(rel))) return `the ${PAGE_NAMES[m[1]] ?? m[1]} styling`;
  if ((m = /^src\/routes\/([\w-]+)\//.exec(rel))) return `the ${PAGE_NAMES[m[1]] ?? m[1]} layout`;
  if (/^src\/styles\//.test(rel)) return 'the site-wide styles';
  if (/^src\/components\/layout\//.test(rel)) return 'the header and footer';
  if (/^src\/components\//.test(rel)) return 'a shared part of the site';
  if (/^public\/images\//.test(rel)) return 'a photo';
  if (/^TECH_SPEC\.md$|^CLAUDE\.md$/.test(rel)) return 'the brand guidelines';
  return null;
}

function describeTool(name, input = {}, cwd) {
  const file = input.file_path ? friendlyFile(input.file_path, cwd) : null;
  switch (name) {
    case 'Read':
      return file ? `Looking at ${file}…` : null;
    case 'Edit':
    case 'Write':
      return file ? `Updating ${file}…` : 'Making a change…';
    case 'Grep':
    case 'Glob':
      return 'Finding the right place…';
    case 'Bash': {
      const cmd = String(input.command ?? '');
      if (cmd.startsWith('npm run build')) return 'Checking the site still builds…';
      if (cmd.startsWith('git commit')) return 'Saving this change…';
      if (cmd.includes('add-image.mjs')) return 'Preparing your photo…';
      return null;
    }
    default:
      return null;
  }
}

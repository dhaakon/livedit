import { spawn } from 'node:child_process';

/** Run a command, collecting output. Never throws on a non-zero exit; check `code`. */
export function run(cmd, args, { cwd = process.cwd(), input, env, onStdoutLine, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let pending = '';
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGTERM'), timeoutMs) : null;

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (!onStdoutLine) return;
      pending += text;
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (line.trim()) onStdoutLine(line);
      }
    });
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (onStdoutLine && pending.trim()) onStdoutLine(pending);
      resolve({ code, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** git in a given directory; throws with stderr on failure unless `allowFail`. */
export async function git(cwd, args, { allowFail = false, env } = {}) {
  const res = await run('git', args, { cwd, env });
  if (res.code !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed (${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
  }
  return allowFail ? res : res.stdout.trim();
}

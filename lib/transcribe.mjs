import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { config } from './config.mjs';

/** Transcribe a saved recording with the local whisper.cpp server. The server
 * runs with --convert, so any browser format (webm/opus, mp4/aac) is fine. */
export async function transcribe(audioPath) {
  const form = new FormData();
  form.append('file', new Blob([await readFile(audioPath)]), basename(audioPath));
  form.append('temperature', '0.0');
  form.append('response_format', 'json');

  const res = await fetch(config.whisperUrl, { method: 'POST', body: form, signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`whisper ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body.error) throw new Error(`whisper: ${body.error}`);

  // whisper marks silence/noise as bracketed tags, e.g. [BLANK_AUDIO], (wind).
  return String(body.text ?? '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

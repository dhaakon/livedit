// Talks to the live-edits server through the preview host's /_live-edits/ proxy.
export const BASE = '/_live-edits/';

const TOKEN_KEY = 'live-edits-token';

function readToken() {
  try {
    const fromUrl = new URLSearchParams(location.search).get('edit');
    if (fromUrl) {
      localStorage.setItem(TOKEN_KEY, fromUrl);
      const url = new URL(location.href);
      url.searchParams.delete('edit');
      history.replaceState(history.state, '', url);
    }
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

let token = readToken();

export function setToken(value) {
  token = value.trim();
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* private mode: keep it for this page only */
  }
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body, form } = {}) {
  const res = await fetch(BASE + 'api/' + path, {
    method,
    headers: { 'X-Live-Edits-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `Something went wrong (${res.status}).`, res.status);
  return data;
}

export function subscribe(onMessage) {
  let source;
  let retry;
  const open = () => {
    source = new EventSource(`${BASE}api/events?token=${encodeURIComponent(token)}`);
    source.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };
    source.onerror = () => {
      source.close();
      retry = setTimeout(open, 3000);
    };
  };
  open();
  return () => {
    clearTimeout(retry);
    source?.close();
  };
}

/** Switch what this browser sees (live / a version / a request preview). */
export function view(target, path = location.pathname) {
  location.href = `${BASE}view?target=${encodeURIComponent(target)}&path=${encodeURIComponent(path)}`;
}

export function currentView() {
  const m = /(?:^|;\s*)le_view=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]) : 'live';
}

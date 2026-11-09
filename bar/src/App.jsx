import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, BASE, currentView, setToken, subscribe, view } from './api.js';
import { canRecord, startRecording } from './recorder.js';
import { pickElement } from './picker.js';

const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtShort = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

const ACTIVE = ['summarizing', 'queued', 'implementing', 'building', 'publishing'];
const NEEDS_YOU = ['awaiting_review', 'ready_for_preview', 'needs_answers', 'failed'];

export function App({ host }) {
  const [data, setData] = useState(null);
  const [needToken, setNeedToken] = useState(false);
  const [panel, setPanel] = useState(null); // notes | changes | history | type
  const [toast, setToast] = useState(null);
  const [rec, setRec] = useState(null); // { caption, level }
  const recorder = useRef(null);
  const [pointed, setPointed] = useState(null); // { info, screenshot }
  const [files, setFiles] = useState([]);
  const [followupFor, setFollowupFor] = useState(null);
  const [saving, setSaving] = useState(false);
  const fileInput = useRef(null);
  const viewing = currentView();

  const toastTimer = useRef(null);
  const say = useCallback((text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setData(await api('state'));
      setNeedToken(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setNeedToken(true);
      else say(err.message);
    }
  }, [say]);

  useEffect(() => {
    refresh();
    let t;
    const stop = subscribe((msg) => {
      // 'hello' arrives on every (re)connect, e.g. after a server restart.
      if (msg.type === 'changed' || msg.type === 'event' || msg.type === 'hello') {
        clearTimeout(t);
        t = setTimeout(refresh, 200);
      }
    });
    return () => {
      stop();
      clearTimeout(t);
    };
  }, [refresh]);

  // A preview that no longer exists (published or discarded): back to live.
  useEffect(() => {
    if (!data) return;
    const m = /^req-(\d+)$/.exec(viewing);
    if (m && !data.requests.some((r) => r.id === Number(m[1]) && r.has_preview)) view('live');
  }, [data, viewing]);

  const call = useCallback(
    async (fn, ok) => {
      try {
        const res = await fn();
        if (ok) say(ok);
        await refresh();
        return res;
      } catch (err) {
        say(err.message);
        return null;
      }
    },
    [refresh, say],
  );

  // ------------------------------------------------------------ notes

  async function saveNote({ blob, type, caption, typed }) {
    const form = new FormData();
    form.append('route', location.pathname);
    if (caption) form.append('caption', caption);
    if (typed) form.append('typed', typed);
    if (pointed) form.append('pointed', JSON.stringify(pointed.info));
    if (blob) form.append('audio', blob, type.includes('mp4') ? 'note.mp4' : 'note.webm');
    for (const f of files) form.append('attachments', f, f.name);
    if (pointed?.screenshot) form.append('attachments', pointed.screenshot, 'pointed-element.png');
    setSaving(true);
    try {
      const { id } = await api('notes', { method: 'POST', form });
      setPointed(null);
      setFiles([]);
      if (followupFor) {
        await api(`requests/${followupFor}/followup`, { method: 'POST', body: { noteIds: [id] } });
        setFollowupFor(null);
        setPanel('changes');
        say('Got it — Claude is adjusting the change.');
      } else {
        say('Note saved. Add more, or tap Done.');
      }
      await refresh();
    } catch (err) {
      say(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleRecord() {
    if (recorder.current) {
      const r = recorder.current;
      recorder.current = null;
      setRec(null);
      const result = await r.stop();
      if (result.blob.size < 2000 && !result.caption) return say("That was very short — I didn't catch anything.");
      await saveNote(result);
      return;
    }
    try {
      setRec({ caption: '', level: 0 });
      recorder.current = await startRecording({
        onCaption: (caption) => setRec((s) => s && { ...s, caption }),
        onLevel: (level) => setRec((s) => s && { ...s, level }),
      });
    } catch {
      setRec(null);
      say("I couldn't use the microphone. Check the browser's permission, or type instead.");
    }
  }

  async function point() {
    setPanel(null);
    say('Tap the part of the page you mean. Esc to cancel.');
    const picked = await pickElement(host);
    if (picked) {
      setPointed(picked);
      say('Got it. Now record or type what to change about it.');
    } else setToast(null);
  }

  async function done() {
    const id = await call(() => api('requests', { method: 'POST', body: {} }).then((r) => r.id));
    if (id) setPanel('changes');
  }

  if (!data && !needToken) return <div className="bar"><span className="muted">Loading the edit bar…</span></div>;

  if (needToken) return <TokenBar onSave={(v) => { setToken(v); refresh(); }} />;

  const { versions, live, latest, notes, requests } = data;
  const liveIdx = versions.findIndex((v) => v.tag === live);
  const attention = requests.filter((r) => NEEDS_YOU.includes(r.status)).length;
  const working = requests.some((r) => ACTIVE.includes(r.status));
  const onOlder = live !== latest;

  return (
    <>
      {panel && (
        <Sheet onClose={() => setPanel(null)} title={{ notes: 'Your notes', changes: 'Changes', history: 'History', type: followupFor ? `What's not quite right?` : 'Type a note' }[panel]}>
          {panel === 'notes' && <NotesPanel notes={notes} call={call} onDone={done} onOlder={onOlder} live={live} latest={latest} versions={versions} />}
          {panel === 'changes' && (
            <ChangesPanel
              requests={requests}
              data={data}
              call={call}
              viewing={viewing}
              onNotQuite={(id) => {
                setFollowupFor(id);
                setPanel('type');
              }}
            />
          )}
          {panel === 'history' && <HistoryPanel versions={versions} live={live} latest={latest} call={call} viewing={viewing} />}
          {panel === 'type' && (
            <TypePanel
              followup={followupFor}
              saving={saving}
              onRecordInstead={() => {
                setPanel(null);
                toggleRecord();
              }}
              onSave={async (text) => {
                await saveNote({ typed: text });
                if (!followupFor) setPanel(null);
              }}
              onCancel={() => {
                setFollowupFor(null);
                setPanel(null);
              }}
            />
          )}
        </Sheet>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}

      <div className="bar" role="toolbar" aria-label="Edit the website">
        <ViewingBanner viewing={viewing} live={live} requests={requests} call={call} />

        {followupFor && !panel && (
          <div className="banner">
            Telling Claude what's not quite right about change #{followupFor}: record, or{' '}
            <button className="link" onClick={() => setPanel('type')}>type it</button>.{' '}
            <button className="link" onClick={() => setFollowupFor(null)}>Cancel</button>
          </div>
        )}

        <div className="row">
          <div className="group">
            <button
              className={rec ? 'btn rec on' : 'btn rec'}
              onClick={toggleRecord}
              disabled={saving || !canRecord()}
              title={canRecord() ? '' : 'Recording needs the secure (https) link. You can type instead.'}
            >
              <span className="dot" style={rec ? { transform: `scale(${1 + rec.level * 0.9})` } : undefined} />
              {rec ? 'Stop' : 'Record'}
            </button>
            {!rec && (
              <>
                <button className="btn" onClick={() => setPanel(panel === 'type' ? null : 'type')} disabled={saving} aria-label="Type a note">
                  ✎<span className="label"> Type</span>
                </button>
                <button className={pointed ? 'btn active' : 'btn'} onClick={point} disabled={saving} aria-label="Point at something">
                  ⌖<span className="label"> Point</span>
                </button>
                <button className={files.length ? 'btn active' : 'btn'} onClick={() => fileInput.current.click()} disabled={saving} aria-label="Add a photo">
                  📎<span className="label"> Photo</span>
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    setFiles((f) => [...f, ...e.target.files]);
                    e.target.value = '';
                    say('Photo added. It goes with your next note.');
                  }}
                />
              </>
            )}
          </div>

          {rec ? (
            <div className="caption" aria-live="polite">{rec.caption || 'Listening… say what you’d like changed.'}</div>
          ) : (
            <div className="group grow">
              {pointed && (
                <span className="chip">
                  ⌖ {pointed.info.text ? `“${pointed.info.text.slice(0, 28)}${pointed.info.text.length > 28 ? '…' : ''}”` : pointed.info.tag}
                  <button aria-label="Remove" onClick={() => setPointed(null)}>×</button>
                </span>
              )}
              {files.map((f, i) => (
                <span className="chip" key={i}>
                  📎 {f.name.slice(0, 18)}
                  <button aria-label="Remove" onClick={() => setFiles((all) => all.filter((_, j) => j !== i))}>×</button>
                </span>
              ))}
              {saving && <span className="muted">Saving…</span>}
              {notes.length > 0 && (
                <>
                  <button className="btn" onClick={() => setPanel(panel === 'notes' ? null : 'notes')}>
                    {notes.length} note{notes.length > 1 ? 's' : ''}
                  </button>
                  <button className="btn primary" onClick={done}>Done →</button>
                </>
              )}
              {(attention > 0 || working) && (
                <button className={attention ? 'btn attention' : 'btn'} onClick={() => setPanel(panel === 'changes' ? null : 'changes')}>
                  {working && <span className="spinner" />}
                  {attention ? `${attention} change${attention > 1 ? 's' : ''} need${attention > 1 ? '' : 's'} you` : 'Working…'}
                </button>
              )}
              {!attention && !working && requests.length > 0 && (
                <button className="btn quiet" onClick={() => setPanel(panel === 'changes' ? null : 'changes')}>Changes</button>
              )}
            </div>
          )}

          <div className="group versions">
            <button
              className="btn icon"
              aria-label="Previous version"
              disabled={liveIdx <= 0}
              onClick={() => call(() => api('live', { method: 'POST', body: { step: -1 } })).then((r) => r && location.reload())}
            >
              ◀
            </button>
            <button className="btn version" onClick={() => setPanel(panel === 'history' ? null : 'history')} title="History">
              {live} <span className="muted hint">· {live === latest ? 'latest' : 'older'}</span>
            </button>
            <button
              className="btn icon"
              aria-label="Next version"
              disabled={liveIdx >= versions.length - 1}
              onClick={() => call(() => api('live', { method: 'POST', body: { step: 1 } })).then((r) => r && location.reload())}
            >
              ▶
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------ pieces

function TokenBar({ onSave }) {
  const [value, setValue] = useState('');
  return (
    <div className="bar">
      <form className="row" onSubmit={(e) => { e.preventDefault(); onSave(value); }}>
        <span>Enter the access code to make changes:</span>
        <input className="input" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        <button className="btn primary">Unlock</button>
      </form>
    </div>
  );
}

function Sheet({ title, onClose, children }) {
  return (
    <div className="sheet" role="dialog" aria-label={title}>
      <header>
        <h2>{title}</h2>
        <button className="btn icon" onClick={onClose} aria-label="Close">×</button>
      </header>
      <div className="sheet-body">{children}</div>
    </div>
  );
}

function ViewingBanner({ viewing, live, requests, call }) {
  if (viewing === 'live') return null;
  const req = /^req-(\d+)$/.exec(viewing);
  if (req) {
    return (
      <div className="banner preview">
        <span>Previewing change #{req[1]} (not live yet)</span>
        <button className="btn small" onClick={() => view('live')}>Before</button>
        <button className="btn small active">After</button>
        <button className="link" onClick={() => view('live')}>Back to the live site</button>
      </div>
    );
  }
  return (
    <div className="banner preview">
      <span>Looking at {viewing}. The live site is {live}.</span>
      <button
        className="btn small primary"
        onClick={() => call(() => api('live', { method: 'POST', body: { version: viewing } })).then((r) => r && view('live'))}
      >
        Make this live
      </button>
      <button className="link" onClick={() => view('live')}>Back to the live site</button>
    </div>
  );
}

function OlderNote({ live, latest, versions }) {
  if (live === latest) return null;
  const liveV = versions.find((v) => v.tag === live);
  const later = versions.filter((v) => v.tag !== live && versions.indexOf(v) > versions.indexOf(liveV));
  return (
    <p className="note-older">
      You're on {live}{liveV ? ` from ${fmtShort(liveV.date)}` : ''}. Your change will build on this version. Later
      versions ({later.length > 1 ? `${later[0].tag}–${later.at(-1).tag}` : later[0]?.tag}) stay in History, and you can
      switch back to them any time.
    </p>
  );
}

function NotesPanel({ notes, call, onDone, onOlder, live, latest, versions }) {
  return (
    <>
      {notes.length === 0 && <p className="muted">No notes yet. Record or type what you'd like changed.</p>}
      <ul className="list">
        {notes.map((n) => (
          <li key={n.id} className="card">
            <div className="meta">
              {n.route} {n.pointed?.edit_id && <span className="tag">⌖ {n.pointed.text || n.pointed.edit_id}</span>}
              {n.attachments.map((a) => <span className="tag" key={a}>📎 {a}</span>)}
            </div>
            <p>
              {n.status === 'transcribing' ? <span className="muted"><span className="spinner" /> Writing down what you said…</span>
                : n.status === 'failed' ? <span className="muted">Couldn't hear that one — try again?</span>
                  : n.said}
            </p>
            <div className="actions">
              {n.audio && <audio controls preload="none" src={BASE + n.audio} />}
              <button className="link" onClick={() => call(() => api(`notes/${n.id}`, { method: 'DELETE' }))}>Remove</button>
            </div>
          </li>
        ))}
      </ul>
      {notes.length > 0 && (
        <>
          {onOlder && <OlderNote live={live} latest={latest} versions={versions} />}
          <button className="btn primary wide" onClick={onDone}>Done: turn these into changes →</button>
        </>
      )}
    </>
  );
}

function TypePanel({ followup, saving, onSave, onCancel, onRecordInstead }) {
  const [text, setText] = useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) onSave(text.trim()).then(() => setText('')); }}>
      <textarea
        className="input area"
        rows={4}
        autoFocus
        placeholder={followup ? 'e.g. "Closer, but make the heading a bit smaller"' : 'e.g. "Make the Services heading softer, like the logo"'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="actions">
        <button className="btn primary" disabled={saving || !text.trim()}>{followup ? 'Send to Claude' : 'Save note'}</button>
        {canRecord() && <button type="button" className="btn" onClick={onRecordInstead}>● Record instead</button>}
        <button type="button" className="link" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

const STATUS_TEXT = {
  summarizing: 'Reading your notes…',
  awaiting_review: 'Check this list',
  queued: 'Waiting its turn…',
  implementing: 'Making the changes…',
  building: 'Checking everything still works…',
  needs_answers: 'A question for you',
  ready_for_preview: 'Ready to look at',
  publishing: 'Making it live…',
  published: 'Published',
  failed: 'Needs a hand',
};

function ChangesPanel({ requests, data, call, viewing, onNotQuite }) {
  if (!requests.length) return <p className="muted">No changes yet.</p>;
  return (
    <ul className="list">
      {requests.map((r) => (
        <li key={r.id} className={`card status-${r.status}`}>
          <div className="meta">
            Change #{r.id} · {fmtShort(r.created_at)} · <strong>{STATUS_TEXT[r.status] ?? r.status}</strong>
            {r.version && <span className="tag">{r.version}</span>}
          </div>
          <RequestBody r={r} data={data} call={call} viewing={viewing} onNotQuite={onNotQuite} />
        </li>
      ))}
    </ul>
  );
}

function RequestBody({ r, data, call, viewing, onNotQuite }) {
  const [items, setItems] = useState(null);
  const [answers, setAnswers] = useState({});
  const summary = r.summary;

  useEffect(() => {
    if (summary) setItems(summary.items.map((i) => ({ include: i.include, owner_summary: i.owner_summary })));
  }, [r.id, r.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const discard = () => window.confirm('Throw this change away?') && call(() => api(`requests/${r.id}/discard`, { method: 'POST' }), 'Discarded.');

  if (ACTIVE.includes(r.status)) {
    return (
      <div className="progress">
        <span className="spinner" />
        <ul>{(r.progress.length ? r.progress : [STATUS_TEXT[r.status]]).map((p, i) => <li key={i}>{p}</li>)}</ul>
        {r.status !== 'publishing' && <p className="muted">You can keep browsing; this bar will tell you when it's ready.</p>}
      </div>
    );
  }

  if (r.status === 'awaiting_review' && summary && items) {
    const qs = summary.questions;
    const answerOf = (q, i) => (answers[i] ?? q.answer ?? '').trim();
    // An answered open question can become new checklist items, so the list
    // gets rethought (and comes back here) before anything goes to Claude.
    const rethink = qs.some((q, i) => q.item === null && answerOf(q, i)) || !items.some((i) => i.include);
    const canSend = items.some((i) => i.include) || qs.some((q, i) => answerOf(q, i));
    const submit = async () => {
      await call(() =>
        api(`requests/${r.id}`, {
          method: 'PATCH',
          body: { items, questions: qs.map((q, i) => ({ answer: answerOf(q, i) })) },
        }),
      );
      await call(() => api(`requests/${r.id}/submit`, { method: 'POST' }), rethink ? 'Thanks — updating the list.' : 'Sent to Claude.');
    };
    return (
      <>
        {summary.fallback && <p className="muted">I couldn't tidy this one up, so here's what you said. Edit it if needed.</p>}
        {summary.items.length === 0 && <p className="muted">Answer below and I'll turn it into a list for you to check.</p>}
        <ol className="checklist">
          {summary.items.map((item, i) => (
            <li key={i}>
              <input
                type="checkbox"
                checked={items[i]?.include ?? true}
                onChange={(e) => setItems((all) => all.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))}
                aria-label="Include this change"
              />
              <textarea
                className="input inline"
                rows={Math.min(6, Math.ceil((items[i]?.owner_summary ?? '').length / 52) + 1)}
                value={items[i]?.owner_summary ?? ''}
                onChange={(e) => setItems((all) => all.map((x, j) => (j === i ? { ...x, owner_summary: e.target.value } : x)))}
              />
            </li>
          ))}
        </ol>
        {qs.map((q, i) => (
          <Question key={i} q={q} value={answers[i] ?? q.answer ?? ''} onChange={(v) => setAnswers((a) => ({ ...a, [i]: v }))} />
        ))}
        {r.base_version !== r.latest_at_creation && (
          <OlderNote live={r.base_version} latest={r.latest_at_creation} versions={data.versions} />
        )}
        <div className="actions">
          <button className="btn primary" onClick={submit} disabled={!canSend}>{rethink ? 'Update the list' : 'Send to Claude'}</button>
          <button className="link" onClick={discard}>Discard</button>
        </div>
      </>
    );
  }

  const report = r.report?.items ?? [];
  const asks = report.filter((i) => i.status === 'needs_clarification');
  const sendAnswers = () => {
    const text = asks.map((a, i) => `Q: ${a.question}\nA: ${answers[`r${i}`] ?? ''}`).join('\n\n');
    return call(() => api(`requests/${r.id}/followup`, { method: 'POST', body: { text } }), 'Thanks — Claude is on it.');
  };

  return (
    <>
      {report.length > 0 && (
        <ul className="report">
          {report.map((i) => (
            <li key={i.item} className={i.status}>
              <span>{i.status === 'done' ? '✓' : i.status === 'skipped' ? '–' : '?'}</span> {i.note}
            </li>
          ))}
        </ul>
      )}
      {asks.length > 0 && r.status !== 'published' && (
        <>
          {asks.map((a, i) => (
            <Question key={i} q={{ ask: a.question, options: [] }} value={answers[`r${i}`] ?? ''} onChange={(v) => setAnswers((x) => ({ ...x, [`r${i}`]: v }))} />
          ))}
          <button className="btn" onClick={sendAnswers}>Send answers</button>
        </>
      )}
      {r.error && <p className="error">{r.status === 'failed' ? `This one needs ${data.dev}, who's been told.` : r.error.split('\n')[0]}</p>}
      {r.status === 'failed' && r.error && <details><summary className="muted">Details</summary><pre>{r.error}</pre></details>}
      <div className="actions">
        {r.status === 'ready_for_preview' && (
          <>
            {viewing === `req-${r.id}` ? (
              <button className="btn" onClick={() => view('live')}>See before</button>
            ) : (
              <button className="btn" onClick={() => view(`req-${r.id}`, routeOf(r))}>Preview</button>
            )}
            <button
              className="btn primary"
              onClick={() => call(() => api(`requests/${r.id}/publish`, { method: 'POST' }), 'Publishing…')}
            >
              Publish
            </button>
            <button className="btn" onClick={() => onNotQuite(r.id)}>Not quite</button>
          </>
        )}
        {r.status === 'failed' && (
          <button className="btn" onClick={() => call(() => api(`requests/${r.id}/followup`, { method: 'POST', body: { text: 'Please try that again.' } }))}>
            Try again
          </button>
        )}
        {['ready_for_preview', 'needs_answers', 'failed'].includes(r.status) && <button className="link" onClick={discard}>Discard</button>}
        {r.status === 'published' && r.version === data.live && <span className="muted">Live on the website ✓</span>}
      </div>
    </>
  );
}

const routeOf = (r) => r.summary?.items?.find((i) => i.include && i.route && i.route !== '*' && !i.route.includes(':'))?.route ?? '/';

function Question({ q, value, onChange }) {
  return (
    <div className="question">
      <p>❓ {q.ask}</p>
      {q.options?.length > 0 && (
        <div className="options" role="radiogroup">
          {q.options.map((o) => (
            <button key={o} role="radio" aria-checked={value === o} className={value === o ? 'choice selected' : 'choice'} onClick={() => onChange(value === o ? '' : o)}>
              <span className="tick" aria-hidden="true">{value === o ? '✓' : ''}</span>
              {o}
            </button>
          ))}
        </div>
      )}
      <input
        className="input"
        placeholder={q.options?.length ? 'Or type your own answer' : 'Your answer'}
        value={q.options?.includes(value) ? '' : value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function HistoryPanel({ versions, live, latest, call, viewing }) {
  const ordered = useMemo(() => [...versions].reverse(), [versions]);
  return (
    <ul className="list history">
      {ordered.map((v) => (
        <li key={v.tag} className={v.tag === live ? 'card live' : 'card'}>
          {v.thumbnail ? <img src={BASE + v.thumbnail} alt="" loading="lazy" /> : <div className="thumb-empty" />}
          <div>
            <div className="meta">
              <strong>{v.tag}</strong> · {fmtDate(v.date)}
              {v.tag === live && <span className="tag live">Live</span>}
              {v.tag === latest && v.tag !== live && <span className="tag">Latest</span>}
              {viewing === v.tag && <span className="tag">Looking at this</span>}
            </div>
            <ul className="lines">{v.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
            {v.set_aside_by && <p className="muted small">Set aside when {v.set_aside_by} was built on {versions.find((x) => x.tag === v.set_aside_by)?.based_on ?? 'an earlier version'}</p>}
            <div className="actions">
              {v.tag !== live && (
                <>
                  <button className="btn small" onClick={() => view(v.tag, v.route || '/')}>Preview</button>
                  <button
                    className="btn small primary"
                    onClick={() => call(() => api('live', { method: 'POST', body: { version: v.tag } })).then((r) => r && view('live'))}
                  >
                    Make this live
                  </button>
                </>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

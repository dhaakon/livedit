// "Point at something": highlight what's under the pointer, and on tap capture
// enough about it for Claude to find it: its data-edit-id, a selector path,
// visible text and a small screenshot (LIVE-EDITS.md §2.1).
import { toBlob } from 'html-to-image';

function selectorPath(el) {
  const parts = [];
  for (let node = el; node && node.nodeType === 1 && node !== document.body && parts.length < 6; node = node.parentElement) {
    let part = node.tagName.toLowerCase();
    // CSS-module class names keep their readable part (_heroHeading_1masy_63).
    const cls = [...node.classList].slice(0, 2);
    if (cls.length) part += '.' + cls.map((c) => CSS.escape(c)).join('.');
    const parent = node.parentElement;
    if (parent) {
      const same = [...parent.children].filter((c) => c.tagName === node.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    parts.unshift(part);
  }
  return parts.join(' > ');
}

async function snapshot(el) {
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const scale = Math.min(1, 900 / Math.max(rect.width, rect.height));
  try {
    return await Promise.race([
      toBlob(el, { pixelRatio: scale, cacheBust: false, skipFonts: true }),
      new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
  } catch {
    return null;
  }
}

/** Start picking. Resolves with { info, screenshot } or null if cancelled. */
export function pickElement(host) {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: 2147483000, border: '2px solid #555b52',
      background: 'rgba(229, 207, 158, 0.18)', borderRadius: '2px', transition: 'all 80ms ease-out', display: 'none',
    });
    document.body.appendChild(box);
    document.documentElement.style.cursor = 'crosshair';

    const target = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      return el && !host.contains(el) && el !== box ? el : null;
    };
    const onMove = (e) => {
      const el = target(e);
      if (!el) return (box.style.display = 'none');
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { display: 'block', left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width}px`, height: `${r.height}px` });
    };
    const finish = (value) => {
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      document.documentElement.style.cursor = '';
      setTimeout(() => box.remove(), value ? 900 : 0);
      resolve(value);
    };
    const onClick = async (e) => {
      if (host.contains(e.target) || e.composedPath().includes(host)) return; // the bar itself
      const el = target(e);
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      onMove(e);
      const tagged = el.closest('[data-edit-id]');
      const info = {
        edit_id: tagged?.getAttribute('data-edit-id') ?? '',
        tag: el.tagName.toLowerCase(),
        selector: selectorPath(el),
        text: (el.innerText || el.getAttribute('alt') || '').trim().replace(/\s+/g, ' ').slice(0, 200),
        src: el.currentSrc || el.getAttribute?.('src') || undefined,
        page: location.pathname,
        viewport: `${innerWidth}x${innerHeight}`,
      };
      finish({ info, screenshot: await snapshot(tagged && tagged.contains(el) && tagged.getBoundingClientRect().height < 900 ? tagged : el) });
    };
    const onKey = (e) => e.key === 'Escape' && finish(null);
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  });
}

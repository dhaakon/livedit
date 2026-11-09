import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import css from './styles.css?inline';

// Injected by the preview nginx into every page (LIVE-EDITS.md §2.1). Lives in
// a shadow root so the site's styles and the bar's can't touch each other.
function mount() {
  if (document.getElementById('live-edits-root') || /(?:^|;\s*)le_nobar=1/.test(document.cookie)) return;
  const host = document.createElement('div');
  host.id = 'live-edits-root';
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = css;
  shadow.appendChild(style);
  const container = document.createElement('div');
  shadow.appendChild(container);
  createRoot(container).render(<App host={host} />);

  // Keep the page's last content clear of the bar, and tell the sheet and
  // toast how tall it is. The bar is position: fixed, so watch it directly
  // (re-attaching whenever React swaps it out).
  let observed = null;
  const update = () => {
    const h = observed?.offsetHeight ?? 0;
    document.body.style.paddingBottom = `${h}px`;
    container.style.setProperty('--bar-h', `${h}px`);
  };
  const resize = new ResizeObserver(update);
  const attach = () => {
    const bar = shadow.querySelector('.bar');
    if (bar && bar !== observed) {
      if (observed) resize.unobserve(observed);
      resize.observe(bar);
      observed = bar;
    }
    update();
  };
  new MutationObserver(attach).observe(shadow, { childList: true, subtree: true });
  attach();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
else mount();

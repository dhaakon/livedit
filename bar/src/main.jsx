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

  // Keep the page's last content clear of the bar.
  const bar = () => shadow.querySelector('.bar');
  new ResizeObserver(() => {
    const h = bar()?.offsetHeight ?? 0;
    document.body.style.paddingBottom = `${h}px`;
  }).observe(container);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
else mount();

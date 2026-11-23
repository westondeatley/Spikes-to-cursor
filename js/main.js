// App shell: section routing (#hash), presenter keyboard controls, theme toggle, lesson clock.

import * as pipeline from './core/pipeline.js';
import bandwidth from './sections/bandwidth.js';
import signal from './sections/signal.js';
import sorting from './sections/sorting.js';
import decoding from './sections/decoding.js';
import webgrid from './sections/webgrid.js';
import { initGlossary } from './ui/glossary.js';

const ORDER = ['bandwidth', 'signal', 'sorting', 'decoding', 'webgrid', 'wrapup'];
const MODULES = { bandwidth, signal, sorting, decoding, webgrid };
const mounted = new Set();
let current = null;

// ---------- Theme ----------
// The viewer's theme wins by default ("system"); the rail button overrides it for projectors.
const root = document.documentElement;
const THEMES = ['system', 'light', 'dark'];
const themeBtn = document.getElementById('theme-toggle');
function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
  return null;
}
function applyTheme(t) {
  if (t === 'system') delete root.dataset.theme;
  else root.dataset.theme = t;
  themeBtn.textContent = `Theme: ${t}`;
}
let theme = THEMES.includes(store('stc-theme')) ? store('stc-theme') : 'system';
if (theme !== 'system') applyTheme(theme);
else themeBtn.textContent = 'Theme: system';
themeBtn.addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  applyTheme(theme);
  store('stc-theme', theme);
});
// Canvases read colors from CSS tokens, so they redraw whenever the theme changes.
const fireTheme = () => window.dispatchEvent(new Event('themechange'));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', fireTheme);
new MutationObserver(fireTheme).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
document.fonts?.ready.then(fireTheme);

// ---------- Routing ----------
function show(id) {
  if (!ORDER.includes(id)) id = 'bandwidth';
  if (id === current) return;
  if (current) MODULES[current]?.deactivate?.();
  for (const s of ORDER) document.getElementById(`sec-${s}`).hidden = s !== id;
  const idx = ORDER.indexOf(id);
  document.querySelectorAll('#chain a').forEach((a) => {
    const i = ORDER.indexOf(a.dataset.section);
    if (i === idx) a.setAttribute('aria-current', 'step');
    else a.removeAttribute('aria-current');
    a.parentElement.classList.toggle('done', i < idx);
  });
  const mod = MODULES[id];
  if (mod && !mounted.has(id)) {
    mod.mount();
    mounted.add(id);
  }
  mod?.activate?.();
  current = id;
  window.scrollTo({ top: 0 });
}

function fromHash() {
  show(location.hash.replace('#', '') || 'bandwidth');
}

function step(delta) {
  const i = ORDER.indexOf(current);
  const next = ORDER[Math.min(ORDER.length - 1, Math.max(0, i + delta))];
  if (next !== current) location.hash = next;
}

// Presentation clickers send PageDown / PageUp; arrow keys work too,
// except while a slider or text field has focus.
window.addEventListener('keydown', (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const tag = document.activeElement?.tagName;
  const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  if (e.key === 'PageDown' || (!inField && e.key === 'ArrowRight')) {
    e.preventDefault();
    step(1);
  } else if (e.key === 'PageUp' || (!inField && e.key === 'ArrowLeft')) {
    e.preventDefault();
    step(-1);
  }
});

// ---------- Lesson clock ----------
// Planned minute windows for each stage; the stage you should be on is highlighted.
const PLAN = { bandwidth: [0, 5], signal: [5, 12], sorting: [12, 20], decoding: [20, 30], webgrid: [30, 38], wrapup: [38, 40] };
const LESSON_MIN = 40;
const clockEl = document.querySelector('.clock');
const clockTime = document.getElementById('clock-time');
const clockFill = document.getElementById('clock-fill');
const clockToggle = document.getElementById('clock-toggle');
let elapsedMs = 0;
let startedAt = null;
let tick = null;

function renderClock() {
  const ms = elapsedMs + (startedAt ? Date.now() - startedAt : 0);
  const sec = Math.floor(ms / 1000);
  clockTime.textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  const min = ms / 60000;
  clockFill.style.width = `${Math.min(100, (min / LESSON_MIN) * 100)}%`;
  clockEl.classList.toggle('over', min > LESSON_MIN);
  document.querySelectorAll('#chain a').forEach((a) => {
    const [lo, hi] = PLAN[a.dataset.section];
    a.classList.toggle('now', ms > 0 && min >= lo && min < hi);
  });
}
clockToggle.addEventListener('click', () => {
  if (startedAt) {
    elapsedMs += Date.now() - startedAt;
    startedAt = null;
    clearInterval(tick);
    clockToggle.textContent = 'Resume';
  } else {
    startedAt = Date.now();
    tick = setInterval(renderClock, 1000);
    clockToggle.textContent = 'Pause';
  }
  renderClock();
});
document.getElementById('clock-reset').addEventListener('click', () => {
  elapsedMs = 0;
  if (startedAt) startedAt = Date.now();
  else clockToggle.textContent = 'Start';
  renderClock();
});

// ---------- Boot ----------
pipeline.init();
initGlossary();
window.addEventListener('hashchange', fromHash);
fromHash();

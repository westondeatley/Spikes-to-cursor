// Stage 4: Webgrid challenge.
// A grid selection task scored in bits per second. In BCI mode the cursor is moved by the
// Stage 3 decoder: mouse motion -> intended velocity -> simulated spikes -> decoded velocity.
// The real pointer is hidden, so the player steers by watching the decoded cursor (closed loop).

import { bci, BIN_S, DECODER_NAMES, initBci, step, resetDecoder } from '../core/bci.js';
import { bitsPerSecond } from '../core/decoding.js';
import { fitCanvas, autoRedraw, css, alpha } from '../ui/plot.js';
import { bindSegmented } from '../ui/controls.js';

const ROUND_S = 30;
const MAX_SPEED = 3; // same cap as Stage 3: beyond this, neurons saturate
const COUNTDOWN_S = 3;
const BOARD_KEY = 'stc-leaderboard';
const BOARD_SHOW = 10;

const game = {
  phase: 'idle', // idle | countdown | play | done
  grid: 8,
  mode: 'bci',
  pos: [0, 0],
  intent: [0, 0],
  pending: [0, 0], // pointer movement (px) not yet turned into velocity
  acc: 0,
  target: 0,
  hits: 0,
  misses: 0,
  tPhase: 0, // seconds into the current phase
  flash: null, // { cell, good, t }
  locked: false,
  lastId: null,
  trail: [],
};

let canvas, overlay, overlayBig, overlaySmall, nameInput, startBtn;
let geom = null;
let active = false;
let raf = 0;
let lastT = 0;

// ---------- leaderboard (per browser, which suits one projected screen) ----------
function loadBoard() {
  try {
    const rows = JSON.parse(localStorage.getItem(BOARD_KEY) || '[]');
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}
function saveBoard(rows) {
  try {
    localStorage.setItem(BOARD_KEY, JSON.stringify(rows));
  } catch {
    /* storage unavailable: the board still works until the page reloads */
  }
}
let board = [];

function renderBoard() {
  const tbody = document.querySelector('#wg-board tbody');
  const rows = [...board].sort((a, b) => b.bps - a.bps).slice(0, BOARD_SHOW);
  tbody.replaceChildren(
    ...rows.map((r, i) => {
      const tr = document.createElement('tr');
      if (r.id === game.lastId) tr.className = 'board-latest';
      const setup = r.mode === 'mouse' ? `Mouse · ${r.grid}×${r.grid}` : `${r.decoderShort} · ${r.neurons} neurons · day ${r.day} · ${r.grid}×${r.grid}`;
      for (const [text, cls] of [[i + 1, 'rank'], [r.name, 'name'], [r.bps.toFixed(2), 'num strong'], [r.hits, 'num'], [r.misses, 'num'], [setup, 'setup']]) {
        const td = document.createElement('td');
        td.className = cls;
        td.textContent = text;
        tr.append(td);
      }
      return tr;
    })
  );
  document.getElementById('wg-empty').hidden = rows.length > 0;
  document.getElementById('wg-board').hidden = rows.length === 0;
}

// ---------- geometry ----------
function gridGeom(w, h) {
  const pad = 16;
  const side = Math.min(w, h) - 2 * pad;
  return { x0: (w - side) / 2, y0: (h - side) / 2, side };
}
function cellAt(p) {
  const G = game.grid;
  const c = Math.min(G - 1, Math.max(0, Math.floor(((p[0] + 1) / 2) * G)));
  const r = Math.min(G - 1, Math.max(0, Math.floor(((1 - p[1]) / 2) * G)));
  return r * G + c;
}
function newTarget() {
  const n = game.grid * game.grid;
  let t;
  do t = Math.floor(Math.random() * n);
  while (t === game.target && n > 1);
  game.target = t;
}

// ---------- input ----------
function onMove(e) {
  if (game.phase !== 'play' && game.phase !== 'countdown') return;
  game.pending[0] += e.movementX || 0;
  game.pending[1] += e.movementY || 0;
}
function select() {
  if (game.phase !== 'play') return;
  const cell = cellAt(game.pos);
  const good = cell === game.target;
  if (good) {
    game.hits++;
    newTarget();
  } else {
    game.misses++;
  }
  game.flash = { cell, good, t: performance.now() };
}

// ---------- simulation ----------
function pxToUnits(px) {
  return geom ? (px * 2) / geom.side : 0;
}
function advance(dt) {
  if (game.mode === 'mouse') {
    // Direct control: the cursor moves exactly with the mouse.
    game.pos[0] += pxToUnits(game.pending[0]);
    game.pos[1] -= pxToUnits(game.pending[1]);
    game.pending = [0, 0];
  } else {
    game.acc += dt;
    while (game.acc >= BIN_S) {
      game.acc -= BIN_S;
      const raw = [pxToUnits(game.pending[0]) / BIN_S, -pxToUnits(game.pending[1]) / BIN_S];
      game.pending = [0, 0];
      game.intent = [0.55 * game.intent[0] + 0.45 * raw[0], 0.55 * game.intent[1] + 0.45 * raw[1]];
      const sp = Math.hypot(...game.intent);
      if (sp > MAX_SPEED) game.intent = game.intent.map((v) => (v * MAX_SPEED) / sp);
      const v = step(game.intent);
      game.pos[0] += v[0] * BIN_S;
      game.pos[1] += v[1] * BIN_S;
      game.trail.push(game.pos.slice());
      if (game.trail.length > 30) game.trail.shift();
    }
  }
  game.pos = game.pos.map((v) => Math.max(-1, Math.min(1, v)));
}

// ---------- rounds ----------
function setOverlay(big, small) {
  overlay.hidden = !big;
  overlayBig.textContent = big || '';
  overlaySmall.textContent = small || '';
}

function startRound() {
  if (game.phase === 'countdown' || game.phase === 'play') return;
  initBci();
  resetDecoder();
  Object.assign(game, { phase: 'countdown', tPhase: 0, hits: 0, misses: 0, pos: [0, 0], intent: [0, 0], pending: [0, 0], acc: 0, flash: null, trail: [] });
  newTarget();
  startBtn.disabled = true;
  canvas.classList.add('playing');
  game.locked = false;
  try {
    const p = canvas.requestPointerLock?.();
    p?.catch?.(() => {});
  } catch {
    /* pointer lock unavailable: movement still works while the pointer is over the grid */
  }
  updateReadouts();
}

function finishRound(aborted) {
  game.phase = aborted ? 'idle' : 'done';
  startBtn.disabled = false;
  startBtn.textContent = 'Play again';
  canvas.classList.remove('playing');
  if (document.pointerLockElement === canvas) document.exitPointerLock?.();
  if (aborted) {
    setOverlay('Round stopped', 'The pointer left the game. Press Start to try again.');
    return;
  }
  const bps = bitsPerSecond(game.grid * game.grid, game.hits, game.misses, ROUND_S);
  const name = nameInput.value.trim() || `Player ${board.length + 1}`;
  const entry = {
    id: `${Date.now()}`,
    name,
    bps,
    hits: game.hits,
    misses: game.misses,
    grid: game.grid,
    mode: game.mode,
    decoderShort: { pv: 'Pop. vector', linear: 'Linear', kalman: 'Kalman' }[bci.decoder],
    neurons: bci.neurons,
    day: bci.day,
  };
  board.push(entry);
  saveBoard(board);
  game.lastId = entry.id;
  renderBoard();
  const rank = [...board].sort((a, b) => b.bps - a.bps).findIndex((r) => r.id === entry.id) + 1;
  setOverlay(`${bps.toFixed(2)} bits/s`, `${name}: ${game.hits} hits, ${game.misses} misses. Rank ${rank} of ${board.length}.`);
  nameInput.value = '';
}

function tick(t) {
  if (!active) return;
  const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0;
  lastT = t;
  if (game.phase === 'countdown') {
    game.tPhase += dt;
    game.pending = [0, 0];
    const left = Math.ceil(COUNTDOWN_S - game.tPhase);
    setOverlay(String(Math.max(1, left)), game.mode === 'bci' ? 'Steer the dot by watching it, not your hand.' : 'Mouse mode: direct control.');
    if (game.tPhase >= COUNTDOWN_S) {
      game.phase = 'play';
      game.tPhase = 0;
      setOverlay(null);
    }
  } else if (game.phase === 'play') {
    game.tPhase += dt;
    advance(dt);
    if (game.tPhase >= ROUND_S) finishRound(false);
  }
  draw();
  updateReadouts();
  raf = requestAnimationFrame(tick);
}

// ---------- drawing ----------
function draw() {
  const { ctx, w, h } = fitCanvas(canvas);
  if (w < 60 || h < 60) return;
  const g = (geom = gridGeom(w, h));
  const G = game.grid;
  const cs = g.side / G;
  const accent = css('--accent'), grid = css('--rule'), ink = css('--ink');

  ctx.fillStyle = css('--well');
  ctx.fillRect(g.x0, g.y0, g.side, g.side);

  const playing = game.phase === 'play' || game.phase === 'countdown';
  if (playing || game.phase === 'done') {
    const tr = Math.floor(game.target / G), tc = game.target % G;
    ctx.fillStyle = accent;
    ctx.fillRect(g.x0 + tc * cs + 2, g.y0 + tr * cs + 2, cs - 4, cs - 4);
  }
  if (game.flash) {
    const age = (performance.now() - game.flash.t) / 350;
    if (age < 1) {
      const fr = Math.floor(game.flash.cell / G), fc = game.flash.cell % G;
      ctx.fillStyle = alpha(css(game.flash.good ? '--good' : '--bad'), 0.55 * (1 - age));
      ctx.fillRect(g.x0 + fc * cs, g.y0 + fr * cs, cs, cs);
    } else game.flash = null;
  }

  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = 0; k <= G; k++) {
    const x = Math.round(g.x0 + k * cs) + 0.5;
    const y = Math.round(g.y0 + k * cs) + 0.5;
    ctx.moveTo(x, g.y0);
    ctx.lineTo(x, g.y0 + g.side);
    ctx.moveTo(g.x0, y);
    ctx.lineTo(g.x0 + g.side, y);
  }
  ctx.stroke();

  if (game.phase === 'play') {
    const hc = cellAt(game.pos);
    const hr = Math.floor(hc / G), hcc = hc % G;
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2;
    ctx.strokeRect(g.x0 + hcc * cs + 1, g.y0 + hr * cs + 1, cs - 2, cs - 2);
  }

  const toPx = (p) => [g.x0 + ((p[0] + 1) / 2) * g.side, g.y0 + ((1 - p[1]) / 2) * g.side];
  if (game.mode === 'bci' && game.trail.length > 1) {
    for (let i = 1; i < game.trail.length; i++) {
      const a = toPx(game.trail[i - 1]), b = toPx(game.trail[i]);
      ctx.strokeStyle = alpha(ink, (i / game.trail.length) * 0.35);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
  }
  const [cx, cy] = toPx(game.pos);
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(6, Math.min(10, cs * 0.18)), 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = css('--panel');
  ctx.lineWidth = 2.5;
  ctx.stroke();

  if (game.phase === 'play') {
    const frac = 1 - game.tPhase / ROUND_S;
    ctx.fillStyle = css('--grid');
    ctx.fillRect(g.x0, g.y0 - 8, g.side, 4);
    ctx.fillStyle = frac < 0.2 ? css('--bad') : accent;
    ctx.fillRect(g.x0, g.y0 - 8, g.side * frac, 4);
  }
}

function updateReadouts() {
  const elapsed = game.phase === 'play' ? game.tPhase : game.phase === 'done' ? ROUND_S : 0;
  const left = game.phase === 'play' ? ROUND_S - game.tPhase : game.phase === 'done' ? 0 : ROUND_S;
  document.getElementById('wg-time').textContent = `${Math.max(0, left).toFixed(1)} s`;
  document.getElementById('wg-hits').textContent = `${game.hits} / ${game.misses}`;
  const bps = elapsed > 1 ? bitsPerSecond(game.grid * game.grid, game.hits, game.misses, elapsed) : 0;
  document.getElementById('wg-bps').textContent = bps.toFixed(2);
}

function updateUsing() {
  const el = document.getElementById('wg-using');
  if (game.mode === 'mouse') {
    el.textContent = 'Mouse mode: the cursor follows your mouse directly. Use it as the baseline.';
  } else {
    const stale = bci.day - bci.calibDay;
    el.textContent = `Decoder: ${DECODER_NAMES[bci.decoder]} · ${bci.neurons} neurons · day ${bci.day}${stale > 0 ? ` (calibration ${stale} days old)` : ''}. Change it in Stage 3.`;
  }
  document.getElementById('wg-meta').textContent = `${game.grid} × ${game.grid} grid · ${ROUND_S} s · ${Math.log2(game.grid * game.grid - 1).toFixed(2)} bits per hit`;
}

export default {
  mount() {
    canvas = document.getElementById('wg-canvas');
    overlay = document.getElementById('wg-overlay');
    overlayBig = document.getElementById('wg-overlay-big');
    overlaySmall = document.getElementById('wg-overlay-small');
    nameInput = document.getElementById('wg-name');
    startBtn = document.getElementById('wg-start');
    autoRedraw(canvas, draw);
    board = loadBoard();
    renderBoard();

    bindSegmented(document.getElementById('wg-mode'), {
      initial: game.mode,
      onChange: (v) => {
        game.mode = v;
        updateUsing();
      },
    });
    bindSegmented(document.getElementById('wg-grid'), {
      initial: game.grid,
      onChange: (v) => {
        game.grid = +v;
        if (game.phase !== 'play') game.phase = 'idle';
        updateUsing();
        draw();
      },
    });
    startBtn.addEventListener('click', startRound);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') startRound();
    });

    canvas.addEventListener('pointermove', (e) => !game.locked && onMove(e));
    document.addEventListener('mousemove', (e) => game.locked && onMove(e));
    canvas.addEventListener('mousedown', (e) => {
      if (game.phase === 'play') {
        e.preventDefault();
        select();
      }
    });
    window.addEventListener('keydown', (e) => {
      if (!active || game.phase !== 'play') return;
      if (e.code === 'Space' || e.key === 'Enter') {
        e.preventDefault();
        select();
      }
    });
    document.addEventListener('pointerlockchange', () => {
      const nowLocked = document.pointerLockElement === canvas;
      // Pressing Esc releases the lock: stop the round rather than leave the pointer stranded.
      if (game.locked && !nowLocked && (game.phase === 'play' || game.phase === 'countdown')) finishRound(true);
      game.locked = nowLocked;
    });

    const confirm = document.getElementById('wg-confirm');
    const clearBtn = document.getElementById('wg-clear');
    clearBtn.addEventListener('click', () => {
      confirm.hidden = false;
      clearBtn.hidden = true;
    });
    document.getElementById('wg-confirm-no').addEventListener('click', () => {
      confirm.hidden = true;
      clearBtn.hidden = false;
    });
    document.getElementById('wg-confirm-yes').addEventListener('click', () => {
      board = [];
      saveBoard(board);
      renderBoard();
      confirm.hidden = true;
      clearBtn.hidden = false;
    });
  },
  activate() {
    active = true;
    updateUsing();
    lastT = 0;
    raf = requestAnimationFrame(tick);
  },
  deactivate() {
    active = false;
    cancelAnimationFrame(raf);
    if (game.phase === 'play' || game.phase === 'countdown') finishRound(true);
  },
};

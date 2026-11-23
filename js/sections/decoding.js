// Stage 3: decoding intent.
// Your mouse movement is the "intended" velocity. Simulated motor-cortex neurons fire
// accordingly, and the chosen decoder moves its own cursor from spike counts alone.

import { bci, bciEvents, BIN_S, DECODER_NAMES, initBci, setNeurons, setDay, setDecoder, calibrate, step, resetDecoder } from '../core/bci.js';
import { correlation } from '../core/decoding.js';
import { fitCanvas, autoRedraw, css, alpha, FONT_MONO, FONT_SANS } from '../ui/plot.js';
import { bindRange, bindSegmented } from '../ui/controls.js';

const MAX_SPEED = 3; // workspace units per second
const HIST_BINS = 200; // 4 s of history for the live match score
const TRAIL = 45;

const view = {
  mouse: null,
  lastMouse: null,
  intent: [0, 0],
  dec: [0, 0],
  decVel: [0, 0],
  firing: new Float64Array(0),
  histI: [[], []],
  histD: [[], []],
  trailI: [],
  trailD: [],
  acc: 0,
};

let workCv, compassCv, scoresCv;
let redrawScores;
let running = false;
let raf = 0;
let lastT = 0;
let lastReadout = 0;
let nControl, dayControl, decoderSeg;
let geom = null;

// ---------- coordinates ----------
function workspaceGeom(w, h) {
  const pad = 18;
  const side = Math.min(w, h) - 2 * pad;
  return { x0: (w - side) / 2, y0: (h - side) / 2, side };
}
const toPx = (g, p) => [g.x0 + ((p[0] + 1) / 2) * g.side, g.y0 + ((1 - p[1]) / 2) * g.side];
function toWork(e) {
  if (!geom) return null;
  const r = workCv.getBoundingClientRect();
  const x = ((e.clientX - r.left - geom.x0) / geom.side) * 2 - 1;
  const y = 1 - ((e.clientY - r.top - geom.y0) / geom.side) * 2;
  return [Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y))];
}

// ---------- simulation: one 20 ms bin ----------
function binStep() {
  let raw = [0, 0];
  if (view.mouse && view.lastMouse) raw = [(view.mouse[0] - view.lastMouse[0]) / BIN_S, (view.mouse[1] - view.lastMouse[1]) / BIN_S];
  view.lastMouse = view.mouse ? view.mouse.slice() : null;
  // Smooth the mouse velocity a little: the hand moves smoothly even when mouse events are jumpy.
  view.intent = [0.6 * view.intent[0] + 0.4 * raw[0], 0.6 * view.intent[1] + 0.4 * raw[1]];
  const sp = Math.hypot(...view.intent);
  if (sp > MAX_SPEED) view.intent = view.intent.map((v) => (v * MAX_SPEED) / sp);

  const vd = step(view.intent);
  view.decVel = vd;
  view.dec = [Math.max(-1, Math.min(1, view.dec[0] + vd[0] * BIN_S)), Math.max(-1, Math.min(1, view.dec[1] + vd[1] * BIN_S))];

  const z = bci.lastCounts;
  if (view.firing.length !== z.length) view.firing = new Float64Array(z.length);
  for (let i = 0; i < z.length; i++) view.firing[i] = 0.82 * view.firing[i] + 0.18 * (z[i] / BIN_S);

  for (let d = 0; d < 2; d++) {
    view.histI[d].push(view.intent[d]);
    view.histD[d].push(vd[d]);
    if (view.histI[d].length > HIST_BINS) {
      view.histI[d].shift();
      view.histD[d].shift();
    }
  }
  if (view.mouse) view.trailI.push(view.mouse.slice());
  view.trailD.push(view.dec.slice());
  if (view.trailI.length > TRAIL) view.trailI.shift();
  if (view.trailD.length > TRAIL) view.trailD.shift();
}

// ---------- drawing ----------
function drawWorkspace() {
  const { ctx, w, h } = fitCanvas(workCv);
  if (w < 60 || h < 60) return; // hidden or not laid out yet
  const g = (geom = workspaceGeom(w, h));
  const grid = css('--grid'), faint = css('--faint'), ink = css('--ink'), accent = css('--accent');

  ctx.fillStyle = css('--well');
  ctx.fillRect(g.x0, g.y0, g.side, g.side);
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  for (let k = 1; k < 4; k++) {
    const p = g.x0 + (g.side * k) / 4, q = g.y0 + (g.side * k) / 4;
    ctx.beginPath();
    ctx.moveTo(Math.round(p) + 0.5, g.y0);
    ctx.lineTo(Math.round(p) + 0.5, g.y0 + g.side);
    ctx.moveTo(g.x0, Math.round(q) + 0.5);
    ctx.lineTo(g.x0 + g.side, Math.round(q) + 0.5);
    ctx.stroke();
  }
  // practice targets, like the calibration task
  ctx.strokeStyle = alpha(faint, 0.6);
  for (let k = 0; k < 8; k++) {
    const [px, py] = toPx(g, [0.7 * Math.cos((k * Math.PI) / 4), 0.7 * Math.sin((k * Math.PI) / 4)]);
    ctx.beginPath();
    ctx.arc(px, py, g.side * 0.035, 0, Math.PI * 2);
    ctx.stroke();
  }

  const trail = (pts, color, width) => {
    if (pts.length < 2) return;
    ctx.lineCap = 'round';
    for (let i = 1; i < pts.length; i++) {
      const a = toPx(g, pts[i - 1]), b = toPx(g, pts[i]);
      ctx.strokeStyle = alpha(color, (i / pts.length) * 0.6);
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
  };
  trail(view.trailI, ink, 1.5);
  trail(view.trailD, accent, 3);

  if (view.mouse) {
    const [mx, my] = toPx(g, view.mouse);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(mx, my, 11, 0, Math.PI * 2);
    ctx.stroke();
  }
  const [dx, dy] = toPx(g, view.dec);
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(dx, dy, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = css('--panel');
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.font = `12px ${FONT_MONO}`;
  ctx.fillStyle = faint;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(DECODER_NAMES[bci.decoder], g.x0 + 10, g.y0 + 10);
  if (!view.mouse) {
    ctx.textAlign = 'center';
    ctx.font = `500 15px ${FONT_SANS}`;
    ctx.fillStyle = css('--muted');
    ctx.fillText('Move your mouse in here', g.x0 + g.side / 2, g.y0 + g.side / 2 + 26);
  }
}

function arrow(ctx, x, y, vx, vy, color, width) {
  const len = Math.hypot(vx, vy);
  if (len < 2) return;
  const ex = x + vx, ey = y + vy;
  const ux = vx / len, uy = vy / len;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(ex - ux * 6, ey - uy * 6);
  ctx.stroke();
  const hs = 6 + width * 1.5;
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ex - ux * hs - uy * hs * 0.6, ey - uy * hs + ux * hs * 0.6);
  ctx.lineTo(ex - ux * hs + uy * hs * 0.6, ey - uy * hs - ux * hs * 0.6);
  ctx.closePath();
  ctx.fill();
}

function drawCompass() {
  const { ctx, w, h } = fitCanvas(compassCv);
  if (w < 100 || h < 100) return;
  const cx = w / 2, cy = h / 2 - 6;
  const R = Math.min(w, h) / 2 - 44;
  const accent = css('--accent'), faint = css('--faint'), ink = css('--ink'), grid = css('--grid');

  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.moveTo(cx - R, cy);
  ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R);
  ctx.lineTo(cx, cy + R);
  ctx.stroke();
  ctx.font = `11px ${FONT_MONO}`;
  ctx.fillStyle = faint;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('right', cx + R + 24, cy);
  ctx.fillText('left', cx - R - 22, cy);
  ctx.fillText('up', cx, cy - R - 14);
  ctx.fillText('down', cx, cy + R + 14);

  const pop = bci.today;
  const dotR = pop.length > 120 ? 3.2 : 4.2;
  for (let i = 0; i < pop.length; i++) {
    const u = pop[i];
    const f = view.firing[i] ?? u.base;
    const above = Math.max(0, Math.min(1, (f - u.base) / (u.depth * 1.4 + 1e-6)));
    const px = cx + R * Math.cos(u.theta), py = cy - R * Math.sin(u.theta);
    const lost = u.depth < 3;
    ctx.beginPath();
    ctx.arc(px, py, dotR + above * 3, 0, Math.PI * 2);
    if (lost) {
      ctx.strokeStyle = faint;
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.fillStyle = alpha(accent, 0.16 + 0.84 * above);
      ctx.fill();
    }
  }
  const s = (R * 0.85) / 2;
  arrow(ctx, cx, cy, view.intent[0] * s, -view.intent[1] * s, alpha(ink, 0.55), 2);
  arrow(ctx, cx, cy, view.decVel[0] * s, -view.decVel[1] * s, accent, 3.5);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = faint;
  ctx.fillText(`${pop.length} neurons · brighter = firing more`, 12, h - 8);
}

function drawScores() {
  if (!bci.scores) return;
  const { ctx, w, h } = fitCanvas(scoresCv);
  const keys = ['pv', 'linear', 'kalman'];
  const padL = 14, padR = 16, top = 22, bottom = 44;
  const rowH = (h - top - bottom) / keys.length;
  const barX = padL, barW = w - padL - padR;
  const accent = css('--accent'), trace = css('--trace'), ink = css('--ink'), faint = css('--faint');

  keys.forEach((k, i) => {
    const y = top + i * rowH;
    const r2 = bci.scores[k];
    const sel = k === bci.decoder;
    ctx.font = `${sel ? 600 : 500} 13px ${FONT_SANS}`;
    ctx.fillStyle = sel ? ink : css('--muted');
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(DECODER_NAMES[k], barX, y + 16);
    ctx.textAlign = 'right';
    ctx.font = `600 13px ${FONT_MONO}`;
    ctx.fillText(r2 > 0 ? `${Math.round(r2 * 100)}%` : 'below 0', barX + barW, y + 16);
    const by = y + 24;
    const bh = Math.min(16, rowH - 34);
    ctx.fillStyle = css('--grid');
    ctx.fillRect(barX, by, barW, bh);
    ctx.fillStyle = sel ? accent : alpha(trace, 0.45);
    ctx.fillRect(barX, by, barW * Math.max(0, Math.min(1, r2)), bh);
  });
  ctx.font = `11.5px ${FONT_MONO}`;
  ctx.fillStyle = faint;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  const stale = bci.day - bci.calibDay;
  ctx.fillText(`share of movement explained · day ${bci.day}`, padL, h - 22);
  ctx.fillStyle = stale > 0 ? css('--bad') : faint;
  ctx.fillText(stale > 0 ? `calibration is ${stale} day${stale > 1 ? 's' : ''} old` : 'freshly calibrated', padL, h - 6);
}

function updateReadouts(now) {
  if (now - lastReadout < 250) return;
  lastReadout = now;
  const live = document.getElementById('dec-live');
  let varI = 0;
  for (let d = 0; d < 2; d++) {
    const a = view.histI[d];
    const m = a.reduce((s, v) => s + v, 0) / (a.length || 1);
    varI += a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length || 1);
  }
  if (view.histI[0].length < 50 || varI < 0.02) {
    live.textContent = 'move the mouse';
    live.classList.add('readout-hint');
  } else {
    const r = (correlation(view.histI[0], view.histD[0]) + correlation(view.histI[1], view.histD[1])) / 2;
    live.textContent = `r = ${r.toFixed(2)}`;
    live.classList.remove('readout-hint');
  }
}

function updateStatic() {
  const r2 = bci.scores?.[bci.decoder] ?? 0;
  document.getElementById('dec-r2').textContent = r2 > 0 ? `${Math.round(r2 * 100)}%` : 'below 0';
  const stale = bci.day - bci.calibDay;
  const hint = document.getElementById('dec-calib');
  hint.textContent =
    stale > 0
      ? `Calibrated on day ${bci.calibDay}, ${stale} day${stale > 1 ? 's' : ''} ago. The neurons have shifted since then.`
      : `Calibrated on day ${bci.calibDay} with 60 s of practice reaches.`;
  hint.classList.toggle('hint-warn', stale > 0);
  redrawScores();
}

function loop(t) {
  if (!running) return;
  const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0;
  lastT = t;
  view.acc += dt;
  while (view.acc >= BIN_S) {
    view.acc -= BIN_S;
    binStep();
  }
  drawWorkspace();
  drawCompass();
  updateReadouts(t);
  raf = requestAnimationFrame(loop);
}

function recenter() {
  view.dec = [0, 0];
  view.trailD = [];
  resetDecoder();
}

export default {
  mount() {
    initBci();
    workCv = document.getElementById('dec-work');
    compassCv = document.getElementById('dec-compass');
    scoresCv = document.getElementById('dec-scores');
    autoRedraw(workCv, drawWorkspace);
    autoRedraw(compassCv, drawCompass);
    redrawScores = autoRedraw(scoresCv, drawScores);

    workCv.addEventListener('pointermove', (e) => (view.mouse = toWork(e)));
    workCv.addEventListener('pointerleave', () => {
      view.mouse = null;
      view.lastMouse = null;
    });
    workCv.addEventListener('dblclick', recenter);

    decoderSeg = bindSegmented(document.getElementById('dec-decoder'), {
      initial: bci.decoder,
      onChange: (v) => {
        setDecoder(v);
        recenter();
      },
    });
    let nTimer = 0;
    nControl = bindRange('dec-n', {
      initial: bci.neurons,
      format: (v) => `${v}`,
      onInput: (v) => {
        clearTimeout(nTimer);
        nTimer = setTimeout(() => {
          setNeurons(v);
          recenter();
        }, 200);
      },
    });
    let dTimer = 0;
    dayControl = bindRange('dec-day', {
      initial: bci.day,
      format: (v) => `${v} day${v === 1 ? '' : 's'}`,
      onInput: (v) => {
        clearTimeout(dTimer);
        dTimer = setTimeout(() => setDay(v), 60);
      },
    });
    document.getElementById('dec-recal').addEventListener('click', () => {
      calibrate();
      recenter();
    });
    document.getElementById('dec-recenter').addEventListener('click', recenter);

    for (const ev of ['calibrated', 'scored', 'day', 'decoder']) bciEvents.addEventListener(ev, () => running && updateStatic());
  },
  activate() {
    nControl.set(bci.neurons);
    dayControl.set(bci.day);
    decoderSeg.select(bci.decoder);
    recenter();
    updateStatic();
    running = true;
    lastT = 0;
    raf = requestAnimationFrame(loop);
  },
  deactivate() {
    running = false;
    cancelAnimationFrame(raf);
  },
};

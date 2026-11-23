// Stage 2: spike detection and sorting.
// Draggable threshold on the filtered trace, waveform overlay, PCA feature space,
// and an animated k-means run, all scored against ground truth.

import { params, data, events, setParams, scoreClusters, detectionStats } from '../core/pipeline.js';
import { kmeansRandomInit, kmeansStep, kmeansAssign, SNIPPET_PRE, SNIPPET_LEN } from '../core/sorting.js';
import { fitCanvas, autoRedraw, css, alpha, drawTrace, scaleBar, label, unitColor, niceTicks, FONT_MONO } from '../ui/plot.js';
import { bindRange, bindSegmented, fmt } from '../ui/controls.js';

const WINDOW_S = 0.4;
const EVENT_BITS = 20; // 10-bit channel ID + 10-bit timestamp, as in Stage 0
const view = { pos: 0.12, colorBy: 'cluster' };

let traceCv, wavesCv, pcaCv;
let redrawTrace, redrawWaves, redrawPca;
let thrControl, kControl;
let active = false;
let anim = null; // running k-means animation

// Color for detection i under the current coloring mode.
function colorOf(i) {
  if (view.colorBy === 'truth') return unitColor(data.match.detUnit[i]);
  return data.cluster ? unitColor(data.cluster.labels[i]) : css('--trace');
}

function windowRange() {
  const fs = data.fs;
  const n = data.filtered.length;
  const count = Math.round(WINDOW_S * fs);
  const start = Math.round(Math.min(n - count - 2000, Math.max(2000, view.pos * (n - count))));
  return { start, count };
}

// ---------- Threshold trace ----------
let traceGeom = null;
function drawTraceView() {
  if (!data.filtered) return;
  const { ctx, w, h } = fitCanvas(traceCv);
  const { start, count } = windowRange();
  const fs = data.fs;
  const padL = 14, padR = 14, padT = 14, padB = 14;
  const pw = w - padL - padR, ph = h - padT - padB;
  const range = Math.max(data.filtRange, -data.threshold * 1.15, 60);
  const mid = padT + ph * 0.42;
  const scale = Math.min((mid - padT) / (range * 0.9), (padT + ph - mid) / (range * 1.02));
  const yOf = (v) => mid - v * scale;
  const xOf = (i) => padL + ((i - start) / count) * pw;
  traceGeom = { mid, scale };

  ctx.strokeStyle = css('--grid');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, Math.round(mid) + 0.5);
  ctx.lineTo(padL + pw, Math.round(mid) + 0.5);
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, 0, pw, h);
  ctx.clip();
  ctx.strokeStyle = alpha(css('--trace'), 0.9);
  ctx.lineWidth = 1.1;
  drawTrace(ctx, data.filtered, start, count, padL, pw, yOf);

  // missed true spikes: open ring at the true trough
  const bad = css('--bad');
  data.truth.forEach((sp, j) => {
    if (sp.index < start || sp.index >= start + count || data.match.truthHit[j]) return;
    ctx.strokeStyle = bad;
    ctx.lineWidth = 1.75;
    ctx.beginPath();
    ctx.arc(xOf(sp.index), yOf(data.filtered[sp.index]) + 10, 5, 0, Math.PI * 2);
    ctx.stroke();
  });
  // detections: filled marker under the trough
  data.detections.forEach((idx, i) => {
    if (idx < start || idx >= start + count) return;
    const x = xOf(idx), y = yOf(data.filtered[idx]) + 10;
    const fp = data.match.detUnit[i] < 0;
    ctx.fillStyle = colorOf(i);
    if (view.colorBy === 'truth' && fp) {
      ctx.strokeStyle = css('--noise');
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - 4, y - 4);
      ctx.lineTo(x + 4, y + 4);
      ctx.moveTo(x + 4, y - 4);
      ctx.lineTo(x - 4, y + 4);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  ctx.restore();

  // threshold line with handle
  const ty = Math.round(yOf(data.threshold)) + 0.5;
  const accent = css('--accent');
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(padL, ty);
  ctx.lineTo(padL + pw, ty);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.roundRect?.(padL + pw - 10, ty - 7, 10, 14, 3);
  if (!ctx.roundRect) ctx.rect(padL + pw - 10, ty - 7, 10, 14);
  ctx.fill();
  label(ctx, `−${params.threshK.toFixed(1)}σ = ${data.threshold.toFixed(0)} µV`, padL + pw - 16, ty - 4, {
    color: accent,
    bg: alpha(css('--panel'), 0.9),
    align: 'right',
    baseline: 'bottom',
  });
  scaleBar(ctx, padL + 52, padT + ph - 4, pw / (WINDOW_S * 1000), 20, scale, 50, css('--muted'));
  label(ctx, `${(start / fs).toFixed(2)}–${((start + count) / fs).toFixed(2)} s`, padL + 4, padT, { color: css('--faint'), bg: alpha(css('--panel'), 0.85) });
}

function thresholdFromPointer(e) {
  if (!traceGeom) return;
  const r = traceCv.getBoundingClientRect();
  const y = e.clientY - r.top;
  const v = (traceGeom.mid - y) / traceGeom.scale;
  const k = Math.min(9, Math.max(2, -v / data.sigma));
  const rounded = Math.round(k * 10) / 10;
  thrControl.set(rounded);
  setParams({ threshK: rounded });
}

// ---------- Waveform overlay ----------
function drawWaves() {
  if (!data.filtered) return;
  const { ctx, w, h } = fitCanvas(wavesCv);
  const padL = 16, padR = 16, padT = 14, padB = 26;
  const pw = w - padL - padR, ph = h - padT - padB;
  const snips = data.snippets;
  const k = view.colorBy === 'truth' ? data.rec.units.length : data.cluster?.centroids.length ?? 1;
  const groupOf = (i) => (view.colorBy === 'truth' ? data.match.detUnit[i] : data.cluster?.labels[i] ?? 0);

  // means per group for the y-range and the bold overlay
  const means = new Map();
  snips.forEach((s, i) => {
    const g = groupOf(i);
    if (!means.has(g)) means.set(g, { sum: new Float64Array(SNIPPET_LEN), n: 0 });
    const m = means.get(g);
    for (let j = 0; j < SNIPPET_LEN; j++) m.sum[j] += s[j];
    m.n++;
  });
  let lo = data.threshold * 1.4;
  for (const m of means.values()) for (let j = 0; j < SNIPPET_LEN; j++) lo = Math.min(lo, (m.sum[j] / m.n) * 1.45);
  const hi = Math.max(-lo * 0.55, 40);
  const xOf = (j) => padL + (j / (SNIPPET_LEN - 1)) * pw;
  const yOf = (v) => padT + ((hi - v) / (hi - lo)) * ph;

  ctx.strokeStyle = css('--grid');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, Math.round(yOf(0)) + 0.5);
  ctx.lineTo(padL + pw, Math.round(yOf(0)) + 0.5);
  ctx.moveTo(Math.round(xOf(SNIPPET_PRE)) + 0.5, padT);
  ctx.lineTo(Math.round(xOf(SNIPPET_PRE)) + 0.5, padT + ph);
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, padT, pw, ph);
  ctx.clip();
  // draw at most ~250 snippets per group so the plot stays fast and readable
  const counts = new Map();
  const cap = 250;
  ctx.lineWidth = 1;
  snips.forEach((s, i) => {
    const g = groupOf(i);
    const total = means.get(g).n;
    const c = (counts.get(g) ?? 0) + 1;
    counts.set(g, c);
    if (total > cap && c % Math.ceil(total / cap) !== 0) return;
    ctx.strokeStyle = alpha(unitColor(g), g < 0 ? 0.18 : 0.13);
    ctx.beginPath();
    for (let j = 0; j < SNIPPET_LEN; j++) j ? ctx.lineTo(xOf(j), yOf(s[j])) : ctx.moveTo(xOf(j), yOf(s[j]));
    ctx.stroke();
  });
  ctx.lineWidth = 2.5;
  for (const [g, m] of means) {
    if (g < 0) continue;
    ctx.strokeStyle = unitColor(g);
    ctx.beginPath();
    for (let j = 0; j < SNIPPET_LEN; j++) {
      const v = m.sum[j] / m.n;
      j ? ctx.lineTo(xOf(j), yOf(v)) : ctx.moveTo(xOf(j), yOf(v));
    }
    ctx.stroke();
  }
  ctx.restore();

  ctx.strokeStyle = css('--accent');
  ctx.lineWidth = 1.25;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(padL, Math.round(yOf(data.threshold)) + 0.5);
  ctx.lineTo(padL + pw, Math.round(yOf(data.threshold)) + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);

  const pxPerMs = pw / ((SNIPPET_LEN - 1) / data.fs) / 1000;
  scaleBar(ctx, padL + pw - 66, padT + ph - 2, pxPerMs, 0.5, ph / (hi - lo), 50, css('--muted'));
  document.getElementById('sort-waves-meta').textContent = `${fmt.int(snips.length)} spikes · ${k} ${view.colorBy === 'truth' ? 'neurons' : 'groups'}`;
}

// ---------- PCA scatter ----------
function drawPca() {
  if (!data.pca) return;
  const { ctx, w, h } = fitCanvas(pcaCv);
  const pts = data.pca.scores;
  const padL = 40, padR = 14, padT = 14, padB = 34;
  const pw = w - padL - padR, ph = h - padT - padB;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [a, b] of pts) {
    x0 = Math.min(x0, a); x1 = Math.max(x1, a);
    y0 = Math.min(y0, b); y1 = Math.max(y1, b);
  }
  if (!pts.length) { x0 = y0 = -1; x1 = y1 = 1; }
  const px = (x1 - x0) * 0.06 || 1, py = (y1 - y0) * 0.06 || 1;
  x0 -= px; x1 += px; y0 -= py; y1 += py;
  const xOf = (v) => padL + ((v - x0) / (x1 - x0)) * pw;
  const yOf = (v) => padT + ((y1 - v) / (y1 - y0)) * ph;
  const faint = css('--faint'), grid = css('--grid');

  ctx.font = `11px ${FONT_MONO}`;
  ctx.lineWidth = 1;
  for (const t of niceTicks(x0, x1, 4)) {
    const x = Math.round(xOf(t)) + 0.5;
    ctx.strokeStyle = grid;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ph); ctx.stroke();
    ctx.fillStyle = faint; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(String(Math.round(t)), x, padT + ph + 5);
  }
  for (const t of niceTicks(y0, y1, 4)) {
    const y = Math.round(yOf(t)) + 0.5;
    ctx.strokeStyle = grid;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + pw, y); ctx.stroke();
    ctx.fillStyle = faint; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.round(t)), padL - 6, y);
  }
  const ev = data.pca.explained.map((e) => Math.round(e * 100));
  ctx.fillStyle = faint;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`PC1 (${ev[0] ?? 0}% of variance)`, padL + pw / 2, h - 2);
  ctx.save();
  ctx.translate(11, padT + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textBaseline = 'middle';
  ctx.fillText(`PC2 (${ev[1] ?? 0}%)`, 0, 0);
  ctx.restore();

  const r = pts.length > 1500 ? 1.8 : 2.4;
  pts.forEach(([a, b], i) => {
    ctx.fillStyle = alpha(colorOf(i), 0.7);
    ctx.beginPath();
    ctx.arc(xOf(a), yOf(b), r, 0, Math.PI * 2);
    ctx.fill();
  });

  if (view.colorBy === 'cluster' && data.cluster) {
    const panel = css('--panel');
    data.cluster.centroids.forEach((c, k) => {
      const x = xOf(c[0]), y = yOf(c[1]);
      ctx.fillStyle = panel;
      ctx.strokeStyle = unitColor(k);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 4, y); ctx.lineTo(x + 4, y);
      ctx.moveTo(x, y - 4); ctx.lineTo(x, y + 4);
      ctx.stroke();
    });
  }
}

// ---------- Stats + legend ----------
function setStat(id, text, cls) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = `stat-value${cls ? ` ${cls}` : ''}`;
}
const grade = (v, good, ok) => (v >= good ? 'good' : v >= ok ? 'warn' : 'bad');

function updateStats() {
  const st = detectionStats();
  setStat('st-sigma', `${data.sigma.toFixed(1)} µV`);
  setStat('st-thr', `${data.threshold.toFixed(0)} µV`);
  setStat('st-det', fmt.int(st.detected));
  setStat('st-recall', fmt.pct(st.recall), grade(st.recall, 0.9, 0.75));
  setStat('st-prec', fmt.pct(st.precision), grade(st.precision, 0.9, 0.75));
  const acc = data.accuracy?.accuracy ?? 0;
  setStat('st-acc', fmt.pct(acc), grade(acc, 0.9, 0.75));
  const seconds = (data.filtered.length - 4000) / data.fs;
  setStat('st-rate', `${fmt.bps((st.detected / seconds) * EVENT_BITS)}`);
  document.getElementById('st-rate').title = 'Spike events × 20 bits, versus 200 kb/s for raw samples';
}

function updateLegend() {
  const ul = document.getElementById('sort-legend');
  const items = [];
  if (view.colorBy === 'truth') {
    data.rec.units.forEach((u, k) => items.push([`var(--u${k + 1})`, `Neuron ${u.id}`]));
    items.push(['var(--noise)', 'Noise, not a real spike']);
  } else {
    const k = data.cluster?.centroids.length ?? 0;
    for (let c = 0; c < k; c++) items.push([`var(--u${c + 1})`, `Group ${c + 1}`]);
  }
  ul.innerHTML = items.map(([c, t]) => `<li><span class="swatch" style="background:${c}"></span>${t}</li>`).join('') +
    '<li><span class="swatch swatch-ring"></span>Missed spike</li>';
}

function redrawAll() {
  redrawTrace();
  redrawWaves();
  redrawPca();
  updateStats();
  updateLegend();
}

// ---------- Animated k-means ----------
function stopAnim(message) {
  if (anim) {
    clearTimeout(anim.timer);
    anim = null;
    document.getElementById('sort-run').disabled = false;
  }
  if (message) document.getElementById('sort-status').textContent = message;
}

function runKmeans() {
  stopAnim();
  const pts = data.pca.scores;
  if (pts.length < params.k) return;
  // Plain random initialization, one run: sometimes it gets stuck, which is the lesson.
  const seed = (Date.now() % 100000) + 1;
  let centroids = kmeansRandomInit(pts, params.k, seed);
  data.cluster = { centroids, ...kmeansAssign(pts, centroids) };
  scoreClusters();
  view.colorBy = 'cluster';
  colorSeg.select('cluster');
  redrawAll();
  const btn = document.getElementById('sort-run');
  const status = document.getElementById('sort-status');
  btn.disabled = true;
  anim = { iter: 0, timer: 0 };
  const tick = () => {
    if (!anim) return;
    const res = kmeansStep(pts, data.cluster.centroids);
    anim.iter++;
    data.cluster = res;
    scoreClusters();
    redrawAll();
    status.textContent = `Iteration ${anim.iter} · centroids moved ${res.shift.toFixed(1)}`;
    if (res.shift < 0.05 || anim.iter >= 40) {
      stopAnim(`Converged in ${anim.iter} iterations · one random start`);
    } else {
      anim.timer = setTimeout(tick, 550);
    }
  };
  status.textContent = 'Random starting centroids';
  anim.timer = setTimeout(tick, 700);
}

let colorSeg;

export default {
  mount() {
    traceCv = document.getElementById('sort-trace');
    wavesCv = document.getElementById('sort-waves');
    pcaCv = document.getElementById('sort-pca');
    redrawTrace = autoRedraw(traceCv, drawTraceView);
    redrawWaves = autoRedraw(wavesCv, drawWaves);
    redrawPca = autoRedraw(pcaCv, drawPca);

    thrControl = bindRange('sort-k', {
      initial: params.threshK,
      format: (v) => `${v.toFixed(1)} σ`,
      onInput: (v) => setParams({ threshK: v }),
    });
    bindRange('sort-pos', {
      toValue: (s) => s / 1000,
      fromValue: (v) => v * 1000,
      initial: view.pos,
      format: (v) => `${(v * (data.rec?.duration ?? 20)).toFixed(1)} s`,
      onInput: (v) => {
        view.pos = v;
        redrawTrace();
      },
    });
    kControl = bindSegmented(document.getElementById('sort-kclusters'), {
      initial: params.k,
      onChange: (v) => setParams({ k: +v }),
    });
    colorSeg = bindSegmented(document.getElementById('sort-color'), {
      initial: view.colorBy,
      onChange: (v) => {
        view.colorBy = v;
        redrawAll();
      },
    });
    const scenario = bindSegmented(document.getElementById('sort-scenario'), {
      initial: params.units,
      onChange: (v) => setParams({ units: v }),
    });
    document.getElementById('sort-run').addEventListener('click', runKmeans);

    // Drag the threshold directly on the trace.
    let dragging = false;
    traceCv.addEventListener('pointerdown', (e) => {
      dragging = true;
      traceCv.setPointerCapture(e.pointerId);
      thresholdFromPointer(e);
    });
    traceCv.addEventListener('pointermove', (e) => dragging && thresholdFromPointer(e));
    const end = () => (dragging = false);
    traceCv.addEventListener('pointerup', end);
    traceCv.addEventListener('pointercancel', end);

    events.addEventListener('update', () => {
      stopAnim('Best of 10 runs');
      if (active) redrawAll();
    });
    this.sync = () => {
      thrControl.set(params.threshK);
      kControl.select(params.k);
      scenario.select(params.units);
    };
  },
  activate() {
    active = true;
    this.sync();
    redrawAll();
  },
  deactivate() {
    active = false;
    stopAnim('Best of 10 runs');
  },
};

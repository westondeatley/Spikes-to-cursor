// Stage 0: the bandwidth problem.
// A live electrode array (threads x 16 electrodes) plus a calculator comparing
// what different data formats cost to transmit against the radio budget.

import { fitCanvas, autoRedraw, css, alpha, FONT_MONO, FONT_SANS, decadeTicks } from '../ui/plot.js';
import { bindRange, logScale, fmt } from '../ui/controls.js';
import { makeRng } from '../core/rng.js';

const ELECTRODES_PER_THREAD = 16; // N1 implant: 64 threads x 16 electrodes = 1,024 channels
const s = { ch: 1024, fsK: 20, bits: 10, radio: 1e6, rate: 20, bin: 20 };

let arrayCanvas, barsCanvas, redrawBars;
let running = false;
let raf = 0;
let lastT = 0;
let simT = 0;
let intensity = new Float32Array(0);
let baseRate = new Float32Array(0);
const rng = makeRng(42);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Data rate of each way of packaging the neural activity, in bits/s. */
export function formats(p = s) {
  const idBits = Math.ceil(Math.log2(Math.max(2, p.ch)));
  const tsBits = 10; // timestamp within a 50 ms frame at 20 kHz: 1,000 slots
  return [
    { name: 'Raw voltage', detail: `every sample, ${p.bits}-bit`, bps: p.ch * p.fsK * 1000 * p.bits },
    { name: 'Spike waveforms', detail: '32 samples per spike', bps: p.ch * p.rate * (idBits + tsBits + 32 * p.bits) },
    { name: 'Spike events', detail: 'channel ID + timestamp', bps: p.ch * p.rate * (idBits + tsBits) },
    { name: 'Binned counts', detail: `spikes per ${p.bin} ms, 4-bit`, bps: p.ch * (1000 / p.bin) * 4 },
  ];
}

function resizeArray() {
  const n = s.ch;
  intensity = new Float32Array(n);
  baseRate = new Float32Array(n);
  // Log-normal firing rates: most channels quiet, a few very active, as in cortex.
  for (let i = 0; i < n; i++) baseRate[i] = Math.exp(rng.normal() * 0.8);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += baseRate[i] / n;
  for (let i = 0; i < n; i++) baseRate[i] /= mean;
}

function updateReadouts() {
  const raw = formats()[0].bps;
  document.getElementById('bw-raw').textContent = fmt.bps(raw);
  document.getElementById('bw-radio').textContent = fmt.bps(s.radio);
  const ratio = raw / s.radio;
  document.getElementById('bw-ratio').textContent = ratio >= 1 ? `${fmt.int(ratio)}×` : 'none';
  const threads = Math.ceil(s.ch / ELECTRODES_PER_THREAD);
  document.getElementById('array-meta').textContent = `${threads} thread${threads > 1 ? 's' : ''} × ${ELECTRODES_PER_THREAD} electrodes`;
}

function drawArray(dt = 0) {
  const { ctx, w, h } = fitCanvas(arrayCanvas);
  const rows = ELECTRODES_PER_THREAD;
  const cols = Math.ceil(s.ch / rows);
  const padX = 14, padY = 14;
  const cw = (w - 2 * padX) / cols;
  const chh = (h - 2 * padY - 16) / rows;
  const gap = Math.min(2, cw * 0.18);
  const base = css('--grid');
  const hot = css('--accent');
  const decay = Math.exp(-dt / 0.045);

  for (let i = 0; i < s.ch; i++) {
    const c = Math.floor(i / rows);
    const r = i % rows;
    if (dt > 0) {
      // A slow traveling wave across threads modulates firing, like a cortical wave.
      const wave = 1 + 0.8 * Math.sin(2 * Math.PI * (0.35 * simT - c / Math.max(8, cols / 2)));
      intensity[i] *= decay;
      if (rng.uniform() < s.rate * baseRate[i] * wave * dt) intensity[i] = 1;
    }
    const x = padX + c * cw;
    const y = padY + r * chh;
    ctx.fillStyle = base;
    ctx.fillRect(x, y, cw - gap, chh - gap);
    if (intensity[i] > 0.02) {
      ctx.fillStyle = alpha(hot, intensity[i]);
      ctx.fillRect(x, y, cw - gap, chh - gap);
    }
  }
  ctx.font = `11px ${FONT_MONO}`;
  ctx.fillStyle = css('--faint');
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  ctx.fillText('← threads →', padX, h - 4);
  ctx.textAlign = 'right';
  ctx.fillText(`${fmt.int(s.ch)} channels`, w - padX, h - 4);
}

function drawBars() {
  const { ctx, w, h } = fitCanvas(barsCanvas);
  const rows = formats();
  const narrow = w < 520;
  const labelX = 14;
  const left = narrow ? 128 : 186;
  const right = 34;
  const top = 30;
  const bottom = 26;
  const lo = 1e4, hi = 1e10;
  const xOf = (v) => left + ((Math.log10(Math.max(lo, v)) - 4) / (Math.log10(hi) - 4)) * (w - left - right);
  const rowH = (h - top - bottom) / rows.length;

  const ink = css('--ink'), muted = css('--muted'), faint = css('--faint'), grid = css('--grid');
  const good = css('--accent'), bad = css('--bad'), panel = css('--panel');

  // decade grid
  ctx.font = `11px ${FONT_MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of decadeTicks(lo, hi)) {
    const x = xOf(t);
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, top - 6);
    ctx.lineTo(x + 0.5, h - bottom);
    ctx.stroke();
    if (!narrow || Math.log10(t) % 2 === 0) {
      ctx.fillStyle = faint;
      ctx.fillText(fmt.bps(t).replace('.0', ''), x, h - bottom + 6);
    }
  }

  rows.forEach((r, i) => {
    const yMid = top + rowH * i + rowH / 2;
    const fits = r.bps <= s.radio;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = ink;
    ctx.font = `600 ${narrow ? 12 : 13}px ${FONT_SANS}`;
    ctx.fillText(r.name, labelX, yMid - 2);
    ctx.fillStyle = faint;
    ctx.font = `${narrow ? 10.5 : 11.5}px ${FONT_SANS}`;
    ctx.fillText(r.detail, labelX, yMid + 13);

    const barH = Math.min(22, rowH * 0.5);
    const x1 = xOf(r.bps);
    ctx.fillStyle = alpha(fits ? good : bad, 0.85);
    ctx.fillRect(left, yMid - barH / 2, Math.max(2, x1 - left), barH);

    const text = `${fmt.bps(r.bps)}  ${fits ? 'fits' : `${fmt.int(r.bps / s.radio)}× over`}`;
    ctx.font = `500 12px ${FONT_MONO}`;
    const tw = ctx.measureText(text).width;
    const inside = x1 + 8 + tw > w - 4;
    ctx.textBaseline = 'middle';
    if (inside) {
      ctx.textAlign = 'right';
      ctx.fillStyle = panel;
      ctx.fillText(text, x1 - 8, yMid);
    } else {
      ctx.textAlign = 'left';
      ctx.fillStyle = fits ? muted : bad;
      ctx.fillText(text, x1 + 8, yMid);
    }
  });

  // radio budget line
  const xr = Math.round(xOf(s.radio)) + 0.5;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(xr, top - 8);
  ctx.lineTo(xr, h - bottom);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = ink;
  ctx.font = `600 12px ${FONT_SANS}`;
  ctx.textBaseline = 'bottom';
  ctx.textAlign = xr > w - 140 ? 'right' : 'left';
  ctx.fillText(`Radio budget ${fmt.bps(s.radio)}`, xr + (ctx.textAlign === 'left' ? 6 : -6), top - 10);
}

function loop(t) {
  if (!running) return;
  const dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 0;
  lastT = t;
  simT += dt;
  drawArray(dt);
  raf = requestAnimationFrame(loop);
}

function refresh() {
  updateReadouts();
  redrawBars();
}

export default {
  mount() {
    arrayCanvas = document.getElementById('array-canvas');
    barsCanvas = document.getElementById('bw-bars');
    resizeArray();
    autoRedraw(arrayCanvas, () => drawArray(0));
    redrawBars = autoRedraw(barsCanvas, drawBars);

    bindRange('bw-ch', {
      initial: s.ch,
      format: fmt.int,
      onInput: (v) => {
        s.ch = v;
        resizeArray();
        drawArray(0);
        refresh();
      },
    });
    bindRange('bw-fs', { initial: s.fsK, format: (v) => `${v} kHz`, onInput: (v) => ((s.fsK = v), refresh()) });
    bindRange('bw-bits', { initial: s.bits, format: (v) => `${v} bits`, onInput: (v) => ((s.bits = v), refresh()) });
    bindRange('bw-radio-in', {
      ...logScale(1e5, 1e7),
      initial: s.radio,
      format: fmt.bps,
      onInput: (v) => ((s.radio = v), refresh()),
    });
    bindRange('bw-rate', { initial: s.rate, format: (v) => `${v} Hz`, onInput: (v) => ((s.rate = v), refresh()) });
    bindRange('bw-bin', { initial: s.bin, format: (v) => `${v} ms`, onInput: (v) => ((s.bin = v), refresh()) });
    updateReadouts();
    // Warm the array up so the first frame already shows activity.
    for (let i = 0; i < 20; i++) {
      simT += 0.016;
      for (let k = 0; k < s.ch; k++) if (rng.uniform() < s.rate * baseRate[k] * 0.016) intensity[k] = rng.uniform() * 0.8;
    }
  },
  activate() {
    if (reducedMotion) return drawArray(0);
    running = true;
    lastT = 0;
    raf = requestAnimationFrame(loop);
  },
  deactivate() {
    running = false;
    cancelAnimationFrame(raf);
  },
};

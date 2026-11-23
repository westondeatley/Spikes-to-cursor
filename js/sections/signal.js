// Stage 1: raw signal and filtering.
// Scrolling raw and band-passed traces, a power spectrum with the filter response,
// and one neuron's waveform before/after filtering (causal vs zero-phase).

import { params, data, events, setParams } from '../core/pipeline.js';
import { welchPSD, sosMagnitude, sosFilter, sosFiltFilt } from '../core/dsp.js';
import { fitCanvas, autoRedraw, css, alpha, drawTrace, scaleBar, label, unitColor, decadeTicks, formatHz, FONT_MONO } from '../ui/plot.js';
import { bindRange, bindSegmented, bindSwitch, logScale, fmt } from '../ui/controls.js';

const WINDOW_S = 0.2; // visible window: 200 ms
const view = { t: 1.2, speed: 0.25, playing: true, showTruth: true, unit: 0 };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let rawCv, filtCv, psdCv, waveCv;
let redrawPsd, redrawWave;
let running = false;
let raf = 0;
let lastT = 0;
let rawPsd = null;
let filtPsd = null;
let psdFor = { rec: null, filtered: null };
let controls = {};

// ---------- Scrolling traces ----------
function drawScope(canvas, x, range, { color, title, truth = false, barUv }) {
  const { ctx, w, h } = fitCanvas(canvas);
  const fs = data.fs;
  const count = Math.round(WINDOW_S * fs);
  const end = Math.round(view.t * fs);
  const start = Math.max(0, end - count);
  const padL = 14, padR = 14, padT = truth ? 22 : 12, padB = 12;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const mid = padT + plotH / 2;
  const scale = plotH / 2 / (range * 1.08);
  const yOf = (v) => mid - v * scale;

  // time grid every 20 ms, aligned to absolute time so it scrolls with the data
  ctx.strokeStyle = css('--grid');
  ctx.lineWidth = 1;
  const t0 = start / fs;
  for (let g = Math.ceil(t0 / 0.02) * 0.02; g < t0 + WINDOW_S; g += 0.02) {
    const gx = Math.round(padL + ((g - t0) / WINDOW_S) * plotW) + 0.5;
    ctx.beginPath();
    ctx.moveTo(gx, padT);
    ctx.lineTo(gx, h - padB);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(padL, Math.round(mid) + 0.5);
  ctx.lineTo(w - padR, Math.round(mid) + 0.5);
  ctx.stroke();

  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, 0, plotW, h);
  ctx.clip();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  ctx.lineJoin = 'round';
  drawTrace(ctx, x, start, count, padL, plotW, yOf);

  if (truth && view.showTruth) {
    for (const sp of data.rec.truth) {
      if (sp.index < start) continue;
      if (sp.index >= start + count) break;
      const px = padL + ((sp.index - start) / count) * plotW;
      ctx.fillStyle = unitColor(sp.unit);
      ctx.beginPath();
      ctx.moveTo(px, padT - 6);
      ctx.lineTo(px - 4, padT - 14);
      ctx.lineTo(px + 4, padT - 14);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();

  scaleBar(ctx, padL + 52, h - padB - 14, plotW / (WINDOW_S * 1000), 20, scale, barUv, css('--muted'));
  label(ctx, title, w - padR - 2, padT, { color: css('--faint'), bg: alpha(css('--panel'), 0.85), align: 'right' });
}

function drawTraces() {
  if (!data.rec) return;
  const rawBar = data.rawRange > 500 ? 200 : 100;
  const filtBar = data.filtRange > 220 ? 100 : 50;
  drawScope(rawCv, data.rec.raw, data.rawRange, { color: css('--trace'), title: `t = ${view.t.toFixed(2)} s`, barUv: rawBar });
  drawScope(filtCv, data.filtered, data.filtRange, { color: css('--accent'), title: '', truth: true, barUv: filtBar });
}

// ---------- Power spectrum ----------
function logBin(psd, nPts = 320, fLo = 1, fHi = 10000) {
  const out = [];
  const df = psd.freqs[1];
  for (let i = 0; i < nPts; i++) {
    const a = fLo * (fHi / fLo) ** (i / nPts);
    const b = fLo * (fHi / fLo) ** ((i + 1) / nPts);
    const k0 = Math.max(1, Math.floor(a / df));
    const k1 = Math.max(k0 + 1, Math.ceil(b / df));
    let sum = 0, peak = 0;
    for (let k = k0; k < k1 && k < psd.psd.length; k++) {
      sum += psd.psd[k];
      peak = Math.max(peak, psd.psd[k]);
    }
    // Keep narrow peaks (like 60 Hz) visible when many bins merge into one point.
    out.push({ f: Math.sqrt(a * b), p: Math.max(sum / (k1 - k0), peak * 0.5) });
  }
  return out;
}

function ensurePsd() {
  if (psdFor.rec !== data.rec) {
    rawPsd = logBin(welchPSD(data.rec.raw, data.fs, 8192, data.fs * 8));
    psdFor.rec = data.rec;
  }
  if (psdFor.filtered !== data.filtered) {
    filtPsd = logBin(welchPSD(data.filtered, data.fs, 8192, data.fs * 8));
    psdFor.filtered = data.filtered;
  }
}

function drawPsd() {
  if (!data.rec) return;
  ensurePsd();
  const { ctx, w, h } = fitCanvas(psdCv);
  const padL = 44, padR = 40, padT = 16, padB = 30;
  const pw = w - padL - padR, ph = h - padT - padB;
  const fLo = 1, fHi = 10000, dbLo = -45, dbHi = 45;
  const xOf = (f) => padL + (Math.log10(f / fLo) / Math.log10(fHi / fLo)) * pw;
  const yOf = (db) => padT + ((dbHi - db) / (dbHi - dbLo)) * ph;
  const muted = css('--muted'), faint = css('--faint'), grid = css('--grid');

  // passband shading
  ctx.fillStyle = alpha(css('--accent'), 0.08);
  ctx.fillRect(xOf(params.low), padT, xOf(params.high) - xOf(params.low), ph);

  ctx.font = `11px ${FONT_MONO}`;
  ctx.lineWidth = 1;
  for (const f of decadeTicks(fLo, fHi)) {
    const x = Math.round(xOf(f)) + 0.5;
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + ph);
    ctx.stroke();
    ctx.fillStyle = faint;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(formatHz(f), x, padT + ph + 8);
  }
  for (let db = -40; db <= 40; db += 20) {
    const y = Math.round(yOf(db)) + 0.5;
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + pw, y);
    ctx.stroke();
    ctx.fillStyle = faint;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${db}`, padL - 6, y);
  }
  ctx.save();
  ctx.translate(12, padT + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillStyle = faint;
  ctx.fillText('dB re 1 µV²/Hz', 0, 0);
  ctx.restore();

  const plotLine = (pts, color, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    let first = true;
    for (const { f, p } of pts) {
      const db = Math.max(dbLo - 5, 10 * Math.log10(p + 1e-12));
      const x = xOf(f), y = yOf(db);
      first ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      first = false;
    }
    ctx.stroke();
  };
  ctx.save();
  ctx.beginPath();
  ctx.rect(padL, padT, pw, ph);
  ctx.clip();
  plotLine(rawPsd, alpha(css('--trace'), 0.55), 1.25);
  plotLine(filtPsd, css('--accent'), 1.75);

  // filter gain on the right axis (0 to -80 dB)
  const freqs = rawPsd.map((d) => d.f);
  let mag = sosMagnitude(data.sos, freqs, data.fs);
  const zp = params.phase === 'zerophase';
  ctx.strokeStyle = muted;
  ctx.lineWidth = 1.25;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  freqs.forEach((f, i) => {
    let g = 20 * Math.log10(mag[i] + 1e-12) * (zp ? 2 : 1);
    g = Math.max(-80, g);
    const y = padT + (-g / 80) * ph;
    i ? ctx.lineTo(xOf(f), y) : ctx.moveTo(xOf(f), y);
  });
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  ctx.fillStyle = faint;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const g of [0, -40, -80]) ctx.fillText(`${g}`, padL + pw + 6, padT + (-g / 80) * ph);

  const bg = alpha(css('--panel'), 0.85);
  label(ctx, 'LFP', xOf(5), yOf(41), { color: muted, bg, align: 'center' });
  if (params.lineNoise) label(ctx, '60 Hz', xOf(60), yOf(33), { color: muted, bg, align: 'center' });
  label(ctx, 'spikes', xOf(Math.sqrt(params.low * params.high)), yOf(-12), { color: css('--accent'), bg, align: 'center' });
  label(ctx, 'filter gain', padL + pw - 4, padT + 4, { color: muted, bg, align: 'right' });
}

// ---------- One spike, before and after ----------
function filteredTemplate(k) {
  const { wave, zero } = data.rec.templates[k];
  const pad = 400;
  const x = new Float32Array(wave.length + 2 * pad);
  x.set(wave, pad);
  const y = params.phase === 'causal' ? sosFilter(data.sos, x) : sosFiltFilt(data.sos, x);
  return { raw: wave, filt: y.subarray(pad, pad + wave.length), zero };
}

function drawWave() {
  if (!data.rec) return;
  const { ctx, w, h } = fitCanvas(waveCv);
  const { raw, filt, zero } = filteredTemplate(view.unit);
  const fs = data.fs;
  const padL = 18, padR = 16, padT = 16, padB = 56;
  const pw = w - padL - padR, ph = h - padT - padB;
  let lo = 0, hi = 0;
  for (let i = 0; i < raw.length; i++) {
    lo = Math.min(lo, raw[i], filt[i]);
    hi = Math.max(hi, raw[i], filt[i]);
  }
  lo *= 1.12;
  hi = Math.max(hi * 1.25, -lo * 0.35);
  const xOf = (i) => padL + (i / (raw.length - 1)) * pw;
  const yOf = (v) => padT + ((hi - v) / (hi - lo)) * ph;

  ctx.strokeStyle = css('--grid');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, Math.round(yOf(0)) + 0.5);
  ctx.lineTo(padL + pw, Math.round(yOf(0)) + 0.5);
  ctx.moveTo(Math.round(xOf(zero)) + 0.5, padT);
  ctx.lineTo(Math.round(xOf(zero)) + 0.5, padT + ph);
  ctx.stroke();

  const line = (arr, color, width, dash) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath();
    for (let i = 0; i < arr.length; i++) i ? ctx.lineTo(xOf(i), yOf(arr[i])) : ctx.moveTo(xOf(i), yOf(arr[i]));
    ctx.stroke();
    ctx.setLineDash([]);
  };
  line(raw, css('--faint'), 1.5, [5, 4]);
  line(filt, unitColor(view.unit), 2.25, []);

  let iRaw = 0, iF = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] < raw[iRaw]) iRaw = i;
    if (filt[i] < filt[iF]) iF = i;
  }
  const pxPerMs = pw / ((raw.length - 1) / fs) / 1000;
  scaleBar(ctx, padL + pw - 70, padT + ph - 6, pxPerMs, 0.5, ph / (hi - lo), 50, css('--muted'));

  // readout under the plot
  const shiftMs = ((iF - iRaw) / fs) * 1000;
  const kept = filt[iF] / raw[iRaw];
  ctx.font = `12px ${FONT_MONO}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = css('--muted');
  ctx.fillText(`trough  ${raw[iRaw].toFixed(0)} → ${filt[iF].toFixed(0)} µV  (${Math.round(kept * 100)}% kept)`, padL, h - padB + 12);
  ctx.fillText(`shift   ${shiftMs >= 0 ? '+' : ''}${shiftMs.toFixed(2)} ms`, padL, h - padB + 30);
  ctx.textAlign = 'right';
  ctx.fillStyle = css('--faint');
  ctx.fillText('- - before', w - padR, h - padB + 12);
  ctx.fillStyle = unitColor(view.unit);
  ctx.fillText('—— after', w - padR, h - padB + 30);
}

// ---------- Animation ----------
function loop(t) {
  if (!running) return;
  const dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 0;
  lastT = t;
  if (view.playing) {
    view.t += dt * view.speed;
    if (view.t > data.rec.duration - 0.15) view.t = 0.3;
  }
  drawTraces();
  raf = requestAnimationFrame(loop);
}

function setPlaying(p) {
  view.playing = p;
  const btn = document.getElementById('sig-play');
  btn.textContent = p ? 'Pause' : 'Play';
  btn.setAttribute('aria-pressed', String(p));
}

function updateMeta() {
  const phase = params.phase === 'causal' ? 'causal' : 'zero-phase';
  document.getElementById('sig-filt-meta').textContent = `${fmt.hz(params.low)} – ${fmt.hz(params.high)}, ${phase}`;
}

function syncControls() {
  controls.low.set(params.low);
  controls.high.set(params.high);
  controls.order.select(params.order);
  controls.phase.select(params.phase);
  controls.noise.set(params.noiseLevel);
  document.getElementById('sig-line').checked = params.lineNoise;
  updateMeta();
}

export default {
  mount() {
    rawCv = document.getElementById('sig-raw');
    filtCv = document.getElementById('sig-filt');
    psdCv = document.getElementById('sig-psd');
    waveCv = document.getElementById('sig-wave');
    autoRedraw(rawCv, drawTraces);
    autoRedraw(filtCv, drawTraces);
    redrawPsd = autoRedraw(psdCv, drawPsd);
    redrawWave = autoRedraw(waveCv, drawWave);

    controls.low = bindRange('sig-low', {
      ...logScale(10, 2000),
      format: fmt.hz,
      initial: params.low,
      onInput: (v) => setParams({ low: Math.min(v, params.high * 0.8) }),
    });
    controls.high = bindRange('sig-high', {
      ...logScale(1000, 9500),
      format: fmt.hz,
      initial: params.high,
      onInput: (v) => setParams({ high: Math.max(v, params.low * 1.25) }),
    });
    controls.order = bindSegmented(document.getElementById('sig-order'), {
      initial: params.order,
      onChange: (v) => setParams({ order: +v }),
    });
    controls.phase = bindSegmented(document.getElementById('sig-phase'), {
      initial: params.phase,
      onChange: (v) => setParams({ phase: v }),
    });
    let noiseTimer = 0;
    controls.noise = bindRange('sig-noise', {
      initial: params.noiseLevel,
      format: (v) => `${v.toFixed(1)}×`,
      onInput: (v) => {
        clearTimeout(noiseTimer);
        noiseTimer = setTimeout(() => setParams({ noiseLevel: v }), 120);
      },
    });
    bindSwitch('sig-line', { initial: params.lineNoise, onChange: (v) => setParams({ lineNoise: v }) });
    bindSwitch('sig-truth', {
      initial: view.showTruth,
      onChange: (v) => {
        view.showTruth = v;
        drawTraces();
      },
    });
    bindSegmented(document.getElementById('sig-unit'), {
      initial: view.unit,
      onChange: (v) => {
        view.unit = +v;
        redrawWave();
      },
    });
    bindSegmented(document.getElementById('sig-speed'), {
      initial: view.speed,
      onChange: (v) => (view.speed = +v),
    });
    document.getElementById('sig-play').addEventListener('click', () => setPlaying(!view.playing));
    if (reducedMotion) setPlaying(false);

    events.addEventListener('update', () => {
      if (!running) return;
      updateMeta();
      drawTraces();
      redrawPsd();
      redrawWave();
    });
  },
  activate() {
    syncControls();
    running = true;
    lastT = 0;
    redrawPsd();
    redrawWave();
    raf = requestAnimationFrame(loop);
  },
  deactivate() {
    running = false;
    cancelAnimationFrame(raf);
  },
};

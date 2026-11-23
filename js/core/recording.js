// Synthetic extracellular recording from one electrode.
// The voltage is a sum of the things a real microelectrode picks up:
//   local field potential (slow, large) + 60 Hz mains pickup + thermal noise
//   + small spikes from many distant neurons ("multi-unit hash")
//   + large spikes from a few nearby neurons (the ones we want to find).
// Because we built it, we know every true spike time: that ground truth lets the
// app score detection and sorting, which you can never do with real data.

import { makeRng } from './rng.js';

export const FS = 20000; // samples per second (Neuralink N1: ~20 kHz)

/**
 * Nearby neurons. Each waveform is a sharp negative trough (sodium influx)
 * followed by a slower positive hump (repolarization), parameterized in ms and microvolts.
 *   amp: trough depth, w1: trough width, hump: hump size relative to amp,
 *   d: hump delay after trough, w2: hump width, rate: mean firing rate (Hz).
 */
export const UNIT_SETS = {
  distinct: [
    { id: 'A', amp: 165, w1: 0.11, hump: 0.32, d: 0.42, w2: 0.28, rate: 11 },
    { id: 'B', amp: 115, w1: 0.19, hump: 0.14, d: 0.58, w2: 0.46, rate: 18 },
    { id: 'C', amp: 82, w1: 0.075, hump: 0.7, d: 0.24, w2: 0.16, rate: 26 },
  ],
  // B and C are recorded from similar distances with similar shapes: much harder to separate.
  lookalike: [
    { id: 'A', amp: 165, w1: 0.11, hump: 0.32, d: 0.42, w2: 0.28, rate: 11 },
    { id: 'B', amp: 108, w1: 0.16, hump: 0.22, d: 0.5, w2: 0.38, rate: 18 },
    { id: 'C', amp: 94, w1: 0.145, hump: 0.27, d: 0.47, w2: 0.35, rate: 26 },
  ],
};

export const TEMPLATE_PRE_MS = 1.0;
export const TEMPLATE_POST_MS = 2.5;

/** Sampled spike waveform. Index `zero` is the trough. */
export function spikeTemplate(u, fs = FS) {
  const pre = Math.round((TEMPLATE_PRE_MS * fs) / 1000);
  const post = Math.round((TEMPLATE_POST_MS * fs) / 1000);
  const w = new Float32Array(pre + post + 1);
  for (let i = 0; i < w.length; i++) {
    const t = ((i - pre) / fs) * 1000; // ms
    w[i] =
      -u.amp * Math.exp(-0.5 * (t / u.w1) ** 2) +
      u.hump * u.amp * Math.exp(-0.5 * ((t - u.d) / u.w2) ** 2);
  }
  return { wave: w, zero: pre };
}

/** Poisson spike train with an absolute refractory period. Returns sample indices. */
function spikeTrain(rng, rate, n, fs, refractoryMs = 2.5) {
  const out = [];
  const ref = refractoryMs / 1000;
  // Choose the Poisson rate so the effective rate (with refractoriness) equals `rate`.
  const lam = rate / Math.max(0.05, 1 - rate * ref);
  let t = rng.exponential(lam);
  const end = n / fs;
  while (t < end) {
    out.push(Math.round(t * fs));
    t += ref + rng.exponential(lam);
  }
  return out;
}

function stamp(x, idx, tpl, gain) {
  const { wave, zero } = tpl;
  const start = idx - zero;
  const i0 = Math.max(0, -start);
  const i1 = Math.min(wave.length, x.length - start);
  for (let i = i0; i < i1; i++) x[start + i] += gain * wave[i];
}

/**
 * Build a recording.
 * @param {object} o
 * @param {number} o.seed        same seed -> identical recording
 * @param {number} o.duration    seconds
 * @param {'distinct'|'lookalike'} o.units
 * @param {boolean} o.lineNoise  include 60 Hz mains interference
 * @param {number} o.noiseLevel  scales thermal noise and background neurons
 */
export function generateRecording({
  seed = 7,
  duration = 20,
  units = 'distinct',
  lineNoise = true,
  noiseLevel = 1,
} = {}) {
  const fs = FS;
  const n = Math.round(duration * fs);
  const raw = new Float32Array(n);

  // Separate random streams so changing one knob doesn't reshuffle everything else.
  const rLfp = makeRng(seed * 101 + 1);
  const rNoise = makeRng(seed * 101 + 2);
  const rBg = makeRng(seed * 101 + 3);

  // 1. Local field potential: summed synaptic currents, mostly < 100 Hz, hundreds of uV.
  const lfp = [
    { f: 2.2, a: 130 },
    { f: 6.4, a: 95 },
    { f: 10.7, a: 60 },
    { f: 22.5, a: 25 },
    { f: 41, a: 12 },
  ].map((c) => ({ ...c, ph: rLfp.range(0, 2 * Math.PI), mf: rLfp.range(0.07, 0.25), mph: rLfp.range(0, 6.28) }));
  let drift = 0;
  const driftAlpha = Math.exp((-2 * Math.PI * 0.6) / fs);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    let v = 0;
    for (const c of lfp) {
      v += c.a * (1 + 0.45 * Math.sin(2 * Math.PI * c.mf * t + c.mph)) * Math.sin(2 * Math.PI * c.f * t + c.ph);
    }
    drift = driftAlpha * drift + (1 - driftAlpha) * rLfp.normal() * 2600;
    raw[i] = v + drift;
  }

  // 2. Mains interference from the room's wiring (60 Hz in the US, plus a harmonic).
  if (lineNoise) {
    for (let i = 0; i < n; i++) {
      const t = i / fs;
      raw[i] += 55 * Math.sin(2 * Math.PI * 60 * t + 0.4) + 14 * Math.sin(2 * Math.PI * 180 * t + 1.3);
    }
  }

  // 3. Thermal / amplifier noise: white, a few uV RMS.
  const thermal = 5.5 * noiseLevel;
  for (let i = 0; i < n; i++) raw[i] += thermal * rNoise.normal();

  // 4. Background neurons: many distant cells, each too small to isolate.
  const nBg = 48;
  for (let k = 0; k < nBg; k++) {
    const u = {
      amp: rBg.range(7, 24) * noiseLevel,
      w1: rBg.range(0.08, 0.2),
      hump: rBg.range(0.1, 0.6),
      d: rBg.range(0.25, 0.6),
      w2: rBg.range(0.15, 0.45),
    };
    const tpl = spikeTemplate(u, fs);
    for (const idx of spikeTrain(rBg, rBg.range(3, 14), n, fs)) stamp(raw, idx, tpl, rBg.range(0.85, 1.15));
  }

  // 5. The nearby neurons we want to detect and sort, with ground-truth labels.
  const unitDefs = UNIT_SETS[units] ?? UNIT_SETS.distinct;
  const truth = [];
  const templates = unitDefs.map((u) => spikeTemplate(u, fs));
  unitDefs.forEach((u, k) => {
    const r = makeRng(seed * 101 + 10 + k);
    for (const idx of spikeTrain(r, u.rate, n, fs)) {
      stamp(raw, idx, templates[k], 1 + 0.07 * r.normal());
      truth.push({ index: idx, unit: k });
    }
  });
  truth.sort((a, b) => a.index - b.index);

  return { fs, duration, raw, truth, units: unitDefs, templates };
}

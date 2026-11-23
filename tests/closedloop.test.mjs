// Closed-loop playability check: a simulated player steers the DECODED cursor toward each
// Webgrid target (with a 150 ms reaction delay and motor noise) and clicks after a short dwell.
// Run: node tests/closedloop.test.mjs
import { makePopulation, driftPopulation, centerOutVelocities, simulateCounts, sampleCounts, DECODERS, bitsPerSecond, BIN_S } from '../js/core/decoding.js';
import { makeRng } from '../js/core/rng.js';

function play({ decoder, neurons = 96, grid = 8, day = 0, mouse = false, seed = 1 }) {
  const pop = makePopulation(neurons, 3);
  const X = centerOutVelocities(60, 11), dec = DECODERS[decoder]?.(simulateCounts(pop, X, 5), X);
  const today = driftPopulation(pop, day);
  const rng = makeRng(seed);
  let pos = [0, 0], hits = 0, misses = 0, dwell = 0, intent = [0, 0];
  const delay = [];
  const cell = (p) => [Math.min(grid - 1, Math.floor(((p[0] + 1) / 2) * grid)), Math.min(grid - 1, Math.floor(((1 - p[1]) / 2) * grid))];
  let target = [Math.floor(rng.uniform() * grid), Math.floor(rng.uniform() * grid)];
  const center = (t) => [-1 + (2 * (t[0] + 0.5)) / grid, 1 - (2 * (t[1] + 0.5)) / grid];
  for (let b = 0; b < 30 / BIN_S; b++) {
    delay.push(pos.slice());
    const seen = delay.length > 8 ? delay.shift() : pos; // ~150 ms visual delay
    const c = center(target);
    const err = [c[0] - seen[0], c[1] - seen[1]];
    const want = [err[0] * 4 + rng.normal() * 0.15, err[1] * 4 + rng.normal() * 0.15];
    const sp = Math.hypot(...want);
    intent = sp > 2.5 ? want.map((v) => (v * 2.5) / sp) : want;
    const v = mouse ? intent : dec.step(sampleCounts(today, intent, rng));
    pos = [Math.max(-1, Math.min(1, pos[0] + v[0] * BIN_S)), Math.max(-1, Math.min(1, pos[1] + v[1] * BIN_S))];
    const [cx, cy] = cell(pos);
    dwell = cx === target[0] && cy === target[1] ? dwell + 1 : 0;
    if (dwell >= 6) { // ~120 ms on target, then click
      const [ax, ay] = cell([pos[0] + rng.normal() * 0.02, pos[1] + rng.normal() * 0.02]);
      if (ax === target[0] && ay === target[1]) { hits++; target = [Math.floor(rng.uniform() * grid), Math.floor(rng.uniform() * grid)]; } else misses++;
      dwell = 0;
    }
  }
  return { hits, misses, bps: bitsPerSecond(grid * grid, hits, misses, 30) };
}
const avg = (o) => { const r = [1, 2, 3].map((s) => play({ ...o, seed: s })); return { bps: r.reduce((a, x) => a + x.bps, 0) / 3, hits: r.reduce((a, x) => a + x.hits, 0) / 3, misses: r.reduce((a, x) => a + x.misses, 0) / 3 }; };
for (const grid of [6, 8, 12]) {
  const line = [`grid ${grid}x${grid}`.padEnd(11)];
  for (const [label, o] of [['mouse', { mouse: true }], ['PV', { decoder: 'pv' }], ['linear', { decoder: 'linear' }], ['kalman', { decoder: 'kalman' }], ['kalman d30', { decoder: 'kalman', day: 30 }], ['kalman 16n', { decoder: 'kalman', neurons: 16 }]]) {
    const r = avg({ grid, ...o });
    line.push(`${label} ${r.bps.toFixed(2)} (${r.hits.toFixed(0)}/${r.misses.toFixed(0)})`);
  }
  console.log(line.join(' | '));
}

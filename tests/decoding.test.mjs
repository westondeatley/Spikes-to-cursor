// Decoder sanity checks. Run: node tests/decoding.test.mjs
import assert from 'node:assert/strict';
import { makePopulation, driftPopulation, centerOutVelocities, simulateCounts, DECODERS, evaluate, bitsPerSecond } from '../js/core/decoding.js';

const t0 = performance.now();
for (const n of [16, 48, 96, 192]) {
  const pop = makePopulation(n);
  const Xtr = centerOutVelocities(60, 11), Ztr = simulateCounts(pop, Xtr, 5);
  const Xte = centerOutVelocities(30, 99), Zte = simulateCounts(pop, Xte, 77);
  const row = {};
  for (const [k, fit] of Object.entries(DECODERS)) {
    const t = performance.now();
    const dec = fit(Ztr, Xtr);
    row[k] = evaluate(dec, Zte, Xte).r2;
    row[k + 'ms'] = Math.round(performance.now() - t);
  }
  console.log(`n=${String(n).padStart(3)}  PV R²=${row.pv.toFixed(2)}  linear=${row.linear.toFixed(2)}  kalman=${row.kalman.toFixed(2)}   fit ms: ${row.pvms}/${row.linearms}/${row.kalmanms}`);
  if (n >= 48) assert.ok(row.kalman > row.linear && row.linear > row.pv - 0.05, 'Kalman should beat linear');
}
// drift: decoder trained day 0, tested on later days
const pop = makePopulation(96);
const Xtr = centerOutVelocities(60, 11);
const dec = DECODERS.kalman(simulateCounts(pop, Xtr, 5), Xtr);
const Xte = centerOutVelocities(30, 99);
for (const d of [0, 3, 7, 14, 30]) {
  const r2 = evaluate(dec, simulateCounts(driftPopulation(pop, d), Xte, 77), Xte).r2;
  console.log(`day ${String(d).padStart(2)}: Kalman (calibrated day 0) R²=${r2.toFixed(2)}`);
}
console.log('BPS 35x35, 40 correct 2 wrong in 60 s =', bitsPerSecond(35 * 35, 40, 2, 60).toFixed(2));
console.log(`total ${(performance.now() - t0).toFixed(0)} ms\nALL CHECKS PASSED`);

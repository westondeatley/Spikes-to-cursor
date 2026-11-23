// Sanity checks for the DSP and sorting core. Run: node tests/core.test.mjs
import assert from 'node:assert/strict';
import { designBandpass, sosMagnitude, sosFilter, sosFiltFilt, welchPSD, madSigma, stdDev, butterworthQs } from '../js/core/dsp.js';
import { generateRecording, FS } from '../js/core/recording.js';
import { detectSpikes, extractSnippets, matchToTruth, pca, kmeansBest as kmeans, sortingAccuracy } from '../js/core/sorting.js';

const t0 = performance.now();
const qs = butterworthQs(4);
assert.ok(Math.abs(qs[0] - 0.5412) < 1e-3 && Math.abs(qs[1] - 1.3066) < 1e-3, 'Butterworth Qs');

const sos = designBandpass({ low: 300, high: 6000, fs: FS, order: 2 });
const mag = sosMagnitude(sos, [60, 300, 1500, 6000, 9000], FS);
const db = Array.from(mag, (m) => 20 * Math.log10(m));
console.log('bandpass gain dB @60,300,1500,6000,9000 Hz:', db.map((d) => d.toFixed(2)).join(', '));
assert.ok(Math.abs(db[1] + 3) < 0.4, '-3 dB at low cutoff');
assert.ok(Math.abs(db[3] + 3) < 0.6, '-3 dB at high cutoff');
assert.ok(db[2] > -0.2, 'flat passband');
assert.ok(db[0] < -25, '60 Hz attenuated (2nd order: ~28 dB)');

for (const units of ['distinct', 'lookalike']) {
  const rec = generateRecording({ units });
  const t1 = performance.now();
  const causal = sosFilter(sos, rec.raw);
  const zp = sosFiltFilt(sos, rec.raw);
  const tf = performance.now() - t1;
  const sigma = madSigma(causal);
  console.log(`\n[${units}] samples=${rec.raw.length} truth spikes=${rec.truth.length} filter ms=${tf.toFixed(0)}`);
  console.log(`  raw std=${stdDev(rec.raw).toFixed(1)}uV  filtered std=${stdDev(causal).toFixed(1)}  MAD sigma=${sigma.toFixed(1)}`);
  for (const [name, x] of [['causal', causal], ['zero-phase', zp]]) {
    const det = detectSpikes(x, -4.5 * sigma, FS, { start: 2000, end: x.length - 2000 });
    const truth = rec.truth.filter((s) => s.index > 2000 && s.index < x.length - 2000);
    const { detUnit, truthHit } = matchToTruth(det, truth, 12);
    const tp = detUnit.filter((u) => u >= 0).length;
    const recall = tp / truth.length, precision = tp / det.length;
    const snips = extractSnippets(x, det);
    const p = pca(snips, 2);
    const km = kmeans(p.scores, 3, 3);
    const acc = sortingAccuracy(km.labels, detUnit, 3, 3);
    const perUnit = [0, 1, 2].map((u) => {
      const tot = truth.filter((s) => s.unit === u).length;
      const hit = truth.filter((s, i) => s.unit === u && truthHit[i]).length;
      return `${'ABC'[u]} ${hit}/${tot}`;
    });
    console.log(`  ${name}: det=${det.length} recall=${recall.toFixed(3)} precision=${precision.toFixed(3)} [${perUnit.join(', ')}] PCs=${p.explained.map((e) => (e * 100).toFixed(0)).join('+')}% sortAcc=${(acc.accuracy * 100).toFixed(1)}%`);
  }
}
const psd = welchPSD(generateRecording().raw, FS, 8192, FS * 8);
const at = (f) => psd.psd[Math.round(f / (FS / 8192))];
console.log('\nPSD uV^2/Hz @ 2 Hz, 60 Hz, 1 kHz, 8 kHz:', [2.4, 60, 1000, 8000].map((f) => at(f).toExponential(1)).join(', '));
console.log(`total ${(performance.now() - t0).toFixed(0)} ms`);
console.log('ALL CHECKS PASSED');

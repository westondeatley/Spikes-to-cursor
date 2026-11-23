// The live BCI shared by Stage 3 (decoding) and Stage 4 (Webgrid).
// Holds the recorded neurons, the calibrated decoders, and runs one 20 ms bin at a time:
//   intended velocity -> simulated spike counts -> decoder -> decoded velocity.

import { makeRng } from './rng.js';
import {
  BIN_S,
  makePopulation,
  driftPopulation,
  centerOutVelocities,
  simulateCounts,
  sampleCounts,
  DECODERS,
  evaluate,
} from './decoding.js';

export { BIN_S };

export const DECODER_NAMES = { pv: 'Population vector', linear: 'Linear regression', kalman: 'Kalman filter' };

export const bci = {
  neurons: 96,
  day: 0, // days since implant
  calibDay: 0, // day the decoders were last calibrated
  decoder: 'kalman',
  pop: null, // neurons on day 0
  today: null, // the same neurons on `day`
  decoders: {},
  scores: null, // held-out R^2 per decoder
  rng: makeRng(2024),
  lastCounts: null,
};

export const bciEvents = new EventTarget();
const emit = (t) => bciEvents.dispatchEvent(new Event(t));

const CAL_SECONDS = 60;

/** Fit all three decoders on a fresh calibration session recorded today. */
export function calibrate() {
  const X = centerOutVelocities(CAL_SECONDS, 11 + bci.day);
  const Z = simulateCounts(bci.today, X, 5 + bci.day);
  for (const [key, fit] of Object.entries(DECODERS)) bci.decoders[key] = fit(Z, X);
  bci.calibDay = bci.day;
  score();
  emit('calibrated');
}

/** Score every decoder on held-out reaches recorded today (not used for fitting). */
export function score() {
  const X = centerOutVelocities(30, 99);
  const Z = simulateCounts(bci.today, X, 77 + bci.day);
  bci.scores = {};
  for (const [key, dec] of Object.entries(bci.decoders)) bci.scores[key] = evaluate(dec, Z, X).r2;
  emit('scored');
}

export function setNeurons(n) {
  bci.neurons = n;
  bci.pop = makePopulation(n, 3);
  bci.today = driftPopulation(bci.pop, bci.day);
  calibrate();
}

/** Move forward in time. The decoders keep their old calibration until you recalibrate. */
export function setDay(d) {
  bci.day = d;
  bci.today = driftPopulation(bci.pop, d);
  score();
  emit('day');
}

export function setDecoder(key) {
  bci.decoder = key;
  bci.decoders[key]?.reset();
  emit('decoder');
}

/** One 20 ms bin: generate spikes for the intended velocity, then decode them. */
export function step(intent) {
  const z = sampleCounts(bci.today, intent, bci.rng);
  bci.lastCounts = z;
  return bci.decoders[bci.decoder].step(z);
}

export function resetDecoder() {
  bci.decoders[bci.decoder]?.reset();
}

export function initBci() {
  if (!bci.pop) setNeurons(bci.neurons);
}

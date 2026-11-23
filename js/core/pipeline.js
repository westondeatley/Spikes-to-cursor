// The shared signal chain. Every lesson section reads from the same pipeline, so a
// choice made in one stage (say, a bad filter) carries through to every later stage,
// just as it would on a real implant.
//
//   generate -> filter -> detect -> snippets -> PCA -> k-means
//
// Changing a parameter re-runs only the stages downstream of it, then fires an event.

import { generateRecording, FS } from './recording.js';
import { designBandpass, sosFilter, sosFiltFilt, madSigma } from './dsp.js';
import {
  detectSpikes,
  extractSnippets,
  matchToTruth,
  pca,
  kmeansBest,
  orderClusters,
  sortingAccuracy,
} from './sorting.js';

export const params = {
  // recording
  seed: 7,
  duration: 20,
  units: 'distinct',
  lineNoise: true,
  noiseLevel: 1,
  // filter
  low: 300,
  high: 6000,
  order: 2,
  phase: 'causal', // 'causal' (on-implant) | 'zerophase' (offline)
  // detection + sorting
  threshK: 4.5,
  deadMs: 1.0,
  k: 3,
};

export const data = {
  fs: FS,
  rec: null,
  sos: null,
  filtered: null,
  sigma: 0,
  threshold: 0,
  detections: [],
  match: null,
  snippets: [],
  pca: null,
  cluster: null, // { centroids, labels, inertia }
  accuracy: null,
};

export const events = new EventTarget();
const emit = (type) => events.dispatchEvent(new Event(type));

const EDGE = 2000; // skip 0.1 s at each end where filter transients live
const MATCH_TOL = 12; // samples (0.6 ms)

const STAGE_OF = {
  seed: 'generate', duration: 'generate', units: 'generate', lineNoise: 'generate', noiseLevel: 'generate',
  low: 'filter', high: 'filter', order: 'filter', phase: 'filter',
  threshK: 'detect', deadMs: 'detect',
  k: 'cluster',
};

/** 99.95th percentile of |x|: a display range that ignores rare outliers. */
function robustRange(x, stride = 8) {
  const m = Math.floor(x.length / stride);
  const a = new Float32Array(m);
  for (let i = 0; i < m; i++) a[i] = Math.abs(x[i * stride]);
  a.sort();
  return a[Math.floor(m * 0.9995)];
}

function generate() {
  data.rec = generateRecording(params);
  data.rawRange = robustRange(data.rec.raw);
}

function filter() {
  data.sos = designBandpass({ low: params.low, high: params.high, fs: FS, order: params.order });
  data.filtered = params.phase === 'causal' ? sosFilter(data.sos, data.rec.raw) : sosFiltFilt(data.sos, data.rec.raw);
  data.sigma = madSigma(data.filtered);
  data.filtRange = robustRange(data.filtered);
}

function detect() {
  const x = data.filtered;
  data.threshold = -params.threshK * data.sigma;
  data.detections = detectSpikes(x, data.threshold, FS, { deadMs: params.deadMs, start: EDGE, end: x.length - EDGE });
  data.truth = data.rec.truth.filter((s) => s.index > EDGE && s.index < x.length - EDGE);
  data.match = matchToTruth(data.detections, data.truth, MATCH_TOL);
  data.snippets = extractSnippets(x, data.detections);
  data.pca = pca(data.snippets, 2);
}

function cluster() {
  const k = Math.min(params.k, Math.max(1, data.pca.scores.length));
  data.cluster = data.pca.scores.length ? orderClusters(kmeansBest(data.pca.scores, k, params.seed)) : null;
  scoreClusters();
}

/** Recompute accuracy for whatever labels are current (also used by the k-means animation). */
export function scoreClusters() {
  if (!data.cluster) {
    data.accuracy = null;
    return;
  }
  data.accuracy = sortingAccuracy(data.cluster.labels, data.match.detUnit, data.cluster.centroids.length, data.rec.units.length);
}

const ORDER = ['generate', 'filter', 'detect', 'cluster'];
const RUN = { generate, filter, detect, cluster };

function runFrom(stage) {
  for (const s of ORDER.slice(ORDER.indexOf(stage))) RUN[s]();
  emit('update');
  emit(stage);
}

let pending = null;
let frame = 0;

/**
 * Set one or more parameters. Work is coalesced to one run per animation frame,
 * so dragging a slider stays smooth.
 */
export function setParams(patch) {
  let earliest = null;
  for (const [key, value] of Object.entries(patch)) {
    if (params[key] === value) continue;
    params[key] = value;
    const st = STAGE_OF[key];
    if (st && (earliest === null || ORDER.indexOf(st) < ORDER.indexOf(earliest))) earliest = st;
  }
  if (!earliest) return;
  if (pending === null || ORDER.indexOf(earliest) < ORDER.indexOf(pending)) pending = earliest;
  if (!frame) {
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f) => setTimeout(f, 0);
    frame = raf(() => {
      frame = 0;
      const st = pending;
      pending = null;
      runFrom(st);
    });
  }
}

export function init() {
  runFrom('generate');
}

/** Detection quality against ground truth. */
export function detectionStats() {
  const { detections, match, truth } = data;
  const tp = match.detUnit.reduce((acc, u) => acc + (u >= 0 ? 1 : 0), 0);
  return {
    detected: detections.length,
    truePositives: tp,
    falsePositives: detections.length - tp,
    missed: truth.length - tp,
    recall: truth.length ? tp / truth.length : 0,
    precision: detections.length ? tp / detections.length : 0,
  };
}

// Spike detection and sorting: threshold crossings -> waveform snippets -> PCA -> k-means.
// This is the classic offline pipeline (e.g. Quiroga et al. 2004), simplified for teaching.

import { makeRng } from './rng.js';

export const SNIPPET_PRE = 10; // samples before the trough (0.5 ms at 20 kHz)
export const SNIPPET_POST = 22; // samples after the trough (1.1 ms)
export const SNIPPET_LEN = SNIPPET_PRE + SNIPPET_POST;

/**
 * Negative-threshold detection. When the signal dips below `threshold`, find the trough
 * within the next `searchMs`, record it, then ignore `deadMs` so one spike counts once.
 */
export function detectSpikes(x, threshold, fs, { deadMs = 1.0, searchMs = 0.5, start = 0, end = x.length } = {}) {
  const out = [];
  const dead = Math.round((deadMs * fs) / 1000);
  const search = Math.round((searchMs * fs) / 1000);
  let i = Math.max(start, SNIPPET_PRE);
  const stop = Math.min(end, x.length - SNIPPET_POST);
  while (i < stop) {
    if (x[i] < threshold) {
      let m = i;
      const lim = Math.min(stop, i + search);
      for (let j = i + 1; j < lim; j++) if (x[j] < x[m]) m = j;
      out.push(m);
      i = m + dead;
    } else {
      i++;
    }
  }
  return out;
}

/** Cut a fixed window around each detected trough. */
export function extractSnippets(x, indices) {
  return indices.map((idx) => x.subarray(idx - SNIPPET_PRE, idx + SNIPPET_POST));
}

/**
 * Compare detections with ground truth. A detection is a hit if it lies within
 * `tol` samples of an unclaimed true spike. Returns, for each detection, the true
 * unit it matched (or -1 for a false positive), and which true spikes were missed.
 */
export function matchToTruth(detections, truth, tol) {
  const detUnit = new Int8Array(detections.length).fill(-1);
  const truthHit = new Uint8Array(truth.length);
  let j = 0;
  for (let d = 0; d < detections.length; d++) {
    const idx = detections[d];
    while (j < truth.length && truth[j].index < idx - tol) j++;
    let best = -1;
    let bestDist = Infinity;
    for (let k = j; k < truth.length && truth[k].index <= idx + tol; k++) {
      if (truthHit[k]) continue;
      const dist = Math.abs(truth[k].index - idx);
      if (dist < bestDist) {
        bestDist = dist;
        best = k;
      }
    }
    if (best >= 0) {
      truthHit[best] = 1;
      detUnit[d] = truth[best].unit;
    }
  }
  return { detUnit, truthHit };
}

/** Eigen-decomposition of a symmetric matrix by cyclic Jacobi rotations. */
export function symmetricEigen(A) {
  const n = A.length;
  const a = A.map((r) => Float64Array.from(r));
  const v = Array.from({ length: n }, (_, i) => {
    const r = new Float64Array(n);
    r[i] = 1;
    return r;
  });
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-12) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-14) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const values = a.map((r, i) => r[i]);
  const order = values.map((_, i) => i).sort((i, j) => values[j] - values[i]);
  return {
    values: order.map((i) => values[i]),
    vectors: order.map((i) => Float64Array.from(v.map((r) => r[i]))),
  };
}

/**
 * Principal component analysis of the snippets. Projects each 32-sample waveform
 * onto the directions of greatest variance, so similar waveforms land close together.
 */
export function pca(snippets, nComp = 2) {
  const n = snippets.length;
  const d = SNIPPET_LEN;
  const mean = new Float64Array(d);
  if (n === 0) return { mean, components: [], explained: [], scores: [] };
  for (const s of snippets) for (let i = 0; i < d; i++) mean[i] += s[i] / n;
  const cov = Array.from({ length: d }, () => new Float64Array(d));
  for (const s of snippets) {
    for (let i = 0; i < d; i++) {
      const di = s[i] - mean[i];
      for (let j = i; j < d; j++) cov[i][j] += di * (s[j] - mean[j]);
    }
  }
  for (let i = 0; i < d; i++) {
    for (let j = i; j < d; j++) {
      cov[i][j] /= Math.max(1, n - 1);
      cov[j][i] = cov[i][j];
    }
  }
  const { values, vectors } = symmetricEigen(cov);
  const total = values.reduce((acc, x) => acc + Math.max(0, x), 0) || 1;
  const components = vectors.slice(0, nComp);
  // Fix the sign of each component so plots don't flip between runs.
  for (const c of components) {
    let big = 0;
    for (let i = 0; i < d; i++) if (Math.abs(c[i]) > Math.abs(big)) big = c[i];
    if (big < 0) for (let i = 0; i < d; i++) c[i] = -c[i];
  }
  const scores = snippets.map((s) =>
    components.map((c) => {
      let acc = 0;
      for (let i = 0; i < d; i++) acc += (s[i] - mean[i]) * c[i];
      return acc;
    })
  );
  return { mean, components, explained: values.slice(0, nComp).map((x) => x / total), scores };
}

/** k-means++ seeding: spread the initial centroids out to avoid bad local minima. */
export function kmeansPlusPlus(points, k, seed = 1) {
  const rng = makeRng(seed);
  if (points.length === 0) return [];
  const cents = [points[Math.floor(rng.uniform() * points.length)].slice()];
  const dist = new Float64Array(points.length);
  while (cents.length < k) {
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
      let best = Infinity;
      for (const c of cents) best = Math.min(best, sqDist(points[i], c));
      dist[i] = best;
      sum += best;
    }
    let r = rng.uniform() * sum;
    let pick = 0;
    for (; pick < points.length - 1; pick++) {
      r -= dist[pick];
      if (r <= 0) break;
    }
    cents.push(points[pick].slice());
  }
  return cents;
}

/** Random initialization: k random points. Worse than k-means++, which is the point of the demo. */
export function kmeansRandomInit(points, k, seed = 1) {
  const rng = makeRng(seed);
  const cents = [];
  for (let i = 0; i < k && points.length; i++) cents.push(points[Math.floor(rng.uniform() * points.length)].slice());
  return cents;
}

function sqDist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return s;
}

/** Assign each point to its nearest centroid. */
export function kmeansAssign(points, centroids) {
  const labels = new Int8Array(points.length);
  let inertia = 0;
  for (let i = 0; i < points.length; i++) {
    let best = 0;
    let bestD = Infinity;
    for (let c = 0; c < centroids.length; c++) {
      const dd = sqDist(points[i], centroids[c]);
      if (dd < bestD) {
        bestD = dd;
        best = c;
      }
    }
    labels[i] = best;
    inertia += bestD;
  }
  return { labels, inertia };
}

/** One Lloyd iteration: assign, then move each centroid to the mean of its points. */
export function kmeansStep(points, centroids) {
  const { labels } = kmeansAssign(points, centroids);
  const dim = centroids[0]?.length ?? 0;
  const sums = centroids.map(() => new Float64Array(dim));
  const counts = new Int32Array(centroids.length);
  for (let i = 0; i < points.length; i++) {
    counts[labels[i]]++;
    for (let j = 0; j < dim; j++) sums[labels[i]][j] += points[i][j];
  }
  let shift = 0;
  const next = centroids.map((c, k) => {
    if (counts[k] === 0) return c.slice();
    const m = Array.from(sums[k], (s) => s / counts[k]);
    shift = Math.max(shift, Math.sqrt(sqDist(m, c)));
    return m;
  });
  const { labels: finalLabels, inertia } = kmeansAssign(points, next);
  return { centroids: next, labels: finalLabels, shift, inertia };
}

/** Run k-means to convergence. */
export function kmeans(points, k, seed = 1, maxIter = 100) {
  let centroids = kmeansPlusPlus(points, k, seed);
  let result = { centroids, ...kmeansAssign(points, centroids), shift: Infinity };
  for (let it = 0; it < maxIter && result.shift > 1e-6; it++) result = kmeansStep(points, result.centroids);
  return result;
}

/**
 * k-means can converge to a poor local minimum depending on where it starts.
 * Standard practice (scikit-learn's n_init): run several times, keep the lowest inertia.
 */
export function kmeansBest(points, k, seed = 1, restarts = 10) {
  let best = null;
  for (let r = 0; r < restarts; r++) {
    const res = kmeans(points, k, seed + r * 7919);
    if (!best || res.inertia < best.inertia) best = res;
  }
  return best;
}

/**
 * Put clusters in a stable order (by mean PC1 score, largest first) so colors
 * don't shuffle every time the threshold moves.
 */
export function orderClusters(result) {
  const order = result.centroids.map((c, i) => i).sort((a, b) => result.centroids[b][0] - result.centroids[a][0]);
  const remap = new Int8Array(order.length);
  order.forEach((old, i) => (remap[old] = i));
  return {
    ...result,
    centroids: order.map((i) => result.centroids[i]),
    labels: Int8Array.from(result.labels, (l) => remap[l]),
  };
}

/**
 * Sorting accuracy against ground truth, over detections that matched a real spike.
 * Each cluster is credited to the true unit most of its spikes came from.
 */
export function sortingAccuracy(labels, detUnit, k, nUnits) {
  const table = Array.from({ length: k }, () => new Int32Array(nUnits));
  let matched = 0;
  for (let i = 0; i < labels.length; i++) {
    if (detUnit[i] < 0) continue;
    table[labels[i]][detUnit[i]]++;
    matched++;
  }
  let correct = 0;
  const clusterUnit = table.map((row) => {
    let best = 0;
    for (let u = 1; u < nUnits; u++) if (row[u] > row[best]) best = u;
    correct += row[best];
    return row.some((x) => x > 0) ? best : -1;
  });
  return { accuracy: matched ? correct / matched : 0, clusterUnit, table };
}

// Motor cortex simulation and velocity decoders.
//
// Each simulated neuron is "cosine tuned" (Georgopoulos et al., 1982): it fires most when
// the intended movement points in its preferred direction, least in the opposite direction.
//   rate_i = max(0, baseline_i + depth_i * (v . p_i))
// where v is intended velocity and p_i is the neuron's preferred direction (a unit vector).
// Spike counts in 20 ms bins are Poisson, so the same intention gives a different
// pattern every time. Decoders must recover v from those noisy counts.

import { makeRng } from './rng.js';
import { transpose, matmul, crossprod, inverse, identity, add, colMeans, center } from './linalg.js';

export const BIN_S = 0.02; // 20 ms bins, the same bins as "binned counts" in Stage 0

/** A population of cosine-tuned neurons with random preferred directions. */
export function makePopulation(n, seed = 3) {
  const rng = makeRng(seed);
  return Array.from({ length: n }, () => ({
    theta: rng.range(0, 2 * Math.PI),
    base: rng.range(8, 30), // spikes/s when not moving
    depth: rng.range(6, 22), // extra spikes/s per (workspace unit / s) along the preferred direction
    // Fixed random draws used to drift this neuron over days (so drift is repeatable).
    dTheta: rng.normal(),
    dBase: rng.normal(),
    dLoss: rng.uniform(),
  }));
}

/**
 * The same neurons `days` later. Electrodes shift slightly and cells change, so preferred
 * directions wander, baselines change and some neurons stop being recorded well.
 */
export function driftPopulation(pop, days) {
  if (days <= 0) return pop;
  const s = Math.sqrt(days);
  const lostFrac = 1 - Math.exp(-days / 60);
  return pop.map((u) => {
    const lost = u.dLoss < lostFrac;
    return {
      ...u,
      theta: u.theta + 0.24 * s * u.dTheta,
      base: u.base * Math.exp(0.09 * s * u.dBase),
      depth: lost ? u.depth * 0.1 : u.depth,
    };
  });
}

/** Expected firing rate (spikes/s) of every neuron for intended velocity v = [vx, vy]. */
export function firingRates(pop, v) {
  const out = new Float64Array(pop.length);
  for (let i = 0; i < pop.length; i++) {
    const u = pop[i];
    out[i] = Math.max(0, u.base + u.depth * (v[0] * Math.cos(u.theta) + v[1] * Math.sin(u.theta)));
  }
  return out;
}

/** Poisson sample (Knuth's method; fine for the small means of a 20 ms bin). */
export function poisson(rng, mean) {
  if (mean <= 0) return 0;
  const L = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng.uniform();
  } while (p > L);
  return k - 1;
}

/** One bin of spike counts for intended velocity v. */
export function sampleCounts(pop, v, rng) {
  const r = firingRates(pop, v);
  const z = new Float64Array(pop.length);
  for (let i = 0; i < z.length; i++) z[i] = poisson(rng, r[i] * BIN_S);
  return z;
}

/**
 * Intended velocities for a calibration session: center-out reaches to 8 targets
 * and back, with smooth minimum-jerk speed profiles. During calibration a real
 * participant watches a cursor do this and imagines moving it.
 */
export function centerOutVelocities(seconds, seed = 11) {
  const rng = makeRng(seed);
  const out = [];
  let pos = [0, 0];
  let outward = true;
  while (out.length * BIN_S < seconds) {
    const a = (Math.floor(rng.uniform() * 8) * Math.PI) / 4 + rng.range(-0.15, 0.15);
    const r = rng.range(0.55, 0.85);
    const goal = outward ? [r * Math.cos(a), r * Math.sin(a)] : [0, 0];
    const dur = rng.range(0.6, 1.1);
    const steps = Math.round(dur / BIN_S);
    const d = [goal[0] - pos[0], goal[1] - pos[1]];
    for (let k = 0; k < steps; k++) {
      // derivative of minimum-jerk position profile 10t^3 - 15t^4 + 6t^5
      const t = (k + 0.5) / steps;
      const sp = (30 * t * t - 60 * t ** 3 + 30 * t ** 4) / dur;
      out.push([d[0] * sp, d[1] * sp]);
    }
    pos = goal;
    outward = !outward;
    const hold = Math.round(rng.range(0.15, 0.4) / BIN_S);
    for (let k = 0; k < hold; k++) out.push([0, 0]);
  }
  return out;
}

/** Simulate recorded spike counts for a sequence of intended velocities. */
export function simulateCounts(pop, velocities, seed = 5) {
  const rng = makeRng(seed);
  return velocities.map((v) => sampleCounts(pop, v, rng));
}

// ---------------------------------------------------------------------------
// Decoders. Each is fit on calibration data (Z: counts, X: velocities) and returns
// an object with reset() and step(z) -> [vx, vy], processing one 20 ms bin at a time.
// ---------------------------------------------------------------------------

/** Per-neuron linear fit z_i = b_i + h_i . v  (gives each neuron's tuning). */
function fitTuning(Z, X) {
  const D = X.map((v) => Float64Array.from([1, v[0], v[1]]));
  return matmul(inverse(crossprod(D, D)), crossprod(D, Z)); // 3 x N
}

/**
 * Population vector (Georgopoulos, 1986): every neuron "votes" for its preferred direction,
 * weighted by how much its firing is above or below baseline. Sum the votes.
 */
export function fitPopulationVector(Z, X) {
  const coef = fitTuning(Z, X);
  const n = Z[0].length;
  const units = [];
  for (let i = 0; i < n; i++) {
    const hx = coef[1][i], hy = coef[2][i];
    const m = Math.hypot(hx, hy);
    if (m < 1e-6) continue;
    units.push({ i, b: coef[0][i], m, px: hx / m, py: hy / m });
  }
  // Weight each vote by how strongly the neuron is tuned, so weakly tuned (noisy) neurons
  // count less. For evenly spread preferred directions, sum(m^2 p p^T) = (sum m^2 / 2) I.
  const sumM2 = units.reduce((acc, u) => acc + u.m * u.m, 0) || 1;
  const k = 2 / sumM2;
  return {
    name: 'Population vector',
    units,
    reset() {},
    step(z) {
      let vx = 0, vy = 0;
      for (const u of units) {
        const w = z[u.i] - u.b; // firing above (+) or below (-) baseline
        vx += w * u.m * u.px;
        vy += w * u.m * u.py;
      }
      return [k * vx, k * vy];
    },
  };
}

/** Linear (ridge) regression: v = W^T (z - mean) + mean, fit by least squares. */
export function fitLinear(Z, X, lambda = 1) {
  const mz = colMeans(Z), mx = colMeans(X);
  const Zc = center(Z, mz), Xc = center(X, mx);
  const n = mz.length;
  const G = add(crossprod(Zc, Zc), identity(n, lambda * Z.length * 0.01));
  const W = matmul(inverse(G), crossprod(Zc, Xc)); // n x 2
  return {
    name: 'Linear regression',
    reset() {},
    step(z) {
      let vx = mx[0], vy = mx[1];
      for (let i = 0; i < n; i++) {
        const d = z[i] - mz[i];
        vx += W[i][0] * d;
        vy += W[i][1] * d;
      }
      return [vx, vy];
    },
  };
}

/**
 * Kalman filter (Wu et al., 2003), velocity state, using the steady-state gain.
 *   state:        v_t = A v_{t-1} + w,   w ~ N(0, W)    (movements are smooth)
 *   observation:  z_t = H v_t + q,       q ~ N(0, Q)    (neurons encode velocity)
 * Each step blends a prediction from the last estimate with new evidence from the spikes.
 * K is computed once with the matrix inversion lemma, so each step costs O(neurons).
 */
export function fitKalman(Z, X) {
  const mz = colMeans(Z), mx = colMeans(X);
  const Zc = center(Z, mz), Xc = center(X, mx);
  const T = Z.length, n = mz.length;
  const X1 = Xc.slice(0, -1), X2 = Xc.slice(1);
  const A = matmul(transpose(crossprod(X1, X2)), inverse(crossprod(X1, X1))); // 2x2
  const R1 = X2.map((x, t) => {
    const p = matmul([X1[t]], transpose(A))[0];
    return Float64Array.from([x[0] - p[0], x[1] - p[1]]);
  });
  const W = crossprod(R1, R1).map((r) => r.map((v) => v / (T - 1)));
  const H = transpose(matmul(inverse(crossprod(Xc, Xc)), crossprod(Xc, Zc))); // n x 2
  const resid = Zc.map((z, t) => z.map((v, i) => v - (H[i][0] * Xc[t][0] + H[i][1] * Xc[t][1])));
  const Q = crossprod(resid, resid).map((r) => r.map((v) => v / T));
  let tr = 0;
  for (let i = 0; i < n; i++) tr += Q[i][i];
  for (let i = 0; i < n; i++) Q[i][i] += 1e-3 * (tr / n) + 1e-6;
  const Qi = inverse(Q);
  const G = matmul(transpose(H), Qi); // 2 x n   (H^T Q^-1)
  const M = matmul(G, H); // 2 x 2         (H^T Q^-1 H)
  // Iterate the Riccati equation to its steady state.
  let P = W;
  const At = transpose(A);
  for (let it = 0; it < 300; it++) {
    const Pp = add(matmul(matmul(A, P), At), W);
    P = inverse(add(inverse(Pp), M));
  }
  const K = matmul(P, G); // 2 x n
  const KH = matmul(K, H); // 2 x 2
  // Combined update: v = (I - K H) A v_prev + K (z - mz)
  const F = matmul(add(identity(2), KH, -1), A);
  let v = [0, 0];
  return {
    name: 'Kalman filter',
    reset() {
      v = [0, 0];
    },
    step(z) {
      const nx = F[0][0] * v[0] + F[0][1] * v[1];
      const ny = F[1][0] * v[0] + F[1][1] * v[1];
      let kx = 0, ky = 0;
      for (let i = 0; i < n; i++) {
        const d = z[i] - mz[i];
        kx += K[0][i] * d;
        ky += K[1][i] * d;
      }
      v = [nx + kx, ny + ky];
      return [v[0] + mx[0], v[1] + mx[1]];
    },
  };
}

export const DECODERS = {
  pv: fitPopulationVector,
  linear: fitLinear,
  kalman: fitKalman,
};

/** Fraction of velocity variance explained (R^2), averaged over x and y. */
export function evaluate(decoder, Z, X) {
  decoder.reset();
  const pred = Z.map((z) => decoder.step(z));
  let r2 = 0;
  for (let d = 0; d < 2; d++) {
    let mean = 0;
    for (const x of X) mean += x[d] / X.length;
    let ssTot = 0, ssRes = 0;
    for (let t = 0; t < X.length; t++) {
      ssTot += (X[t][d] - mean) ** 2;
      ssRes += (X[t][d] - pred[t][d]) ** 2;
    }
    r2 += 1 - ssRes / ssTot;
  }
  decoder.reset();
  return { r2: r2 / 2, pred };
}

/** Pearson correlation between two equal-length arrays. */
export function correlation(a, b) {
  const n = a.length;
  if (n < 3) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i] / n;
    mb += b[i] / n;
  }
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

/**
 * Achieved bitrate for a grid selection task (Nuyujukian et al., 2015), the metric
 * behind Neuralink's Webgrid score:  B = log2(N - 1) * max(0, correct - wrong) / seconds.
 */
export function bitsPerSecond(cells, correct, wrong, seconds) {
  if (seconds <= 0 || cells < 3) return 0;
  return (Math.log2(cells - 1) * Math.max(0, correct - wrong)) / seconds;
}


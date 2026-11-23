// Digital signal processing primitives used throughout the app.
// Everything here is plain math on typed arrays (no DOM), so it runs in Node for tests.

/**
 * Q factors of the second-order sections that make up an Nth-order Butterworth filter.
 * Poles sit evenly on a circle; each conjugate pair becomes one biquad.
 * Example: order 4 -> [0.5412, 1.3066].
 */
export function butterworthQs(order) {
  if (order % 2 !== 0) throw new Error('Butterworth order must be even');
  const qs = [];
  for (let k = 1; k <= order / 2; k++) {
    qs.push(1 / (2 * Math.cos((Math.PI * (2 * k - 1)) / (2 * order))));
  }
  return qs;
}

/**
 * One biquad section via the bilinear transform (RBJ Audio EQ Cookbook form).
 * Coefficients are normalized so a0 = 1.
 */
export function biquad(type, fc, fs, Q) {
  const w0 = (2 * Math.PI * fc) / fs;
  const c = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  let b0, b1, b2;
  if (type === 'lowpass') {
    b0 = (1 - c) / 2;
    b1 = 1 - c;
    b2 = (1 - c) / 2;
  } else if (type === 'highpass') {
    b0 = (1 + c) / 2;
    b1 = -(1 + c);
    b2 = (1 + c) / 2;
  } else {
    throw new Error(`Unknown biquad type: ${type}`);
  }
  const a0 = 1 + alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: (-2 * c) / a0, a2: (1 - alpha) / a0 };
}

/**
 * Butterworth bandpass as a cascade of second-order sections (SOS):
 * an Nth-order high-pass at `low` followed by an Nth-order low-pass at `high`.
 * Cascading biquads instead of one high-order polynomial keeps it numerically stable,
 * which is also how implant firmware and scipy.signal.butter(output='sos') do it.
 */
export function designBandpass({ low, high, fs, order = 4 }) {
  const sos = [];
  for (const q of butterworthQs(order)) sos.push(biquad('highpass', low, fs, q));
  for (const q of butterworthQs(order)) sos.push(biquad('lowpass', high, fs, q));
  return sos;
}

/**
 * Causal filtering, one sample at a time (transposed direct form II).
 * This is what an implant can do: each output depends only on past and present input.
 */
export function sosFilter(sos, x) {
  const y = new Float32Array(x.length);
  y.set(x);
  for (const s of sos) {
    let z1 = 0;
    let z2 = 0;
    for (let i = 0; i < y.length; i++) {
      const xi = y[i];
      const yi = s.b0 * xi + z1;
      z1 = s.b1 * xi - s.a1 * yi + z2;
      z2 = s.b2 * xi - s.a2 * yi;
      y[i] = yi;
    }
  }
  return y;
}

/**
 * Zero-phase filtering: run forward, then backward. No delay or waveform distortion,
 * but it needs the future, so it only works offline. Magnitude response is |H|^2.
 */
export function sosFiltFilt(sos, x) {
  const fwd = sosFilter(sos, x);
  fwd.reverse();
  const back = sosFilter(sos, fwd);
  back.reverse();
  return back;
}

/** Magnitude response |H(f)| of a cascade at the given frequencies (Hz). */
export function sosMagnitude(sos, freqs, fs) {
  const out = new Float64Array(freqs.length);
  for (let k = 0; k < freqs.length; k++) {
    const w = (2 * Math.PI * freqs[k]) / fs;
    const c1 = Math.cos(w), s1 = Math.sin(w);
    const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    let mag = 1;
    for (const s of sos) {
      // H(e^jw) = (b0 + b1 e^-jw + b2 e^-2jw) / (1 + a1 e^-jw + a2 e^-2jw)
      const nr = s.b0 + s.b1 * c1 + s.b2 * c2;
      const ni = -(s.b1 * s1 + s.b2 * s2);
      const dr = 1 + s.a1 * c1 + s.a2 * c2;
      const di = -(s.a1 * s1 + s.a2 * s2);
      mag *= Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
    }
    out[k] = mag;
  }
  return out;
}

/** In-place iterative radix-2 FFT. `re` and `im` must have a power-of-two length. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Welch power spectral density: average the periodograms of 50%-overlapping,
 * Hann-windowed segments. Returns one-sided PSD in (input units)^2 / Hz.
 */
export function welchPSD(x, fs, nfft = 8192, maxSamples = x.length) {
  const n = Math.min(x.length, maxSamples);
  const win = new Float64Array(nfft);
  let wss = 0;
  for (let i = 0; i < nfft; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (nfft - 1));
    wss += win[i] * win[i];
  }
  const half = nfft / 2 + 1;
  const psd = new Float64Array(half);
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const hop = nfft / 2;
  let segments = 0;
  for (let start = 0; start + nfft <= n; start += hop) {
    let mean = 0;
    for (let i = 0; i < nfft; i++) mean += x[start + i];
    mean /= nfft;
    for (let i = 0; i < nfft; i++) {
      re[i] = (x[start + i] - mean) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < half; k++) psd[k] += re[k] * re[k] + im[k] * im[k];
    segments++;
  }
  const scale = 1 / (fs * wss * Math.max(1, segments));
  const freqs = new Float64Array(half);
  for (let k = 0; k < half; k++) {
    psd[k] *= scale * (k === 0 || k === half - 1 ? 1 : 2);
    freqs[k] = (k * fs) / nfft;
  }
  return { freqs, psd };
}

/**
 * Robust noise estimate: sigma = median(|x|) / 0.6745 (Quiroga, Nadasdy & Ben-Shaul, 2004).
 * Unlike the standard deviation, the median barely moves when large spikes are present.
 * `stride` subsamples for speed; the estimate is statistically unchanged.
 */
export function madSigma(x, stride = 4) {
  const m = Math.floor(x.length / stride);
  const a = new Float32Array(m);
  for (let i = 0; i < m; i++) a[i] = Math.abs(x[i * stride]);
  a.sort();
  return a[Math.floor(m / 2)] / 0.6745;
}

/** Plain standard deviation, for comparison with the robust estimate. */
export function stdDev(x) {
  let s = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i];
    s2 += x[i] * x[i];
  }
  const mean = s / x.length;
  return Math.sqrt(Math.max(0, s2 / x.length - mean * mean));
}

// Seeded random numbers so every run of the lesson produces the same recording.
// mulberry32 is a small, fast 32-bit PRNG; good enough for simulation, not for crypto.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seed) {
  const uniform = mulberry32(seed);
  let spare = null;

  // Marsaglia polar method: standard normal samples.
  function normal() {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u, v, s;
    do {
      u = uniform() * 2 - 1;
      v = uniform() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * m;
    return u * m;
  }

  return {
    uniform,
    normal,
    range: (lo, hi) => lo + (hi - lo) * uniform(),
    exponential: (rate) => -Math.log(1 - uniform()) / rate,
  };
}

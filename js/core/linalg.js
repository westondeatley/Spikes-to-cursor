// Minimal dense linear algebra on arrays of Float64Array rows. Enough for decoder fitting.

export function zeros(r, c) {
  return Array.from({ length: r }, () => new Float64Array(c));
}

export function transpose(A) {
  const r = A.length, c = A[0].length;
  const T = zeros(c, r);
  for (let i = 0; i < r; i++) for (let j = 0; j < c; j++) T[j][i] = A[i][j];
  return T;
}

export function matmul(A, B) {
  const r = A.length, k = B.length, c = B[0].length;
  const C = zeros(r, c);
  for (let i = 0; i < r; i++) {
    const Ai = A[i], Ci = C[i];
    for (let m = 0; m < k; m++) {
      const a = Ai[m];
      if (a === 0) continue;
      const Bm = B[m];
      for (let j = 0; j < c; j++) Ci[j] += a * Bm[j];
    }
  }
  return C;
}

/** A^T B without forming A^T (A is T x n, B is T x m). */
export function crossprod(A, B) {
  const n = A[0].length, m = B[0].length;
  const C = zeros(n, m);
  for (let t = 0; t < A.length; t++) {
    const a = A[t], b = B[t];
    for (let i = 0; i < n; i++) {
      const ai = a[i];
      if (ai === 0) continue;
      const Ci = C[i];
      for (let j = 0; j < m; j++) Ci[j] += ai * b[j];
    }
  }
  return C;
}

export function add(A, B, s = 1) {
  return A.map((row, i) => row.map((v, j) => v + s * B[i][j]));
}

export function scale(A, s) {
  return A.map((row) => row.map((v) => v * s));
}

export function identity(n, s = 1) {
  const I = zeros(n, n);
  for (let i = 0; i < n; i++) I[i][i] = s;
  return I;
}

/** Inverse by Gauss-Jordan elimination with partial pivoting. */
export function inverse(M) {
  const n = M.length;
  const A = M.map((r) => Float64Array.from(r));
  const I = identity(n);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) throw new Error('Singular matrix');
    [A[col], A[piv]] = [A[piv], A[col]];
    [I[col], I[piv]] = [I[piv], I[col]];
    const d = A[col][col];
    for (let j = 0; j < n; j++) {
      A[col][j] /= d;
      I[col][j] /= d;
    }
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (f === 0) continue;
      const Ar = A[r], Ir = I[r], Ac = A[col], Ic = I[col];
      for (let j = 0; j < n; j++) {
        Ar[j] -= f * Ac[j];
        Ir[j] -= f * Ic[j];
      }
    }
  }
  return I;
}

/** Column means of a T x n matrix. */
export function colMeans(A) {
  const n = A[0].length;
  const m = new Float64Array(n);
  for (const row of A) for (let j = 0; j < n; j++) m[j] += row[j];
  for (let j = 0; j < n; j++) m[j] /= A.length;
  return m;
}

export function center(A, mean) {
  return A.map((row) => row.map((v, j) => v - mean[j]));
}

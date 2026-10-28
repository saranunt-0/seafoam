// Radix-2 complex FFT on split real/imaginary Float32Arrays.
// Only the inverse transform (e^{+i...}, no 1/N scaling) is needed: the ocean
// spectrum is built in frequency space and summed back into a height field.

function transpose(a, n) {
  for (let z = 0; z < n; z++) {
    for (let x = z + 1; x < n; x++) {
      const i = z * n + x, j = x * n + z;
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
  }
}

export class FFT {
  constructor(n) {
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${n}`);
    this.n = n;
    const bits = Math.log2(n);

    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }

    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
  }

  // In-place inverse DFT of n samples starting at `off`, `stride` apart:
  // x[m] = sum_k X[k] * e^{+2*pi*i*k*m/n}
  inverse(re, im, off = 0, stride = 1) {
    const { n, rev, cos, sin } = this;

    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const a = off + i * stride, b = off + j * stride;
        let t = re[a]; re[a] = re[b]; re[b] = t;
        t = im[a]; im[a] = im[b]; im[b] = t;
      }
    }

    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let j = 0; j < half; j++) {
          const wr = cos[j * step], wi = sin[j * step];
          const a = off + (start + j) * stride;
          const b = a + half * stride;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  // In-place 2D inverse DFT of an n*n row-major grid. The row pass runs as a
  // column pass on the transposed grid, so both passes use the fast path.
  inverse2D(re, im) {
    this.inverseColumns(re, im);
    transpose(re, this.n);
    transpose(im, this.n);
    this.inverseColumns(re, im);
    transpose(re, this.n);
    transpose(im, this.n);
  }

  // Transforms all columns at once: each butterfly works on two whole rows,
  // so the inner loop walks contiguous memory instead of striding by n.
  // About 4x faster than calling inverse() per column at n = 256.
  inverseColumns(re, im) {
    const { n, rev, cos, sin } = this;

    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const a = i * n, b = j * n;
        for (let x = 0; x < n; x++) {
          let t = re[a + x]; re[a + x] = re[b + x]; re[b + x] = t;
          t = im[a + x]; im[a + x] = im[b + x]; im[b + x] = t;
        }
      }
    }

    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let j = 0; j < half; j++) {
          const wr = cos[j * step], wi = sin[j * step];
          const a = (start + j) * n;
          const b = a + half * n;
          for (let x = 0; x < n; x++) {
            const br = re[b + x], bi = im[b + x];
            const tr = br * wr - bi * wi;
            const ti = br * wi + bi * wr;
            const ar = re[a + x], ai = im[a + x];
            re[b + x] = ar - tr; im[b + x] = ai - ti;
            re[a + x] = ar + tr; im[a + x] = ai + ti;
          }
        }
      }
    }
  }
}

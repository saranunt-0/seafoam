// Tessendorf-style FFT ocean ("Simulating Ocean Water", 2001) on the CPU.
//
// Each frame we evolve a Phillips spectrum in time and run 4 complex inverse
// FFTs. Every FFT carries two real fields (A + iB), which works because each
// field's spectrum is Hermitian, so its inverse transform is purely real.
//
// The output that matters for foam is the Jacobian J of the horizontal
// ("choppy") displacement. J < 1 means the surface is being squeezed, J < 0
// means it folded over itself: that is where a real wave would break.

import { FFT } from './fft.js';

const G = 9.81;

export const DEFAULT_OCEAN = {
  size: 256,          // grid resolution N (power of two)
  patchSize: 256,     // metres covered by one tile
  windSpeed: 11,      // m/s
  windDirection: 0.5, // radians, direction the waves travel
  choppiness: 1.3,    // lambda in x' = x + lambda * D(x)
  waveScale: 1.0,     // multiplier on the fully-developed-sea wave height
  alignment: 2.0,     // exponent on |k.w|, higher = waves more parallel to the wind
  seed: 7,
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Ocean {
  constructor(options = {}) {
    this.params = { ...DEFAULT_OCEAN, ...options };
    const n = this.params.size;
    this.n = n;
    this.fft = new FFT(n);
    const count = n * n;

    // Frequency-space data, constant per spectrum.
    this.kx = new Float32Array(count);
    this.kz = new Float32Array(count);
    this.kLen = new Float32Array(count);
    this.omega = new Float32Array(count);
    this.minusIndex = new Uint32Array(count);
    this.h0r = new Float32Array(count);
    this.h0i = new Float32Array(count);

    // Gaussian random numbers are drawn once so that changing the wind
    // re-shapes the same sea instead of rolling a new one.
    const rand = mulberry32(this.params.seed);
    this.xi1 = new Float32Array(count);
    this.xi2 = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const u1 = Math.max(rand(), 1e-12), u2 = rand();
      const r = Math.sqrt(-2 * Math.log(u1));
      this.xi1[i] = r * Math.cos(2 * Math.PI * u2);
      this.xi2[i] = r * Math.sin(2 * Math.PI * u2);
    }

    // Four complex FFT buffers, each carrying two real fields.
    this.re = [0, 1, 2, 3].map(() => new Float32Array(count));
    this.im = [0, 1, 2, 3].map(() => new Float32Array(count));

    // Spatial outputs (choppiness already applied to dx, dz and the j terms).
    this.h = new Float32Array(count);
    this.dx = new Float32Array(count);
    this.dz = new Float32Array(count);
    this.sx = new Float32Array(count);   // dh/dx
    this.sz = new Float32Array(count);   // dh/dz
    this.jxx = new Float32Array(count);  // 1 + lambda dDx/dx
    this.jzz = new Float32Array(count);  // 1 + lambda dDz/dz
    this.jxz = new Float32Array(count);  // lambda dDx/dz
    this.jacobian = new Float32Array(count);

    this.time = 0;
    this.stats = { heightStd: 0, minJacobian: 1 };
    this.rebuildSpectrum();
  }

  setParams(changes) {
    const before = this.params;
    this.params = { ...before, ...changes };
    if (this.params.size !== before.size || this.params.seed !== before.seed) {
      throw new Error('size and seed are fixed per Ocean instance; create a new one');
    }
    const spectral = ['patchSize', 'windSpeed', 'windDirection', 'waveScale', 'alignment'];
    if (spectral.some((key) => this.params[key] !== before[key])) this.rebuildSpectrum();
  }

  // Significant wave height of a fully developed sea (Pierson-Moskowitz), scaled.
  targetWaveHeight() {
    const { windSpeed, waveScale } = this.params;
    return 0.21 * windSpeed * windSpeed / G * waveScale;
  }

  rebuildSpectrum() {
    const { n } = this;
    const { patchSize, windSpeed, windDirection, alignment } = this.params;
    // With h~ = h0(k) e^{iwt} + ... summed as e^{ik.x}, the h0(k) term moves
    // toward -k. Aligning the spectrum with -wind makes the sea run downwind.
    const wx = -Math.cos(windDirection), wz = -Math.sin(windDirection);
    const L = Math.max(windSpeed * windSpeed / G, 1e-3); // largest wave from this wind
    const smallest = patchSize / n * 0.5;                  // damp waves below grid resolution
    const phillips = new Float32Array(n * n);
    let sum = 0;

    for (let zi = 0; zi < n; zi++) {
      for (let xi = 0; xi < n; xi++) {
        const i = zi * n + xi;
        // FFT bin -> signed frequency, so no fftshift is needed afterwards.
        const fx = xi < n / 2 ? xi : xi - n;
        const fz = zi < n / 2 ? zi : zi - n;
        const kx = (2 * Math.PI * fx) / patchSize;
        const kz = (2 * Math.PI * fz) / patchSize;
        const k = Math.hypot(kx, kz);
        this.kx[i] = kx;
        this.kz[i] = kz;
        this.kLen[i] = k;
        this.omega[i] = Math.sqrt(G * k);
        this.minusIndex[i] = ((n - zi) % n) * n + ((n - xi) % n);

        // Zero the DC term and the Nyquist row/column: their "-k" partner is
        // themselves, which would break the Hermitian symmetry we rely on.
        if (k === 0 || xi === n / 2 || zi === n / 2) continue;

        const kDotW = (kx * wx + kz * wz) / k;
        let p = Math.exp(-1 / (k * L * k * L)) / (k * k * k * k);
        p *= Math.pow(Math.abs(kDotW), alignment);
        if (kDotW < 0) p *= 0.07; // waves running against the wind are weak
        p *= Math.exp(-k * k * smallest * smallest);
        phillips[i] = p;
        sum += p;
      }
    }

    // Var(h) = 2 * sum(P) for this construction; scale so that the significant
    // wave height (4 standard deviations) matches the wind speed.
    const targetStd = this.targetWaveHeight() / 4;
    const amplitude = sum > 0 ? (targetStd * targetStd) / (2 * sum) : 0;
    for (let i = 0; i < n * n; i++) {
      const s = Math.sqrt(amplitude * phillips[i] / 2);
      this.h0r[i] = this.xi1[i] * s;
      this.h0i[i] = this.xi2[i] * s;
    }
  }

  update(time) {
    this.time = time;
    const { n, kx: KX, kz: KZ, kLen, omega, minusIndex, h0r, h0i } = this;
    const [r1, r2, r3, r4] = this.re;
    const [i1, i2, i3, i4] = this.im;
    const count = n * n;

    for (let i = 0; i < count; i++) {
      const k = kLen[i];
      if (k === 0) {
        r1[i] = i1[i] = r2[i] = i2[i] = r3[i] = i3[i] = r4[i] = i4[i] = 0;
        continue;
      }
      const w = omega[i] * time;
      const c = Math.cos(w), s = Math.sin(w);
      const m = minusIndex[i];
      // h~(k,t) = h0(k) e^{iwt} + conj(h0(-k)) e^{-iwt}
      const ar = h0r[i], ai = h0i[i];
      const br = h0r[m], bi = -h0i[m];
      const hr = ar * c - ai * s + br * c + bi * s;
      const hi = ar * s + ai * c + bi * c - br * s;

      const kx = KX[i], kz = KZ[i];
      const ux = kx / k, uz = kz / k;

      // Spectral multipliers. Real factor r: (r*hr, r*hi). Imaginary i*s: (-s*hi, s*hr).
      //   h: 1            Dx: i kx/k        Dz: i kz/k
      //   dh/dx: i kx     dh/dz: i kz
      //   dDx/dx: -kx^2/k dDz/dz: -kz^2/k   dDx/dz: -kx kz/k
      // Packed as A + iB  =>  (Ar - Bi, Ai + Br).

      // FFT 1: A = h, B = Dx
      {
        const Ar = hr, Ai = hi;
        const Br = -ux * hi, Bi = ux * hr;
        r1[i] = Ar - Bi; i1[i] = Ai + Br;
      }
      // FFT 2: A = Dz, B = dh/dx
      {
        const Ar = -uz * hi, Ai = uz * hr;
        const Br = -kx * hi, Bi = kx * hr;
        r2[i] = Ar - Bi; i2[i] = Ai + Br;
      }
      // FFT 3: A = dh/dz, B = dDx/dx
      {
        const Ar = -kz * hi, Ai = kz * hr;
        const f = -kx * ux;
        const Br = f * hr, Bi = f * hi;
        r3[i] = Ar - Bi; i3[i] = Ai + Br;
      }
      // FFT 4: A = dDz/dz, B = dDx/dz
      {
        const fa = -kz * uz, fb = -kx * uz;
        const Ar = fa * hr, Ai = fa * hi;
        const Br = fb * hr, Bi = fb * hi;
        r4[i] = Ar - Bi; i4[i] = Ai + Br;
      }
    }

    for (let f = 0; f < 4; f++) this.fft.inverse2D(this.re[f], this.im[f]);

    const lambda = this.params.choppiness;
    let sumSq = 0, minJ = Infinity;
    for (let i = 0; i < count; i++) {
      const h = r1[i];
      this.h[i] = h;
      this.dx[i] = lambda * i1[i];
      this.dz[i] = lambda * r2[i];
      this.sx[i] = i2[i];
      this.sz[i] = r3[i];
      const jxx = 1 + lambda * i3[i];
      const jzz = 1 + lambda * r4[i];
      const jxz = lambda * i4[i];
      this.jxx[i] = jxx;
      this.jzz[i] = jzz;
      this.jxz[i] = jxz;
      const J = jxx * jzz - jxz * jxz;
      this.jacobian[i] = J;
      sumSq += h * h;
      if (J < minJ) minJ = J;
    }
    this.stats.heightStd = Math.sqrt(sumSq / count);
    this.stats.minJacobian = minJ;
  }

  // Texture layout used by the water shader:
  //   A = (dx, h, dz, J)      B = (dh/dx, dh/dz, jxx, jzz)
  packTextures(outA, outB) {
    const count = this.n * this.n;
    for (let i = 0, o = 0; i < count; i++, o += 4) {
      outA[o] = this.dx[i];
      outA[o + 1] = this.h[i];
      outA[o + 2] = this.dz[i];
      outA[o + 3] = this.jacobian[i];
      outB[o] = this.sx[i];
      outB[o + 1] = this.sz[i];
      outB[o + 2] = this.jxx[i];
      outB[o + 3] = this.jzz[i];
    }
  }

  heightAt(x, z) {
    const fields = [this.dx, this.h, this.dz, this.jacobian];
    const { n } = this, { patchSize } = this.params;
    return surfaceAt((f, px, pz) => sampleGrid(fields[f], 1, 0, n, patchSize, px, pz), x, z).height;
  }
}

// Bilinear, wrapping lookup of one channel of an n*n grid at an undisplaced
// world position. `stride`/`channel` let it read interleaved texture data.
export function sampleGrid(data, stride, channel, n, patchSize, x, z) {
  const scale = n / patchSize;
  const gx = x * scale, gz = z * scale;
  const x0 = Math.floor(gx), z0 = Math.floor(gz);
  const tx = gx - x0, tz = gz - z0;
  const xa = ((x0 % n) + n) % n, xb = (xa + 1) % n;
  const za = ((z0 % n) + n) % n, zb = (za + 1) % n;
  const a = data[(za * n + xa) * stride + channel], b = data[(za * n + xb) * stride + channel];
  const c = data[(zb * n + xa) * stride + channel], d = data[(zb * n + xb) * stride + channel];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

// The surface above world point (x, z). Choppy waves push the surface sideways
// by (dx, dz), so walk back to the undisplaced point that ended up here.
// `sample(field, x, z)` reads field 0 = dx, 1 = h, 2 = dz, 3 = J.
export function surfaceAt(sample, x, z) {
  let ux = x, uz = z;
  for (let iter = 0; iter < 3; iter++) {
    const ox = sample(0, ux, uz);
    const oz = sample(2, ux, uz);
    ux = x - ox;
    uz = z - oz;
  }
  return { height: sample(1, ux, uz), jacobian: sample(3, ux, uz) };
}

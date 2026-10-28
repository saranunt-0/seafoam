import test from 'node:test';
import assert from 'node:assert/strict';
import { FFT } from '../src/fft.js';
import { Ocean, sampleGrid, surfaceAt } from '../src/ocean.js';
import { toHalfArray, fromHalf } from '../src/half.js';

function randomComplex(count, seed = 1) {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const re = new Float32Array(count), im = new Float32Array(count);
  for (let i = 0; i < count; i++) { re[i] = rand(); im[i] = rand(); }
  return { re, im };
}

function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

test('1D inverse FFT matches a naive DFT', () => {
  const n = 16;
  const { re, im } = randomComplex(n, 3);
  const expRe = new Float32Array(n), expIm = new Float32Array(n);
  for (let m = 0; m < n; m++) {
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k * m) / n;
      expRe[m] += re[k] * Math.cos(a) - im[k] * Math.sin(a);
      expIm[m] += re[k] * Math.sin(a) + im[k] * Math.cos(a);
    }
  }
  new FFT(n).inverse(re, im);
  assert.ok(maxAbsDiff(re, expRe) < 1e-4);
  assert.ok(maxAbsDiff(im, expIm) < 1e-4);
});

test('2D inverse FFT matches a naive 2D DFT', () => {
  const n = 8;
  const { re, im } = randomComplex(n * n, 11);
  const expRe = new Float32Array(n * n), expIm = new Float32Array(n * n);
  for (let my = 0; my < n; my++) for (let mx = 0; mx < n; mx++) {
    let sr = 0, si = 0;
    for (let ky = 0; ky < n; ky++) for (let kx = 0; kx < n; kx++) {
      const a = (2 * Math.PI * (kx * mx + ky * my)) / n;
      const r = re[ky * n + kx], i = im[ky * n + kx];
      sr += r * Math.cos(a) - i * Math.sin(a);
      si += r * Math.sin(a) + i * Math.cos(a);
    }
    expRe[my * n + mx] = sr; expIm[my * n + mx] = si;
  }
  new FFT(n).inverse2D(re, im);
  assert.ok(maxAbsDiff(re, expRe) < 1e-4);
  assert.ok(maxAbsDiff(im, expIm) < 1e-4);
});

test('FFT rejects sizes that are not powers of two', () => {
  assert.throws(() => new FFT(12));
});

// Evaluate one ocean field straight from its definition, sum_k mult(k) h~(k,t) e^{ik.x},
// so the packed two-fields-per-FFT trick in Ocean.update is checked independently.
function naiveField(ocean, t, mult) {
  const { n } = ocean;
  const L = ocean.params.patchSize;
  const outRe = new Float64Array(n * n), outIm = new Float64Array(n * n);
  const ht = [];
  for (let i = 0; i < n * n; i++) {
    const w = ocean.omega[i] * t, c = Math.cos(w), s = Math.sin(w), m = ocean.minusIndex[i];
    const ar = ocean.h0r[i], ai = ocean.h0i[i], br = ocean.h0r[m], bi = -ocean.h0i[m];
    ht.push([ar * c - ai * s + br * c + bi * s, ar * s + ai * c + bi * c - br * s]);
  }
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    const px = (x * L) / n, pz = (z * L) / n;
    let sr = 0, si = 0;
    for (let i = 0; i < n * n; i++) {
      const k = ocean.kLen[i];
      if (k === 0) continue;
      const [mr, mi] = mult(ocean.kx[i], ocean.kz[i], k);
      const fr = mr * ht[i][0] - mi * ht[i][1];
      const fi = mr * ht[i][1] + mi * ht[i][0];
      const a = ocean.kx[i] * px + ocean.kz[i] * pz;
      sr += fr * Math.cos(a) - fi * Math.sin(a);
      si += fr * Math.sin(a) + fi * Math.cos(a);
    }
    outRe[z * n + x] = sr; outIm[z * n + x] = si;
  }
  return { re: outRe, im: outIm };
}

test('every packed ocean field matches its direct spectral sum and is real', () => {
  const lambda = 1.5;
  const ocean = new Ocean({ size: 16, patchSize: 64, windSpeed: 9, choppiness: lambda });
  const t = 2.7;
  ocean.update(t);

  const cases = [
    ['h', (kx, kz, k) => [1, 0], (v) => v],
    ['dx', (kx, kz, k) => [0, kx / k], (v) => lambda * v],
    ['dz', (kx, kz, k) => [0, kz / k], (v) => lambda * v],
    ['sx', (kx) => [0, kx], (v) => v],
    ['sz', (kx, kz) => [0, kz], (v) => v],
    ['jxx', (kx, kz, k) => [-kx * kx / k, 0], (v) => 1 + lambda * v],
    ['jzz', (kx, kz, k) => [-kz * kz / k, 0], (v) => 1 + lambda * v],
    ['jxz', (kx, kz, k) => [-kx * kz / k, 0], (v) => lambda * v],
  ];
  for (const [name, mult, finish] of cases) {
    const { re, im } = naiveField(ocean, t, mult);
    const scale = Math.max(...re.map(Math.abs), 1e-6);
    let maxImag = 0, maxErr = 0;
    for (let i = 0; i < re.length; i++) {
      maxImag = Math.max(maxImag, Math.abs(im[i]));
      maxErr = Math.max(maxErr, Math.abs(finish(re[i]) - ocean[name][i]));
    }
    assert.ok(maxImag < 1e-4 * scale + 1e-6, `${name} should be real, imag ${maxImag}`);
    assert.ok(maxErr < 1e-3 * Math.max(scale, 1), `${name} mismatch ${maxErr}`);
  }
});

test('zero choppiness gives no horizontal motion and a Jacobian of exactly 1', () => {
  const ocean = new Ocean({ size: 32, choppiness: 0 });
  ocean.update(4.2);
  for (let i = 0; i < ocean.jacobian.length; i++) {
    assert.ok(ocean.dx[i] === 0 && ocean.dz[i] === 0, `cell ${i} moved sideways`);
    assert.equal(ocean.jacobian[i], 1);
  }
});

test('wave height follows the wind speed (Pierson-Moskowitz Hs = 0.21 U^2 / g)', () => {
  for (const windSpeed of [6, 12, 18]) {
    const ocean = new Ocean({ size: 128, windSpeed, patchSize: 512 });
    ocean.update(1.0);
    const expectedStd = ocean.targetWaveHeight() / 4;
    const ratio = ocean.stats.heightStd / expectedStd;
    assert.ok(ratio > 0.7 && ratio < 1.3, `wind ${windSpeed}: std ratio ${ratio.toFixed(2)}`);
  }
});

test('choppiness and wave height control whether the surface folds (J < 0)', () => {
  const calm = new Ocean({ size: 128, choppiness: 0.5 });
  calm.update(3);
  assert.ok(calm.stats.minJacobian > 0.5, `calm min J ${calm.stats.minJacobian}`);

  // A Pierson-Moskowitz sea is rarely steep enough to fold, which is why the
  // foam pass thresholds J well above 0. Pushing the waves up makes it fold.
  const stormy = new Ocean({ size: 128, choppiness: 2.0, waveScale: 2.0 });
  stormy.update(3);
  assert.ok(stormy.stats.minJacobian < 0, `stormy min J ${stormy.stats.minJacobian}`);
});

test('heightAt finds the displaced surface above a world point', () => {
  const ocean = new Ocean({ size: 64, choppiness: 1.0 });
  ocean.update(5);
  const step = ocean.params.patchSize / ocean.n;
  for (const [x, z] of [[3, 4], [20, 50], [33, 7]]) {
    const i = z * ocean.n + x;
    const wx = x * step + ocean.dx[i], wz = z * step + ocean.dz[i];
    const err = Math.abs(ocean.heightAt(wx, wz) - ocean.h[i]);
    assert.ok(err < 0.05 + 0.05 * Math.abs(ocean.h[i]), `point ${x},${z} err ${err}`);
  }
});

test('changing the wind keeps the same random sea (smooth slider changes)', () => {
  const ocean = new Ocean({ size: 32 });
  const before = Float32Array.from(ocean.xi1);
  ocean.setParams({ windSpeed: 15 });
  assert.deepEqual(ocean.xi1, before);
  assert.throws(() => ocean.setParams({ size: 64 }));
});

test('packed texture data samples the same surface as the separate fields', () => {
  const ocean = new Ocean({ size: 32, choppiness: 1.2 });
  ocean.update(1.5);
  const count = ocean.n * ocean.n;
  const A = new Float32Array(count * 4), B = new Float32Array(count * 4);
  ocean.packTextures(A, B);
  const { n } = ocean, { patchSize } = ocean.params;
  const packed = (f, x, z) => sampleGrid(A, 4, f, n, patchSize, x, z);
  for (const [x, z] of [[1.3, 2.9], [100.2, -40.7], [-3, 250]]) {
    assert.ok(Math.abs(surfaceAt(packed, x, z).height - ocean.heightAt(x, z)) < 1e-5);
  }
});

test('half-float conversion keeps ocean-scale values accurate', () => {
  const values = new Float32Array([0, 1, -1, 0.5, 3.14159, -12.75, 0.001, 65504, 1e-6, 1e6]);
  const half = toHalfArray(values);
  for (let i = 0; i < values.length; i++) {
    const v = values[i], back = fromHalf(half[i]);
    if (Math.abs(v) > 65504) assert.equal(back, Infinity * Math.sign(v));
    else if (Math.abs(v) < 6e-5) assert.ok(Math.abs(back - v) < 6e-5);
    else assert.ok(Math.abs(back - v) / Math.abs(v) < 1e-3, `${v} -> ${back}`);
  }
});

test('waves travel along the wind direction', () => {
  // Wind along +x. After a short time the field should look like the earlier
  // field shifted toward +x, not toward -x.
  const ocean = new Ocean({ size: 64, patchSize: 128, windSpeed: 10, windDirection: 0, choppiness: 0 });
  ocean.update(10);
  const before = Float32Array.from(ocean.h);
  const cell = ocean.params.patchSize / ocean.n;
  const peakSpeed = 0.88 * ocean.params.windSpeed;  // rough phase speed of the dominant waves
  ocean.update(10 + (3 * cell) / peakSpeed);         // about 3 cells of travel
  const n = ocean.n;
  const correlation = (shift) => {
    let sum = 0;
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
      sum += ocean.h[z * n + x] * before[z * n + ((x - shift + n) % n)];
    }
    return sum;
  };
  assert.ok(correlation(3) > correlation(-3), `forward ${correlation(3)} vs backward ${correlation(-3)}`);
});

test('crests are where the surface compresses (high h goes with low J)', () => {
  const ocean = new Ocean({ size: 64, choppiness: 1.5 });
  ocean.update(2);
  let cov = 0;
  for (let i = 0; i < ocean.h.length; i++) cov += ocean.h[i] * (ocean.jacobian[i] - 1);
  assert.ok(cov < 0, `cov(h, J) = ${cov}`);
});

// Procedural, tileable stand-in for an artist-painted foam texture.
// Pure data (no three.js) so it can be unit tested in Node.
//
//   R  foam pattern: Voronoi "lace" (bright cell borders, like bubble walls)
//      mixed with smooth noise for organic blob shapes, then histogram-
//      equalized. Because R is uniform on [0, 1], the shader's dissolve test
//      `R > 1 - mask` covers almost exactly `mask` of the surface.
//   G  bubbles: round dots of random size for sparkle at foam edges.
//   B  smooth noise for UV wobble.

function makeRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Nearest and second-nearest feature point distances on a wrapping grid.
function worley(size, cells, rand) {
  const points = new Float32Array(cells * cells * 2);
  const radii = new Float32Array(cells * cells);
  for (let i = 0; i < cells * cells; i++) {
    points[i * 2] = 0.1 + 0.8 * rand();
    points[i * 2 + 1] = 0.1 + 0.8 * rand();
    radii[i] = 0.25 + 0.35 * rand();
  }
  const f1 = new Float32Array(size * size);
  const f2 = new Float32Array(size * size);
  const radius = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = ((x + 0.5) / size) * cells, py = ((y + 0.5) / size) * cells;
      const cx = Math.floor(px), cy = Math.floor(py);
      let d1 = 1e9, d2 = 1e9, r1 = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gx = cx + ox, gy = cy + oy;
          const k = (((gy % cells) + cells) % cells) * cells + (((gx % cells) + cells) % cells);
          const d = Math.hypot(gx + points[k * 2] - px, gy + points[k * 2 + 1] - py);
          if (d < d1) { d2 = d1; d1 = d; r1 = radii[k]; } else if (d < d2) { d2 = d; }
        }
      }
      const i = y * size + x;
      f1[i] = d1;
      f2[i] = d2;
      radius[i] = r1;
    }
  }
  return { f1, f2, radius };
}

function valueNoise(size, cells, rand) {
  const grid = new Float32Array(cells * cells).map(() => rand());
  const out = new Float32Array(size * size);
  const smooth = (t) => t * t * (3 - 2 * t);
  const at = (gx, gy) => grid[(gy % cells) * cells + (gx % cells)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x / size) * cells, py = (y / size) * cells;
      const x0 = Math.floor(px), y0 = Math.floor(py);
      const tx = smooth(px - x0), ty = smooth(py - y0);
      const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
      out[y * size + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return out;
}

// Remap values so their histogram is flat on [0, 1].
function equalize(values, bins = 4096) {
  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  const scale = (bins - 1) / (max - min || 1);
  const counts = new Uint32Array(bins);
  for (const v of values) counts[Math.round((v - min) * scale)]++;
  const cdf = new Float32Array(bins);
  let running = 0;
  for (let b = 0; b < bins; b++) {
    cdf[b] = (running + counts[b] * 0.5) / values.length;
    running += counts[b];
  }
  return values.map((v) => cdf[Math.round((v - min) * scale)]);
}

export function generateFoamPattern(size = 256, seed = 1337) {
  const rand = makeRandom(seed);
  const laceA = worley(size, 7, rand);
  const laceB = worley(size, 17, rand);
  const dots = worley(size, 26, rand);
  const noiseA = valueNoise(size, 4, rand);
  const noiseB = valueNoise(size, 9, rand);
  const noiseC = valueNoise(size, 23, rand);

  const count = size * size;
  const combined = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const a = 1 - Math.min((laceA.f2[i] - laceA.f1[i]) / 0.5, 1);
    const b = 1 - Math.min((laceB.f2[i] - laceB.f1[i]) / 0.5, 1);
    const n = noiseA[i] * 0.55 + noiseB[i] * 0.3 + noiseC[i] * 0.15;
    combined[i] = a * 0.38 + b * 0.2 + n * 0.42;
  }
  const foam = equalize(combined);

  const data = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const bubble = Math.max(0, 1 - dots.f1[i] / dots.radius[i]);
    data[i * 4] = Math.round(foam[i] * 255);
    data[i * 4 + 1] = Math.round(Math.sqrt(bubble) * 255);
    data[i * 4 + 2] = Math.round((noiseA[i] * 0.6 + noiseC[i] * 0.4) * 255);
    data[i * 4 + 3] = 255;
  }
  return { data, size };
}

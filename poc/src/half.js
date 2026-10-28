// Float32 -> float16 conversion for devices without linear filtering of
// 32-bit float textures (OES_texture_float_linear), mostly mobile GPUs.
// Table method from Jeroen van der Zijp, "Fast Half Float Conversions" (2008).

const baseTable = new Uint32Array(512);
const shiftTable = new Uint32Array(512);

for (let i = 0; i < 256; i++) {
  const e = i - 127;
  let base, shift;
  if (e < -27) { base = 0x0000; shift = 24; }               // too small: zero
  else if (e < -14) { base = 0x0400 >> (-e - 14); shift = -e - 1; } // denormal
  else if (e <= 15) { base = (e + 15) << 10; shift = 13; }   // normal
  else if (e < 128) { base = 0x7c00; shift = 24; }           // overflow: infinity
  else { base = 0x7c00; shift = 13; }                        // infinity and NaN
  baseTable[i] = base;
  baseTable[i | 0x100] = base | 0x8000;
  shiftTable[i] = shift;
  shiftTable[i | 0x100] = shift;
}

export function toHalfArray(src, dst = new Uint16Array(src.length)) {
  const bits = new Uint32Array(src.buffer, src.byteOffset, src.length);
  for (let i = 0; i < src.length; i++) {
    const f = bits[i];
    const e = (f >> 23) & 0x1ff;
    dst[i] = baseTable[e] + ((f & 0x007fffff) >> shiftTable[e]);
  }
  return dst;
}

export function fromHalf(h) {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

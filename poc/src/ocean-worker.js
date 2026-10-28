// Runs the FFT ocean off the main thread. The main thread sends `step` with
// buffers to fill and gets them back filled, so no per-frame allocation.

import { Ocean } from './ocean.js';
import { toHalfArray } from './half.js';

let ocean = null;

function ensureSize(array, length, Type) {
  return array && array.length === length ? array : new Type(length);
}

self.onmessage = ({ data: msg }) => {
  if (msg.type === 'params') {
    const next = { ...(ocean ? ocean.params : {}), ...msg.params };
    if (!ocean || next.size !== ocean.params.size || next.seed !== ocean.params.seed) {
      ocean = new Ocean(next);
    } else {
      ocean.setParams(msg.params);
    }
    return;
  }

  if (msg.type === 'step') {
    const t0 = performance.now();
    ocean.update(msg.time);
    const length = ocean.n * ocean.n * 4;
    const A = ensureSize(msg.A, length, Float32Array);
    const B = ensureSize(msg.B, length, Float32Array);
    ocean.packTextures(A, B);
    const frame = {
      type: 'frame', time: msg.time, n: ocean.n, patchSize: ocean.params.patchSize,
      stats: { ...ocean.stats }, A, B, HA: null, HB: null,
    };
    const transfer = [A.buffer, B.buffer];
    if (msg.half) {
      frame.HA = toHalfArray(A, ensureSize(msg.HA, length, Uint16Array));
      frame.HB = toHalfArray(B, ensureSize(msg.HB, length, Uint16Array));
      transfer.push(frame.HA.buffer, frame.HB.buffer);
    }
    frame.stats.ms = performance.now() - t0;
    self.postMessage(frame, transfer);
  }
};

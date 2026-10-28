// Keeps the latest ocean frame for the renderer and for CPU queries (boat
// buoyancy, spray emission). Prefers a Web Worker; falls back to running the
// same code on the main thread if module workers are unavailable.

import { Ocean, sampleGrid, surfaceAt } from './ocean.js';
import { toHalfArray } from './half.js';

export class OceanDriver {
  constructor(params, { half = false } = {}) {
    this.params = { ...params };
    this.half = half;
    this.frame = null;      // latest {A, B, HA, HB, n, patchSize, time, stats}
    this.version = 0;       // bumps whenever `frame` changes
    this.spare = null;      // buffers to hand back to the worker
    this.busy = false;

    try {
      this.worker = new Worker(new URL('./ocean-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }) => this.receive(data);
      this.worker.onerror = (event) => {
        console.warn('Ocean worker failed, running on the main thread instead.', event.message);
        this.worker = null;
        this.busy = false;
        this.local = new Ocean(this.params);
      };
      this.worker.postMessage({ type: 'params', params: this.params });
    } catch (error) {
      console.warn('Module workers unavailable, running the ocean on the main thread.', error);
      this.worker = null;
      this.local = new Ocean(this.params);
    }

    // Lets CPU queries read the latest frame as fields 0..3 = dx, h, dz, J.
    this.sampler = (field, x, z) =>
      sampleGrid(this.frame.A, 4, field, this.frame.n, this.frame.patchSize, x, z);
  }

  setParams(changes) {
    Object.assign(this.params, changes);
    if (this.worker) {
      this.worker.postMessage({ type: 'params', params: changes });
    } else if (changes.size !== undefined && changes.size !== this.local.n) {
      this.local = new Ocean(this.params);
    } else {
      this.local.setParams(changes);
    }
  }

  // Ask for the ocean at `time`. With a worker the result lands a frame later.
  request(time) {
    if (this.worker) {
      if (this.busy) return;
      this.busy = true;
      const spare = this.spare || {};
      this.spare = null;
      const transfer = [spare.A, spare.B, spare.HA, spare.HB].filter(Boolean).map((a) => a.buffer);
      this.worker.postMessage({ type: 'step', time, half: this.half, ...spare }, transfer);
      return;
    }

    const t0 = performance.now();
    const ocean = this.local;
    ocean.update(time);
    const length = ocean.n * ocean.n * 4;
    const reuse = this.frame && this.frame.A.length === length ? this.frame : null;
    const A = reuse ? reuse.A : new Float32Array(length);
    const B = reuse ? reuse.B : new Float32Array(length);
    ocean.packTextures(A, B);
    const frame = { time, n: ocean.n, patchSize: ocean.params.patchSize, stats: { ...ocean.stats }, A, B };
    if (this.half) {
      frame.HA = toHalfArray(A, reuse?.HA ?? undefined);
      frame.HB = toHalfArray(B, reuse?.HB ?? undefined);
    }
    frame.stats.ms = performance.now() - t0;
    this.frame = frame;
    this.version++;
  }

  receive(frame) {
    this.busy = false;
    if (this.frame) {
      const { A, B, HA, HB } = this.frame;
      this.spare = { A, B, HA, HB };
    }
    this.frame = frame;
    this.version++;
  }

  get ready() {
    return this.frame !== null;
  }

  // Surface height and Jacobian at a world position, from the latest frame.
  surfaceAt(x, z) {
    if (!this.frame) return { height: 0, jacobian: 1 };
    return surfaceAt(this.sampler, x, z);
  }

  // Undisplaced grid cell i of the latest frame: returns fields for emitters.
  cell(i) {
    const { A } = this.frame;
    return { dx: A[i * 4], h: A[i * 4 + 1], dz: A[i * 4 + 2], jacobian: A[i * 4 + 3] };
  }
}

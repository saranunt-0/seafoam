# seafoam
Foam and bubble for fluid Simulation

Stylized, low-detail sea foam that can sit on top of common fluid simulation algorithms.

## Stage 1: research and proof of concept

- **[Research notes](docs/research.md):** how Sea of Thieves, Crest, Atlas, Unity HDRP, Houdini and
  others make foam, broken into one shared model (source, persistence, decay, look), and how feasible it
  is to apply that to FFT, Gerstner, shallow-water, Eulerian and SPH/FLIP solvers.
- **[Proof of concept](poc/):** a browser demo of a Tessendorf FFT ocean with stylized foam. It has
  whitecaps from the Jacobian, a boat wake, contact foam from the depth buffer, rings around rocks and spray
  particles, plus Calm / Normal / Stormy presets.

### Run the demo

Requires Node 18 or newer, and an internet connection (three.js and lil-gui load from the jsDelivr CDN).

```sh
npm start          # serves poc/ on http://localhost:8080
npm test           # FFT, ocean and foam-pattern unit tests
```

Open the **Foam layers** folder to switch each foam source on and off. **Look → Debug view** shows the
Jacobian, the foam buffers and the foam mask before stylization.

### Layout

```
docs/research.md         stage 1 research
poc/index.html           demo page
poc/src/fft.js           radix-2 FFT
poc/src/ocean.js         Tessendorf ocean: Phillips spectrum, choppy displacement, Jacobian
poc/src/ocean-worker.js  runs the ocean in a Web Worker
poc/src/foam.js          GPU foam feedback passes (whitecaps, wake)
poc/src/water.js         water, foam compositing and sky shaders
poc/src/pattern.js       procedural, histogram-equalized foam texture
poc/src/spray.js         spray particles
poc/src/props.js         boat and rocks
poc/src/main.js          scene, presets and controls
poc/tests/               node:test unit tests
```

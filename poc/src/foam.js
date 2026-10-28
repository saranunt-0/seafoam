// GPU foam fields. Both are "feedback" textures: each frame reads last
// frame's foam, lets it spread and fade, then adds new foam from a source.
//
//   foam(t + dt) = max(spread(foam(t)) * exp(-dt / decay), source)
//
// This one rule covers every foam type in the demo; only the source differs.
//   WhitecapFoam  tile space, source = surface compression (Jacobian J < bias)
//   WakeFoam      world space, source = capsules stamped along the boat hull

import * as THREE from 'three';

const QUAD_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const SPREAD_AND_FADE = /* glsl */ `
uniform sampler2D uPrev;
uniform vec2 uTexel;
uniform float uDecay;   // exp(-dt / decay seconds)
uniform float uSpread;  // 0..1 blend toward the 4-neighbour average
uniform vec2 uDrift;    // uv offset per step: foam carried by wind or current
varying vec2 vUv;

float spreadAndFade() {
  vec2 uv = vUv - uDrift;
  float c = texture2D(uPrev, uv).r;
  float n = texture2D(uPrev, uv + vec2(uTexel.x, 0.0)).r
          + texture2D(uPrev, uv - vec2(uTexel.x, 0.0)).r
          + texture2D(uPrev, uv + vec2(0.0, uTexel.y)).r
          + texture2D(uPrev, uv - vec2(0.0, uTexel.y)).r;
  return mix(c, n * 0.25, uSpread) * uDecay;
}`;

const WHITECAP_FRAGMENT = /* glsl */ `
${SPREAD_AND_FADE}
uniform sampler2D uOcean;   // a = Jacobian
uniform float uBias;        // foam starts where J < bias
uniform float uGain;
uniform float uEnabled;

void main() {
  float J = texture2D(uOcean, vUv).a;
  float fresh = clamp((uBias - J) * uGain, 0.0, 1.0) * uEnabled;
  gl_FragColor = vec4(max(spreadAndFade(), fresh), fresh, 0.0, 1.0);
}`;

export const MAX_WAKE_STAMPS = 8;

const WAKE_FRAGMENT = /* glsl */ `
${SPREAD_AND_FADE}
uniform vec2 uCenter;
uniform float uSize;
uniform vec4 uStart[${MAX_WAKE_STAMPS}];  // x, z, radius, strength
uniform vec4 uEnd[${MAX_WAKE_STAMPS}];
uniform int uCount;

void main() {
  vec2 world = uCenter + (vUv - 0.5) * uSize;
  float source = 0.0;
  for (int i = 0; i < ${MAX_WAKE_STAMPS}; i++) {
    if (i >= uCount) break;
    vec2 a = uStart[i].xy, b = uEnd[i].xy, ab = b - a;
    float t = clamp(dot(world - a, ab) / max(dot(ab, ab), 1e-5), 0.0, 1.0);
    float d = length(world - (a + ab * t));
    float r = mix(uStart[i].z, uEnd[i].z, t);
    float s = mix(uStart[i].w, uEnd[i].w, t);
    source = max(source, s * (1.0 - smoothstep(r * 0.35, r, d)));
  }
  // Fade out near the border so foam never piles up against the clamp edge.
  vec2 edge = smoothstep(0.0, 0.05, vUv) * smoothstep(0.0, 0.05, 1.0 - vUv);
  float foam = max(spreadAndFade(), source) * edge.x * edge.y;
  gl_FragColor = vec4(foam, source, 0.0, 1.0);
}`;

class FeedbackPass {
  constructor(renderer, size, fragmentShader, uniforms, wrap) {
    this.renderer = renderer;
    this.wrap = wrap;
    this.material = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERTEX,
      fragmentShader,
      uniforms: {
        uPrev: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uDecay: { value: 0.99 },
        uSpread: { value: 0.2 },
        uDrift: { value: new THREE.Vector2() },
        ...uniforms,
      },
      depthTest: false,
      depthWrite: false,
    });
    this.uniforms = this.material.uniforms;
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
    this.targets = [];
    this.setSize(size);
  }

  setSize(size) {
    if (this.size === size) return;
    this.size = size;
    this.targets.forEach((t) => t.dispose());
    this.targets = [0, 1].map(() => new THREE.WebGLRenderTarget(size, size, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: this.wrap,
      wrapT: this.wrap,
      depthBuffer: false,
      generateMipmaps: false,
    }));
    this.uniforms.uTexel.value.set(1 / size, 1 / size);
    this.index = 0;
    this.clear();
  }

  clear() {
    const { renderer } = this;
    const previous = renderer.getRenderTarget();
    const color = renderer.getClearColor(new THREE.Color());
    const alpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    for (const target of this.targets) {
      renderer.setRenderTarget(target);
      renderer.clear(true, false, false);
    }
    renderer.setClearColor(color, alpha);
    renderer.setRenderTarget(previous);
  }

  get texture() {
    return this.targets[this.index].texture;
  }

  run(dt, decaySeconds, spreadRate) {
    const { renderer } = this;
    this.uniforms.uDecay.value = Math.exp(-dt / Math.max(decaySeconds, 0.05));
    this.uniforms.uSpread.value = 1 - Math.exp(-dt * spreadRate);
    this.uniforms.uPrev.value = this.targets[this.index].texture;
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(this.targets[1 - this.index]);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(previous);
    this.index = 1 - this.index;
  }
}

export class WhitecapFoam extends FeedbackPass {
  constructor(renderer, size) {
    super(renderer, size, WHITECAP_FRAGMENT, {
      uOcean: { value: null },
      uBias: { value: 0.8 },
      uGain: { value: 3 },
      uEnabled: { value: 1 },
    }, THREE.RepeatWrapping);
  }

  // drift: [x, z] in metres per second, patchSize: metres per tile.
  step(dt, oceanTexture, { bias, gain, decay, spread, enabled, drift, patchSize }) {
    this.uniforms.uOcean.value = oceanTexture;
    this.uniforms.uDrift.value.set(drift[0] * dt / patchSize, drift[1] * dt / patchSize);
    this.uniforms.uBias.value = bias;
    this.uniforms.uGain.value = gain;
    this.uniforms.uEnabled.value = enabled ? 1 : 0;
    this.run(dt, decay, spread);
  }
}

export class WakeFoam extends FeedbackPass {
  constructor(renderer, size, center, worldSize) {
    super(renderer, size, WAKE_FRAGMENT, {
      uCenter: { value: center.clone() },
      uSize: { value: worldSize },
      uStart: { value: Array.from({ length: MAX_WAKE_STAMPS }, () => new THREE.Vector4()) },
      uEnd: { value: Array.from({ length: MAX_WAKE_STAMPS }, () => new THREE.Vector4()) },
      uCount: { value: 0 },
    }, THREE.ClampToEdgeWrapping);
    this.center = center.clone();
    this.worldSize = worldSize;
  }

  // stamps: [{ from: [x, z], to: [x, z], radius: [r0, r1], strength: [s0, s1] }]
  step(dt, stamps, { decay, spread }) {
    const count = Math.min(stamps.length, MAX_WAKE_STAMPS);
    for (let i = 0; i < count; i++) {
      const s = stamps[i];
      this.uniforms.uStart.value[i].set(s.from[0], s.from[1], s.radius[0], s.strength[0]);
      this.uniforms.uEnd.value[i].set(s.to[0], s.to[1], s.radius[1], s.strength[1]);
    }
    this.uniforms.uCount.value = count;
    this.run(dt, decay, spread);
  }
}

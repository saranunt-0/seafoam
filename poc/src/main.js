import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { OceanDriver } from './ocean-driver.js';
import { WhitecapFoam, WakeFoam } from './foam.js';
import { createWaterGeometry, createWaterMaterial, createSky, MAX_ROCKS } from './water.js';
import { createFoamPatternTexture } from './textures.js';
import { Spray } from './spray.js';
import { createBoat, createRock } from './props.js';

// ---------------------------------------------------------------- settings

// Sea states follow Sea of Thieves' calm / normal / stormy split: the same
// foam rules, different sources, lifetimes and palette.
const PRESETS = {
  calm: {
    sea: { windSpeed: 6, choppiness: 0.9, waveScale: 1.1 },
    foam: { whitecapBias: 0.5, whitecapDecay: 3, sprayRate: 0.2 },
    palette: {
      skyTop: 0x4c8fd8, skyHorizon: 0xd2ecf6, sun: 0xfff1d8,
      deep: 0x0c4c70, shallow: 0x2cc7b2,
      foamLight: 0xffffff, foamShadow: 0xa9cde2, foamEdge: 0xc8f5f2,
      cloudLight: 0xffffff, cloudShadow: 0xbcd2e6, cloudCover: 0.32, fog: 0.0009,
    },
  },
  normal: {
    sea: { windSpeed: 11, choppiness: 1.45, waveScale: 1.25 },
    foam: { whitecapBias: 0.6, whitecapDecay: 6, sprayRate: 0.8 },
    palette: {
      skyTop: 0x3c7cc6, skyHorizon: 0xc2e1ef, sun: 0xffebc8,
      deep: 0x083d60, shallow: 0x1fb0a0,
      foamLight: 0xffffff, foamShadow: 0x9ec3d9, foamEdge: 0xbff0ee,
      cloudLight: 0xffffff, cloudShadow: 0xb4c9de, cloudCover: 0.45, fog: 0.0011,
    },
  },
  stormy: {
    sea: { windSpeed: 17, choppiness: 1.9, waveScale: 1.5 },
    foam: { whitecapBias: 0.64, whitecapDecay: 10, sprayRate: 2.2 },
    palette: {
      skyTop: 0x3a4955, skyHorizon: 0x8b9ba5, sun: 0xb9c6d0,
      deep: 0x0a2634, shallow: 0x2b7a72,
      foamLight: 0xe8f0f3, foamShadow: 0x7d97a4, foamEdge: 0xa6d3d2,
      cloudLight: 0xc5ced5, cloudShadow: 0x5b6974, cloudCover: 0.78, fog: 0.0021,
    },
  },
};

const params = {
  preset: 'normal',
  windSpeed: 11,
  windDirection: 35,        // degrees
  choppiness: 1.45,
  waveScale: 1.25,
  resolution: window.innerWidth < 700 ? 128 : 256,   // phones: keep the worker fast

  whitecapBias: 0.6,
  whitecapGain: 5.0,
  whitecapDecay: 6,
  whitecapSpread: 2.0,
  wakeDecay: 10,
  wakeSpread: 1.4,
  foamScale: 14,
  foamSoftness: 0.03,
  foamLift: 0.45,
  foamBump: 1.4,
  contactWidth: 1.6,
  sprayRate: 0.8,
  sprayThreshold: 0.45,

  whitecaps: true,
  wake: true,
  contact: true,
  rings: true,
  spray: true,

  toon: 0.75,
  sss: 1.0,
  timeScale: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.35 : 1.0,
  followBoat: true,
  debug: 'Final image',
};

const DEBUG_VIEWS = {
  'Final image': 0,
  'Jacobian J (red = folded)': 1,
  'Whitecap buffer': 2,
  'Wake buffer': 3,
  'Foam sources (R cap, G wake, B contact)': 4,
  'Foam after stylizing': 5,
};

const SUN_DIRECTION = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(72), THREE.MathUtils.degToRad(125));
const BOAT_PATH_RADIUS = 52;
const BOAT_SPEED = 7;     // m/s
const WAKE_AREA = 260;    // metres covered by the world-space wake buffer

// ---------------------------------------------------------------- renderer

const container = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, 1, 0.5, 6000);
camera.position.set(24, 10, 44);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = THREE.MathUtils.degToRad(86);
controls.minDistance = 8;
controls.maxDistance = 220;

const sunLight = new THREE.DirectionalLight(0xfff0d8, 2.4);
sunLight.position.copy(SUN_DIRECTION).multiplyScalar(100);
scene.add(sunLight);
const hemi = new THREE.HemisphereLight(0xbfe0f5, 0x1d4a5e, 1.1);
scene.add(hemi);

// Float textures need linear filtering for smooth waves; most desktops have
// it for 32-bit floats, everyone has it for 16-bit floats.
const halfFloat = !renderer.extensions.has('OES_texture_float_linear');

// ---------------------------------------------------------------- ocean + foam

const ocean = new OceanDriver({
  size: params.resolution,
  patchSize: 256,
  windSpeed: params.windSpeed,
  windDirection: THREE.MathUtils.degToRad(params.windDirection),
  choppiness: params.choppiness,
  waveScale: params.waveScale,
}, { half: halfFloat });

let oceanTexA = null, oceanTexB = null, oceanTexSize = 0, seenOceanVersion = -1;

function createOceanTexture(n) {
  const data = halfFloat ? new Uint16Array(n * n * 4) : new Float32Array(n * n * 4);
  const texture = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, halfFloat ? THREE.HalfFloatType : THREE.FloatType);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

const whitecaps = new WhitecapFoam(renderer, params.resolution);
const wake = new WakeFoam(renderer, 512, new THREE.Vector2(0, 0), WAKE_AREA);

function applyOceanFrame() {
  const frame = ocean.frame;
  if (frame.n !== oceanTexSize) {
    oceanTexA?.dispose();
    oceanTexB?.dispose();
    oceanTexA = createOceanTexture(frame.n);
    oceanTexB = createOceanTexture(frame.n);
    oceanTexSize = frame.n;
    whitecaps.setSize(frame.n);
    water.material.uniforms.uTexel.value = 0.5 / frame.n;
  }
  oceanTexA.image.data = halfFloat ? frame.HA : frame.A;
  oceanTexB.image.data = halfFloat ? frame.HB : frame.B;
  oceanTexA.needsUpdate = true;
  oceanTexB.needsUpdate = true;
  water.material.uniforms.uOceanA.value = oceanTexA;
  water.material.uniforms.uOceanB.value = oceanTexB;
  water.material.uniforms.uPatchSize.value = frame.patchSize;
}

// ---------------------------------------------------------------- scene objects

const pattern = createFoamPatternTexture();
const waterGeometry = createWaterGeometry(window.innerWidth < 700 ? 320 : 512, 150, 4000);
const water = new THREE.Mesh(waterGeometry, createWaterMaterial({ pattern }));
water.frustumCulled = false;
scene.add(water);
const uniforms = water.material.uniforms;
uniforms.uSunDir.value.copy(SUN_DIRECTION);
uniforms.uWakeCenter.value.set(0, 0);
uniforms.uWakeSize.value = WAKE_AREA;

const sky = createSky(uniforms);
scene.add(sky);

const boat = createBoat();
scene.add(boat.group);
const boatState = { angle: 0.6, y: 0, pitch: 0, roll: 0, prev: null, bowHeight: 0 };

const rocks = [
  { x: 74, z: 30, radius: 7 },
  { x: -36, z: -74, radius: 9 },
  { x: -66, z: 44, radius: 5.5 },
  { x: 18, z: -62, radius: 4 },
].map((r, i) => {
  const mesh = createRock(r.radius, i + 1);
  mesh.position.x = r.x;
  mesh.position.z = r.z;
  scene.add(mesh);
  return { ...r, mesh, prevHeight: null };
});
rocks.slice(0, MAX_ROCKS).forEach((r, i) => uniforms.uRocks.value[i].set(r.x, r.z, r.radius * 0.92, 0));
uniforms.uRockCount.value = Math.min(rocks.length, MAX_ROCKS);

const spray = new Spray(7000);
scene.add(spray.points);

// Depth of everything except water, for contact foam.
const depthTarget = new THREE.WebGLRenderTarget(1, 1, {
  depthTexture: new THREE.DepthTexture(1, 1),
  depthBuffer: true,
});
uniforms.uDepth.value = depthTarget.depthTexture;

// ---------------------------------------------------------------- palette

const palette = {};
const paletteTarget = {};
const colorKeys = ['skyTop', 'skyHorizon', 'sun', 'deep', 'shallow', 'foamLight', 'foamShadow', 'foamEdge', 'cloudLight', 'cloudShadow'];

function setPaletteTarget(p, immediate) {
  for (const key of colorKeys) {
    paletteTarget[key] = new THREE.Color(p[key]);
    if (immediate || !palette[key]) palette[key] = paletteTarget[key].clone();
  }
  paletteTarget.cloudCover = p.cloudCover;
  paletteTarget.fog = p.fog;
  if (immediate || palette.cloudCover === undefined) {
    palette.cloudCover = p.cloudCover;
    palette.fog = p.fog;
  }
}

function updatePalette(dt) {
  const k = 1 - Math.exp(-dt * 1.5);
  for (const key of colorKeys) palette[key].lerp(paletteTarget[key], k);
  palette.cloudCover += (paletteTarget.cloudCover - palette.cloudCover) * k;
  palette.fog += (paletteTarget.fog - palette.fog) * k;

  uniforms.uSkyTop.value.copy(palette.skyTop);
  uniforms.uSkyHorizon.value.copy(palette.skyHorizon);
  uniforms.uSunColor.value.copy(palette.sun);
  uniforms.uDeep.value.copy(palette.deep);
  uniforms.uShallow.value.copy(palette.shallow);
  uniforms.uFoamLight.value.copy(palette.foamLight);
  uniforms.uFoamShadow.value.copy(palette.foamShadow);
  uniforms.uFoamEdge.value.copy(palette.foamEdge);
  uniforms.uFogDensity.value = palette.fog;
  sky.material.uniforms.uCloudLight.value.copy(palette.cloudLight);
  sky.material.uniforms.uCloudShadow.value.copy(palette.cloudShadow);
  sky.material.uniforms.uCloudCover.value = palette.cloudCover;
  sunLight.color.copy(palette.sun);
  hemi.color.copy(palette.skyHorizon);
  hemi.groundColor.copy(palette.deep);
  spray.material.uniforms.uLight.value.copy(palette.foamLight);
  spray.material.uniforms.uShadow.value.copy(palette.foamShadow);
}

// ---------------------------------------------------------------- sea state transitions

const SEA_KEYS = ['windSpeed', 'choppiness', 'waveScale'];
let transition = null;

function pushSeaParams() {
  ocean.setParams({
    windSpeed: params.windSpeed,
    windDirection: THREE.MathUtils.degToRad(params.windDirection),
    choppiness: params.choppiness,
    waveScale: params.waveScale,
  });
}

function applyPreset(name, immediate = false) {
  const preset = PRESETS[name];
  params.preset = name;
  Object.assign(params, preset.foam);
  setPaletteTarget(preset.palette, immediate);
  if (immediate) {
    Object.assign(params, preset.sea);
    pushSeaParams();
  } else {
    const from = Object.fromEntries(SEA_KEYS.map((k) => [k, params[k]]));
    transition = { from, to: preset.sea, t: 0, duration: 2.5 };
  }
  document.querySelectorAll('[data-preset]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.preset === name)));
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
}

function updateTransition(dt) {
  if (!transition) return;
  transition.t = Math.min(transition.t + dt / transition.duration, 1);
  const e = transition.t * transition.t * (3 - 2 * transition.t);
  for (const k of SEA_KEYS) params[k] = transition.from[k] + (transition.to[k] - transition.from[k]) * e;
  pushSeaParams();
  seaFolder.controllersRecursive().forEach((c) => c.updateDisplay());
  if (transition.t >= 1) transition = null;
}

// ---------------------------------------------------------------- GUI

const gui = new GUI({ title: 'Seafoam controls', container: document.getElementById('gui') });
if (window.innerWidth < 700) gui.close();

const seaFolder = gui.addFolder('Sea state (FFT ocean)');
seaFolder.add(params, 'windSpeed', 3, 22, 0.1).name('Wind speed (m/s)').onChange(pushSeaParams);
seaFolder.add(params, 'windDirection', 0, 360, 1).name('Wind direction (°)').onChange(pushSeaParams);
seaFolder.add(params, 'choppiness', 0, 2.6, 0.01).name('Choppiness λ').onChange(pushSeaParams);
seaFolder.add(params, 'waveScale', 0.3, 2.2, 0.01).name('Wave height ×').onChange(pushSeaParams);
seaFolder.add(params, 'resolution', [64, 128, 256]).name('FFT grid').onChange((n) => ocean.setParams({ size: n }));

const foamFolder = gui.addFolder('Foam');
foamFolder.add(params, 'whitecapBias', 0.2, 1.2, 0.01).name('Whitecap: J below');
foamFolder.add(params, 'whitecapGain', 0.5, 8, 0.1).name('Whitecap: gain');
foamFolder.add(params, 'whitecapDecay', 0.5, 20, 0.1).name('Whitecap: life (s)');
foamFolder.add(params, 'whitecapSpread', 0, 10, 0.1).name('Whitecap: spread');
foamFolder.add(params, 'wakeDecay', 1, 25, 0.1).name('Wake: life (s)');
foamFolder.add(params, 'wakeSpread', 0, 6, 0.1).name('Wake: spread');
foamFolder.add(params, 'foamScale', 3, 40, 0.1).name('Pattern size (m)');
foamFolder.add(params, 'foamSoftness', 0.005, 0.3, 0.005).name('Edge softness');
foamFolder.add(params, 'foamLift', 0, 1, 0.01).name('Foam thickness (m)');
foamFolder.add(params, 'foamBump', 0, 4, 0.05).name('Foam bump');
foamFolder.add(params, 'contactWidth', 0.2, 5, 0.05).name('Contact width (m)');
foamFolder.add(params, 'sprayRate', 0, 4, 0.05).name('Spray amount');
foamFolder.add(params, 'sprayThreshold', 0, 1, 0.01).name('Spray: J below');
foamFolder.close();

const layerFolder = gui.addFolder('Foam layers');
layerFolder.add(params, 'whitecaps').name('Whitecaps (Jacobian)');
layerFolder.add(params, 'wake').name('Boat wake');
layerFolder.add(params, 'contact').name('Contact (depth)');
layerFolder.add(params, 'rings').name('Rock rings');
layerFolder.add(params, 'spray').name('Spray particles');

const lookFolder = gui.addFolder('Look');
lookFolder.add(params, 'toon', 0, 1, 0.01).name('Toon shading');
lookFolder.add(params, 'sss', 0, 2, 0.01).name('Crest glow (SSS)');
lookFolder.add(params, 'timeScale', 0, 2, 0.01).name('Time scale');
lookFolder.add(params, 'followBoat').name('Follow boat');
lookFolder.add(params, 'debug', Object.keys(DEBUG_VIEWS)).name('Debug view');
lookFolder.close();

document.querySelectorAll('[data-preset]').forEach((button) => {
  button.addEventListener('click', () => applyPreset(button.dataset.preset));
});

// ---------------------------------------------------------------- per-frame logic

const tmp = new THREE.Vector3();
const lastTarget = new THREE.Vector3();

function surfaceHeight(x, z) {
  return ocean.surfaceAt(x, z).height;
}

function updateBoat(dt) {
  const s = boatState;
  s.angle += (dt * BOAT_SPEED) / BOAT_PATH_RADIUS;
  const x = Math.cos(s.angle) * BOAT_PATH_RADIUS;
  const z = Math.sin(s.angle) * BOAT_PATH_RADIUS;
  const fx = -Math.sin(s.angle), fz = Math.cos(s.angle);   // forward (counter-clockwise)
  const rx = fz, rz = -fx;                                  // starboard

  const half = boat.length * 0.42;
  const hc = surfaceHeight(x, z);
  const hb = surfaceHeight(x + fx * half, z + fz * half);
  const hs = surfaceHeight(x - fx * half, z - fz * half);
  const hr = surfaceHeight(x + rx * 1.3, z + rz * 1.3);
  const hl = surfaceHeight(x - rx * 1.3, z - rz * 1.3);

  const k = 1 - Math.exp(-dt * 5);
  s.y += ((hc + hb + hs) / 3 - 0.35 - s.y) * k;
  s.pitch += (Math.atan2(hb - hs, half * 2) - s.pitch) * k;
  s.roll += (Math.atan2(hr - hl, 2.6) - 0.06 - s.roll) * k;   // slight lean into the turn

  boat.group.position.set(x, s.y, z);
  boat.group.rotation.set(-s.pitch, Math.atan2(fx, fz), s.roll);
  boat.flag.rotation.y = Math.PI / 2 + Math.sin(performance.now() * 0.012) * 0.25;

  // Wake sources: churned water behind the stern and two bow-wave lines.
  const points = {
    stern: [x - fx * half * 1.05, z - fz * half * 1.05],
    bowL: [x + fx * half * 0.55 - rx * 1.45, z + fz * half * 0.55 - rz * 1.45],
    bowR: [x + fx * half * 0.55 + rx * 1.45, z + fz * half * 0.55 + rz * 1.45],
    midL: [x - fx * half * 0.4 - rx * 1.6, z - fz * half * 0.4 - rz * 1.6],
    midR: [x - fx * half * 0.4 + rx * 1.6, z - fz * half * 0.4 + rz * 1.6],
  };
  const prev = s.prev || points;
  const stamps = [
    { from: prev.stern, to: points.stern, radius: [2.0, 2.0], strength: [1, 1] },
    { from: prev.bowL, to: points.bowL, radius: [0.9, 0.9], strength: [0.95, 0.95] },
    { from: prev.bowR, to: points.bowR, radius: [0.9, 0.9], strength: [0.95, 0.95] },
    { from: prev.midL, to: points.midL, radius: [0.7, 0.7], strength: [0.6, 0.6] },
    { from: prev.midR, to: points.midR, radius: [0.7, 0.7], strength: [0.6, 0.6] },
  ];
  s.prev = points;

  // Bow spray: steady sheets off both sides plus a burst when the bow slams.
  const bowX = x + fx * half, bowZ = z + fz * half;
  const slam = Math.max(0, (hb - s.bowHeight) / Math.max(dt, 1e-3)); // water rising at the bow
  s.bowHeight = hb;
  if (params.spray) {
    const count = Math.round((10 + slam * 25) * dt * 60 * params.sprayRate * 0.25);
    for (let i = 0; i < count; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const out = 1.5 + Math.random() * 2.5;
      spray.emit(
        bowX + rx * side * 0.6, hb + 0.2, bowZ + rz * side * 0.6,
        rx * side * out + fx * BOAT_SPEED * 0.7, 1.5 + Math.random() * 2.5 + slam * 0.3, rz * side * out + fz * BOAT_SPEED * 0.7,
        0.35 + Math.random() * 0.5, 0.7 + Math.random() * 0.6,
      );
    }
  }
  return stamps;
}

function emitCrestSpray(dt) {
  const frame = ocean.frame;
  if (!params.spray || !frame) return;
  const { n, patchSize, A } = frame;
  const cell = patchSize / n;
  const focus = controls.target;
  const wx = Math.cos(THREE.MathUtils.degToRad(params.windDirection));
  const wz = Math.sin(THREE.MathUtils.degToRad(params.windDirection));
  const attempts = Math.round(params.sprayRate * 9000 * dt);
  const threshold = params.sprayThreshold;
  for (let a = 0; a < attempts; a++) {
    const i = (Math.random() * n * n) | 0;
    const J = A[i * 4 + 3];
    if (J >= threshold) continue;
    const strength = Math.min((threshold - J) / Math.max(threshold, 0.05), 1);
    if (Math.random() > strength) continue;
    // Pick the copy of this tile cell nearest to what the camera looks at.
    let x = (i % n) * cell, z = ((i / n) | 0) * cell;
    x += Math.round((focus.x - x) / patchSize) * patchSize;
    z += Math.round((focus.z - z) / patchSize) * patchSize;
    if (Math.hypot(x - focus.x, z - focus.z) > 120) continue;
    const px = x + A[i * 4], py = A[i * 4 + 1], pz = z + A[i * 4 + 2];
    const burst = 1 + ((Math.random() * 3) | 0);
    for (let b = 0; b < burst; b++) {
      const speed = 2 + 4 * strength * Math.random();
      spray.emit(
        px + (Math.random() - 0.5) * 1.2, py + 0.1, pz + (Math.random() - 0.5) * 1.2,
        wx * speed + (Math.random() - 0.5) * 1.5, 1.2 + Math.random() * 3.5 * strength, wz * speed + (Math.random() - 0.5) * 1.5,
        (0.3 + Math.random() * 0.6) * (0.7 + strength), 0.8 + Math.random() * 1.0,
      );
    }
  }
}

function emitRockSplashes(dt) {
  if (!params.spray) return;
  const wx = Math.cos(THREE.MathUtils.degToRad(params.windDirection));
  const wz = Math.sin(THREE.MathUtils.degToRad(params.windDirection));
  for (const rock of rocks) {
    // Watch the water on the windward face: when it rises fast it hits the rock.
    const sx = rock.x - wx * rock.radius, sz = rock.z - wz * rock.radius;
    const h = surfaceHeight(sx, sz);
    const rise = rock.prevHeight === null ? 0 : (h - rock.prevHeight) / Math.max(dt, 1e-3);
    rock.prevHeight = h;
    if (rise < 0.6) continue;
    const count = Math.round(Math.min(rise * 20, 80) * params.sprayRate * dt * 30);
    for (let i = 0; i < count; i++) {
      const a = Math.atan2(-wz, -wx) + (Math.random() - 0.5) * 2.2;
      const ex = rock.x + Math.cos(a) * rock.radius * 0.95, ez = rock.z + Math.sin(a) * rock.radius * 0.95;
      const up = 3 + Math.random() * 4 + rise * 1.5;
      spray.emit(
        ex, h + 0.2, ez,
        Math.cos(a) * (1 + Math.random() * 2) + wx * 1.5, up, Math.sin(a) * (1 + Math.random() * 2) + wz * 1.5,
        0.35 + Math.random() * 0.8, 0.9 + Math.random() * 1.0,
      );
    }
  }
}

// ---------------------------------------------------------------- loop

function resize() {
  const w = container.clientWidth, h = container.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  depthTarget.setSize(size.x, size.y);
  uniforms.uResolution.value.copy(size);
  uniforms.uNear.value = camera.near;
  uniforms.uFar.value = camera.far;
  spray.material.uniforms.uScale.value = size.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
}
window.addEventListener('resize', resize);
resize();

const stats = document.getElementById('stats');
let statsTimer = 0, frames = 0;
let simTime = 0;
let last = performance.now();
let stamps = [];

applyPreset('normal', true);
updatePalette(0);
controls.target.set(Math.cos(boatState.angle) * BOAT_PATH_RADIUS, 1, Math.sin(boatState.angle) * BOAT_PATH_RADIUS);
lastTarget.copy(controls.target);
camera.position.add(controls.target);

function frame(now) {
  // Wall-clock time drives UI blends; the simulation step is clamped so a
  // slow frame cannot launch the boat or blow up the foam feedback.
  const wallDt = Math.max((now - last) / 1000, 0);
  const realDt = Math.min(wallDt, 1 / 20);
  last = now;
  const dt = realDt * params.timeScale;
  simTime += dt;

  updateTransition(wallDt);
  updatePalette(wallDt);
  ocean.request(simTime);
  if (ocean.version !== seenOceanVersion && ocean.ready) {
    applyOceanFrame();
    seenOceanVersion = ocean.version;
  }

  if (ocean.ready) {
    stamps = updateBoat(dt);
    const wind = THREE.MathUtils.degToRad(params.windDirection);
    whitecaps.step(dt, oceanTexA, {
      bias: params.whitecapBias, gain: params.whitecapGain,
      decay: params.whitecapDecay, spread: params.whitecapSpread, enabled: params.whitecaps,
      drift: [Math.cos(wind) * 0.5, Math.sin(wind) * 0.5], patchSize: ocean.frame.patchSize,
    });
    wake.step(dt, params.wake ? stamps : [], { decay: params.wakeDecay, spread: params.wakeSpread });
    emitCrestSpray(dt);
    emitRockSplashes(dt);
    spray.update(dt, surfaceHeight);
  }

  if (params.followBoat) {
    tmp.set(boat.group.position.x, Math.max(boat.group.position.y, 0) + 1.5, boat.group.position.z);
    controls.target.lerp(tmp, 1 - Math.exp(-realDt * 3));
    camera.position.add(tmp.subVectors(controls.target, lastTarget));
  }
  lastTarget.copy(controls.target);
  controls.update();

  const cell = waterGeometry.userData.cell;
  water.position.set(Math.round(controls.target.x / cell) * cell, 0, Math.round(controls.target.z / cell) * cell);
  sky.position.copy(camera.position);

  uniforms.uTime.value = simTime;
  uniforms.uWhitecap.value = whitecaps.texture;
  uniforms.uWake.value = wake.texture;
  uniforms.uWhitecapOn.value = params.whitecaps ? 1 : 0;
  uniforms.uWakeOn.value = params.wake ? 1 : 0;
  uniforms.uContactOn.value = params.contact ? 1 : 0;
  uniforms.uRingsOn.value = params.rings ? 1 : 0;
  uniforms.uFoamScale.value = params.foamScale;
  uniforms.uFoamSoftness.value = params.foamSoftness;
  uniforms.uFoamLift.value = params.foamLift;
  uniforms.uFoamBump.value = params.foamBump;
  uniforms.uContactWidth.value = params.contactWidth;
  uniforms.uToon.value = params.toon;
  uniforms.uSSS.value = params.sss;
  uniforms.uWaveHeight.value = 0.21 * params.windSpeed ** 2 / 9.81 * params.waveScale;
  uniforms.uDebug.value = DEBUG_VIEWS[params.debug];
  spray.material.uniforms.uToon.value = params.toon;
  spray.points.visible = params.spray;

  if (ocean.ready) {
    // Pass 1: depth of solid objects only, for contact foam.
    water.visible = false; sky.visible = false; spray.points.visible = false;
    renderer.setRenderTarget(depthTarget);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    water.visible = true; sky.visible = true; spray.points.visible = params.spray;
  }
  // Pass 2: everything.
  renderer.render(scene, camera);

  frames++;
  statsTimer += wallDt;
  if (statsTimer > 0.5 && ocean.frame) {
    const s = ocean.frame.stats;
    stats.textContent = `${Math.round(frames / statsTimer)} fps · ocean ${s.ms.toFixed(1)} ms (${ocean.frame.n}²${ocean.worker ? ', worker' : ''}) · spray ${spray.count} · min J ${s.minJacobian.toFixed(2)}`;
    statsTimer = 0;
    frames = 0;
  }
  if (!paused) requestAnimationFrame(frame);
}
let paused = false;
requestAnimationFrame(frame);

function setPaused(value) {
  if (paused === value) return;
  paused = value;
  if (!paused) {
    last = performance.now();
    requestAnimationFrame(frame);
  }
}

// Exposed for automated screenshots and for poking at it from the console.
window.seafoam = { params, applyPreset, ocean, spray, camera, controls, renderer, gui, setPaused };

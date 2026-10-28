// Water surface: a camera-following grid displaced by the FFT ocean, shaded
// in a stylized way, with every foam source composited through one
// "dissolve" threshold on a foam pattern texture.

import * as THREE from 'three';

export const MAX_ROCKS = 4;

// Shared by the sky dome and the water reflections so the horizon matches.
export const SKY_GLSL = /* glsl */ `
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSunColor;
uniform vec3 uSunDir;

vec3 skyGradient(vec3 dir) {
  float h = dir.y;
  vec3 c = mix(uSkyHorizon, uSkyTop, pow(clamp(h, 0.0, 1.0), 0.5));
  c = mix(c, uSkyHorizon * 0.8, clamp(-h * 3.0, 0.0, 1.0));
  float sd = max(dot(dir, uSunDir), 0.0);
  c += uSunColor * (pow(sd, 6.0) * 0.18 + pow(sd, 48.0) * 0.35);
  return c;
}`;

const WATER_VERTEX = /* glsl */ `
uniform sampler2D uOceanA;     // dx, h, dz, J
uniform sampler2D uWhitecap;
uniform sampler2D uWake;
uniform float uPatchSize;
uniform float uTexel;          // half a grid cell in uv, so texel centres sit on grid points
uniform float uFoamLift;
uniform vec2 uFade;            // displacement fades out between these radii (m)
uniform vec2 uWakeCenter;
uniform float uWakeSize;
uniform float uWakeOn;

varying vec2 vTileUv;
varying vec3 vWorld;
varying float vFade;
varying float vHeight;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  float fade = 1.0 - smoothstep(uFade.x, uFade.y, length(position.xz));
  vec2 uv = world.xz / uPatchSize + uTexel;
  vec4 d = textureLod(uOceanA, uv, 0.0);
  vec3 p = world.xyz + d.xyz * fade;

  // Thick foam sits slightly proud of the water: cheap 3D volume.
  float whitecap = textureLod(uWhitecap, uv, 0.0).r;
  vec2 wakeUv = (p.xz - uWakeCenter) / uWakeSize + 0.5;
  float wake = uWakeOn * textureLod(uWake, wakeUv, 0.0).r;
  p.y += min(whitecap + wake, 1.0) * uFoamLift * fade;

  vTileUv = uv;
  vWorld = p;
  vFade = fade;
  vHeight = d.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const WATER_FRAGMENT = /* glsl */ `
#include <common>
${SKY_GLSL}

uniform sampler2D uOceanA;
uniform sampler2D uOceanB;     // dh/dx, dh/dz, jxx, jzz
uniform sampler2D uWhitecap;   // r = accumulated foam, g = fresh foam this frame
uniform sampler2D uWake;
uniform sampler2D uPattern;    // r = lace, g = bubbles, b = smooth noise
uniform sampler2D uDepth;
uniform vec2 uResolution;
uniform float uNear;
uniform float uFar;
uniform float uTime;
uniform float uPatchSize;
uniform vec2 uWakeCenter;
uniform float uWakeSize;
uniform vec4 uRocks[${MAX_ROCKS}];  // x, z, waterline radius, unused
uniform int uRockCount;

uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uFoamLight;
uniform vec3 uFoamShadow;
uniform vec3 uFoamEdge;
uniform float uFogDensity;
uniform float uWaveHeight;     // significant wave height, normalises the crest mask
uniform float uSSS;
uniform float uToon;

uniform float uWhitecapOn;
uniform float uWakeOn;
uniform float uContactOn;
uniform float uRingsOn;
uniform float uFoamScale;      // metres per pattern tile
uniform float uFoamSoftness;
uniform float uFoamBump;
uniform float uContactWidth;
uniform int uDebug;

varying vec2 vTileUv;
varying vec3 vWorld;
varying float vFade;
varying float vHeight;

float viewDepth(float fragZ) {
  float z = fragZ * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
}

vec3 jacobianRamp(float J) {
  if (J < 0.0) return vec3(1.0, 0.1, 0.25);
  vec3 a = vec3(1.0, 0.85, 0.2), b = vec3(0.1, 0.25, 0.6);
  return mix(a, b, smoothstep(0.0, 1.0, J));
}

void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec3 L = normalize(uSunDir);

  // ---- Surface normal from FFT slopes, plus the same spectrum sampled 4.7x
  // smaller as a fake second cascade that hides the tile repeat.
  vec4 B = texture2D(uOceanB, vTileUv);
  vec4 B2 = texture2D(uOceanB, vTileUv * 4.73 + vec2(0.31, 0.67));
  float far = smoothstep(80.0, 900.0, dist);
  float jxx = max(B.z, 0.2), jzz = max(B.w, 0.2);
  vec2 slope = B.xy * mix(1.0, 0.4, far) * vFade + B2.xy * 0.5 * (1.0 - far);
  vec3 N = normalize(vec3(-slope.x * jzz, jxx * jzz, -slope.y * jxx));

  // ---- Foam sources, all expressed as one 0..1+ mask.
  vec4 W = texture2D(uWhitecap, vTileUv);
  float whitecap = uWhitecapOn * W.r * vFade;

  vec2 wakeUv = (vWorld.xz - uWakeCenter) / uWakeSize + 0.5;
  float wake = uWakeOn * texture2D(uWake, wakeUv).r;

  // Contact foam: water that is only a little in front of the scene depth is
  // touching something (rock, hull). Same trick as most stylized water shaders.
  float sceneDepth = viewDepth(texture2D(uDepth, gl_FragCoord.xy / uResolution).r);
  float thickness = sceneDepth - viewDepth(gl_FragCoord.z);
  float contact = uContactOn * (1.0 - smoothstep(0.0, uContactWidth, thickness));

  // Pattern coordinates ride on the undisplaced (Lagrangian) surface, so foam
  // sloshes back and forth with the choppy waves instead of sliding over them.
  vec2 fuv = vTileUv * uPatchSize / uFoamScale;
  float wobble = texture2D(uPattern, fuv * 0.17 + uTime * 0.004).b - 0.5;
  fuv += wobble * 0.12;
  float pattern = texture2D(uPattern, fuv + vec2(uTime * 0.004, 0.0)).r * 0.8
                + texture2D(uPattern, fuv * 2.71 + vec2(-uTime * 0.009, uTime * 0.006)).r * 0.2;
  float bubbles = texture2D(uPattern, fuv * 1.9 + vec2(0.0, -uTime * 0.01)).g;

  // Wind Waker style rings around rocks: pulses travelling outward.
  float rings = 0.0;
  for (int i = 0; i < ${MAX_ROCKS}; i++) {
    if (i >= uRockCount) break;
    float d = length(vWorld.xz - uRocks[i].xy) - uRocks[i].z + wobble * 2.5;
    float ring = smoothstep(0.62, 0.8, sin(d * 0.9 - uTime * 2.2) * 0.5 + 0.5);
    ring *= exp(-max(d, 0.0) / 6.0) * step(0.0, d);
    float hug = 1.0 - smoothstep(0.0, 2.2, d);
    rings = max(rings, max(ring * 0.75, hug));
  }
  rings *= uRingsOn;

  float mask = whitecap + wake + contact + rings;
  mask = clamp(mask, 0.0, 1.0);

  // ---- The stylization: one dissolve threshold. Little foam keeps only the
  // brightest lace lines; lots of foam fills the cells; holes shrink last.
  float threshold = 1.0 - mask;
  // Widen the edge where the pattern is minified, so it antialiases instead of sparkling.
  float soft = max(uFoamSoftness, fwidth(pattern) * 0.8);
  float foam = smoothstep(threshold - soft, threshold + soft, pattern);
  foam = max(foam, smoothstep(0.55, 0.6, bubbles * mask * 1.25) * (1.0 - far));
  foam *= step(0.015, mask);
  // Far away the pattern is mipmapped to grey and the threshold stops working,
  // so fade to plain coverage, which is what the eye reads at that distance.
  foam = mix(foam, smoothstep(0.1, 0.8, mask) * 0.85, smoothstep(60.0, 240.0, dist));
  float body = smoothstep(threshold, threshold + 0.18, pattern);   // inner, thicker part
  float rim = smoothstep(threshold - soft - 0.1, threshold - soft, pattern) * (1.0 - foam);

  // ---- Water shading (Sea of Thieves style subsurface colour on crests).
  float NdotV = max(dot(N, V), 0.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - NdotV, 5.0);
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  vec3 reflection = skyGradient(R);

  float crest = clamp((vHeight + uWaveHeight * 0.25) / (uWaveHeight * 0.75 + 0.01), 0.0, 1.0);
  float backlit = pow(clamp(dot(V, -L) * 0.5 + 0.5, 0.0, 1.0), 2.5);
  float sss = crest * crest * (0.3 + 0.7 * backlit) * uSSS;
  sss += pow(1.0 - NdotV, 3.0) * 0.25 * backlit * uSSS;
  vec3 water = mix(uDeep, uShallow, clamp(sss, 0.0, 1.0));
  float lambert = max(dot(N, L), 0.0);
  water *= mix(0.75 + 0.25 * lambert, 0.8 + 0.2 * step(0.35, lambert), uToon);

  vec3 color = mix(water, reflection, fresnel * 0.85);
  float spec = pow(max(dot(R, L), 0.0), 220.0);
  spec = mix(spec * 3.0, smoothstep(0.45, 0.55, spec) * 2.2, uToon);
  color += uSunColor * spec * (1.0 - foam);

  // A darker band just outside the foam reads as foam casting a shadow,
  // which is most of what makes flat foam look like it has thickness.
  color *= 1.0 - 0.28 * rim * step(0.015, mask);

  // ---- Foam shading: bumped normal, toon bands, a cyan rim on thin edges.
  float fh = foam * (0.5 + 0.5 * pattern);
  vec3 dpdx = dFdx(vWorld), dpdy = dFdy(vWorld);
  vec3 r1 = cross(dpdy, N), r2 = cross(N, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dFdx(fh) * r1 + dFdy(fh) * r2);
  vec3 Nf = normalize(abs(det) * N - grad * uFoamBump);
  float fl = max(dot(Nf, L), 0.0) * 0.8 + 0.2;
  float toonBands = 0.45 + 0.3 * step(0.4, fl) + 0.25 * step(0.75, fl);
  float shade = mix(fl, toonBands, uToon);
  vec3 foamColor = mix(uFoamShadow, uFoamLight, shade);
  foamColor = mix(uFoamEdge, foamColor, mix(0.55, 1.0, body));
  foamColor += uSunColor * pow(max(dot(reflect(-V, Nf), L), 0.0), 24.0) * 0.15;
  foamColor += W.g * uWhitecapOn * 0.15;   // freshly broken crests glow a little
  color = mix(color, foamColor, foam);

  // ---- Aerial perspective to the horizon colour.
  float fog = 1.0 - exp(-pow(dist * uFogDensity, 1.4));
  vec3 horizon = skyGradient(normalize(vec3(-V.x, 0.0, -V.z)));
  color = mix(color, horizon, fog);

  if (uDebug == 1) color = jacobianRamp(texture2D(uOceanA, vTileUv).a);
  else if (uDebug == 2) color = vec3(W.r, W.g * 0.6 + W.r * 0.4, W.r);
  else if (uDebug == 3) color = vec3(wake);
  else if (uDebug == 4) color = vec3(whitecap, wake + rings, contact);
  else if (uDebug == 5) color = vec3(foam);

  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// A square grid that is dense in the middle (where the camera looks) and
// stretches quadratically out to the horizon. It follows the camera in steps
// of one inner cell, so vertices always sample the same ocean points and the
// waves never "swim".
export function createWaterGeometry(segments, coreRadius, outerRadius, coreFraction = 0.7) {
  const half = segments / 2;
  const coreSegments = Math.round(half * coreFraction);
  const outerSegments = half - coreSegments;
  const cell = coreRadius / coreSegments;
  const coord = (i) => {
    const k = Math.abs(i - half);
    let r;
    if (k <= coreSegments) r = k * cell;
    else {
      const t = (k - coreSegments) / outerSegments;
      r = coreRadius + (outerRadius - coreRadius) * t * t;
    }
    return Math.sign(i - half) * r;
  };

  const verts = segments + 1;
  const positions = new Float32Array(verts * verts * 3);
  for (let z = 0; z < verts; z++) {
    for (let x = 0; x < verts; x++) {
      const o = (z * verts + x) * 3;
      positions[o] = coord(x);
      positions[o + 1] = 0;
      positions[o + 2] = coord(z);
    }
  }
  const indices = new Uint32Array(segments * segments * 6);
  let o = 0;
  for (let z = 0; z < segments; z++) {
    for (let x = 0; x < segments; x++) {
      const a = z * verts + x, b = a + 1, c = a + verts, d = c + 1;
      indices[o++] = a; indices[o++] = c; indices[o++] = b;
      indices[o++] = b; indices[o++] = c; indices[o++] = d;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.userData.cell = cell;
  return geometry;
}

export function createWaterMaterial(textures) {
  return new THREE.ShaderMaterial({
    vertexShader: WATER_VERTEX,
    fragmentShader: WATER_FRAGMENT,
    uniforms: {
      uOceanA: { value: null },
      uOceanB: { value: null },
      uWhitecap: { value: null },
      uWake: { value: null },
      uPattern: { value: textures.pattern },
      uDepth: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 0.5 },
      uFar: { value: 8000 },
      uTime: { value: 0 },
      uPatchSize: { value: 256 },
      uTexel: { value: 0.5 / 256 },
      uFade: { value: new THREE.Vector2(170, 240) },
      uWakeCenter: { value: new THREE.Vector2() },
      uWakeSize: { value: 256 },
      uRocks: { value: Array.from({ length: MAX_ROCKS }, () => new THREE.Vector4()) },
      uRockCount: { value: 0 },

      uSkyTop: { value: new THREE.Color() },
      uSkyHorizon: { value: new THREE.Color() },
      uSunColor: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uDeep: { value: new THREE.Color() },
      uShallow: { value: new THREE.Color() },
      uFoamLight: { value: new THREE.Color() },
      uFoamShadow: { value: new THREE.Color() },
      uFoamEdge: { value: new THREE.Color() },
      uFogDensity: { value: 0.0012 },
      uWaveHeight: { value: 2.5 },
      uSSS: { value: 1 },
      uToon: { value: 0.7 },

      uWhitecapOn: { value: 1 },
      uWakeOn: { value: 1 },
      uContactOn: { value: 1 },
      uRingsOn: { value: 1 },
      uFoamScale: { value: 7 },
      uFoamSoftness: { value: 0.04 },
      uFoamBump: { value: 1.2 },
      uFoamLift: { value: 0.25 },
      uContactWidth: { value: 1.6 },
      uDebug: { value: 0 },
    },
  });
}

const SKY_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
  vec4 p = projectionMatrix * viewMatrix * vec4((modelMatrix * vec4(position, 1.0)).xyz, 1.0);
  gl_Position = p.xyww;   // pin to the far plane
}`;

const SKY_FRAGMENT = /* glsl */ `
#include <common>
${SKY_GLSL}
uniform vec3 uCloudLight;
uniform vec3 uCloudShadow;
uniform float uCloudCover;
uniform float uTime;
varying vec3 vDir;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}

void main() {
  vec3 dir = normalize(vDir);
  vec3 color = skyGradient(dir);
  float sd = dot(dir, normalize(uSunDir));
  color = mix(color, uSunColor * 2.5, smoothstep(0.9993, 0.9996, sd));

  if (dir.y > 0.0) {
    // Flat cartoon clouds: fbm on a plane, hard-thresholded, lit from the sun side.
    vec2 p = dir.xz / (dir.y + 0.08) * 0.9 + vec2(uTime * 0.004, 0.0);
    float n = fbm(p);
    float cover = smoothstep(1.0 - uCloudCover, 1.05 - uCloudCover, n) * smoothstep(0.0, 0.12, dir.y);
    float lit = smoothstep(0.0, 0.08, n - fbm(p + normalize(uSunDir.xz + 1e-4) * 0.12));
    vec3 cloud = mix(uCloudShadow, uCloudLight, 0.45 + 0.55 * lit);
    color = mix(color, cloud, cover * 0.95);
  }
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createSky(waterUniforms) {
  const material = new THREE.ShaderMaterial({
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT,
    uniforms: {
      uSkyTop: waterUniforms.uSkyTop,
      uSkyHorizon: waterUniforms.uSkyHorizon,
      uSunColor: waterUniforms.uSunColor,
      uSunDir: waterUniforms.uSunDir,
      uTime: waterUniforms.uTime,
      uCloudLight: { value: new THREE.Color() },
      uCloudShadow: { value: new THREE.Color() },
      uCloudCover: { value: 0.4 },
    },
    side: THREE.BackSide,
    depthWrite: false,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 48, 24), material);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  return sky;
}

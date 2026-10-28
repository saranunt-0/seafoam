// Spray: ballistic point sprites thrown off breaking crests, the boat's bow
// and waves slamming into rocks. Tessendorf (2001) suggests emitting where the
// Jacobian's smaller eigenvalue drops below a threshold; using J directly is a
// cheaper stand-in that picks the same crests.

import * as THREE from 'three';

const SPRAY_VERTEX = /* glsl */ `
attribute float aSize;
attribute float aAge;     // 0 = just born, 1 = dead
uniform float uScale;
varying float vAge;
void main() {
  vAge = aAge;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float grow = 0.55 + 0.9 * aAge;        // puffs expand as they fly
  gl_PointSize = aSize * grow * uScale / max(-mv.z, 0.1);
  gl_Position = projectionMatrix * mv;
}`;

const SPRAY_FRAGMENT = /* glsl */ `
#include <common>
uniform vec3 uLight;
uniform vec3 uShadow;
uniform float uToon;
varying float vAge;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  // Stylized blobs: a disc that shrinks inside its growing sprite, so a puff
  // swells and then thins out; uToon picks a hard or soft edge.
  float radius = 1.0 - 0.45 * vAge;
  float soft = 1.0 - smoothstep(radius * 0.2, radius, r);
  float hard = 1.0 - smoothstep(radius - 0.12, radius, r);
  float edge = mix(soft, hard, uToon * 0.6);
  float alpha = edge * (1.0 - smoothstep(0.6, 1.0, vAge)) * 0.8;
  if (alpha < 0.02) discard;
  float lit = clamp(0.6 - p.y * 0.5 + p.x * 0.15, 0.0, 1.0);   // light from above
  vec3 color = mix(uShadow, uLight, mix(lit, step(0.45, lit) * 0.6 + 0.4, uToon));
  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Spray {
  constructor(max = 6000) {
    this.max = max;
    this.count = 0;
    this.position = new Float32Array(max * 3);
    this.velocity = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.age = new Float32Array(max);
    this.lifetime = new Float32Array(max);
    this.size = new Float32Array(max);

    this.geometry = new THREE.BufferGeometry();
    this.positionAttr = new THREE.BufferAttribute(this.position, 3).setUsage(THREE.DynamicDrawUsage);
    this.ageAttr = new THREE.BufferAttribute(this.age, 1).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.positionAttr);
    this.geometry.setAttribute('aAge', this.ageAttr);
    this.geometry.setAttribute('aSize', this.sizeAttr);
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      vertexShader: SPRAY_VERTEX,
      fragmentShader: SPRAY_FRAGMENT,
      uniforms: {
        uScale: { value: 400 },
        uLight: { value: new THREE.Color(0xf6fbff) },
        uShadow: { value: new THREE.Color(0x9fbccc) },
        uToon: { value: 0.7 },
      },
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
  }

  emit(x, y, z, vx, vy, vz, size, lifetime) {
    if (this.count >= this.max) return;
    const i = this.count++;
    this.position.set([x, y, z], i * 3);
    this.velocity.set([vx, vy, vz], i * 3);
    this.lifetime[i] = lifetime;
    this.life[i] = lifetime;
    this.age[i] = 0;
    this.size[i] = size;
  }

  // surfaceHeight(x, z) lets droplets die when they fall back into the sea.
  update(dt, surfaceHeight, gravity = 9.81) {
    const drag = Math.exp(-dt * 0.6);
    let i = 0;
    while (i < this.count) {
      this.life[i] -= dt;
      const o = i * 3;
      this.velocity[o] *= drag;
      this.velocity[o + 2] *= drag;
      this.velocity[o + 1] -= gravity * dt;
      this.position[o] += this.velocity[o] * dt;
      this.position[o + 1] += this.velocity[o + 1] * dt;
      this.position[o + 2] += this.velocity[o + 2] * dt;
      this.age[i] = 1 - this.life[i] / this.lifetime[i];
      const sunk = this.velocity[o + 1] < 0 &&
        this.position[o + 1] < surfaceHeight(this.position[o], this.position[o + 2]) - 0.3;
      if (this.life[i] <= 0 || sunk) {
        this.kill(i);
      } else {
        i++;
      }
    }
    this.geometry.setDrawRange(0, this.count);
    this.positionAttr.needsUpdate = true;
    this.ageAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
  }

  // Swap-remove keeps live particles packed at the front of the buffers.
  kill(i) {
    const last = --this.count;
    if (i === last) return;
    for (let k = 0; k < 3; k++) {
      this.position[i * 3 + k] = this.position[last * 3 + k];
      this.velocity[i * 3 + k] = this.velocity[last * 3 + k];
    }
    this.life[i] = this.life[last];
    this.lifetime[i] = this.lifetime[last];
    this.age[i] = this.age[last];
    this.size[i] = this.size[last];
  }
}

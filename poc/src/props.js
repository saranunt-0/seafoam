// Low-poly props that give the foam something to react to.

import * as THREE from 'three';

function toonGradient() {
  const data = new Uint8Array([90, 170, 255]);
  const texture = new THREE.DataTexture(data, 3, 1, THREE.RedFormat);
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

const gradientMap = toonGradient();
const toon = (color, extra = {}) => new THREE.MeshToonMaterial({ color, gradientMap, ...extra });

export function createBoat() {
  const group = new THREE.Group();
  const length = 8;

  // Hull: a subdivided box pinched into a bow, narrowed at the keel and
  // swept up at the front.
  const hull = new THREE.BoxGeometry(2.6, 1.5, length, 4, 3, 10);
  const p = hull.attributes.position;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i);
    const z = p.getZ(i);
    const t = z / (length / 2);          // -1 stern .. 1 bow
    if (t > 0.15) x *= 1 - Math.pow((t - 0.15) / 0.85, 1.6) * 0.97;
    if (t < -0.85) x *= 0.88;
    if (y < 0) x *= 0.5 + 0.5 * (y + 0.75) / 0.75;
    if (y > 0) y += Math.max(t, 0) ** 2 * 0.5;
    p.setXYZ(i, x, y, z);
  }
  hull.computeVertexNormals();
  const hullMesh = new THREE.Mesh(hull, toon(0x8a3b28));
  group.add(hullMesh);

  const deck = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.12, length * 0.78), toon(0xc9995e));
  deck.position.set(0, 0.72, -0.35);
  group.add(deck);

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.0, 2.0), toon(0xeee3c6));
  cabin.position.set(0, 1.25, -1.8);
  group.add(cabin);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.14, 2.2), toon(0x2f5d7c));
  roof.position.set(0, 1.82, -1.8);
  group.add(roof);

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.11, 7.2, 8), toon(0x5a3b22));
  mast.position.set(0, 4.3, 0.9);
  group.add(mast);

  // Sail: a plane bellied out by the wind.
  const sail = new THREE.PlaneGeometry(3.4, 5.2, 8, 8);
  const s = sail.attributes.position;
  for (let i = 0; i < s.count; i++) {
    const u = (s.getX(i) + 1.7) / 3.4, v = (s.getY(i) + 2.6) / 5.2;
    s.setZ(i, Math.sin(u * Math.PI) * 0.7 * (0.6 + 0.4 * v));
    s.setX(i, s.getX(i) * (1 - v * 0.35));
  }
  sail.computeVertexNormals();
  const sailMesh = new THREE.Mesh(sail, toon(0xf4ead2, { side: THREE.DoubleSide }));
  sailMesh.rotation.y = Math.PI / 2;
  sailMesh.position.set(0, 4.4, -0.85);
  group.add(sailMesh);

  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.5), toon(0xd9433b, { side: THREE.DoubleSide }));
  flag.position.set(0, 7.75, 0.45);
  flag.rotation.y = Math.PI / 2;
  group.add(flag);

  group.traverse((o) => { o.castShadow = false; });
  group.rotation.order = 'YXZ';
  return { group, length, beam: 2.6, flag };
}

// Deterministic hash so vertices shared by several faces move together.
function hash3(x, y, z, seed) {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 19.19) * 43758.5453;
  return h - Math.floor(h);
}

export function createRock(radius, seed) {
  const geometry = new THREE.IcosahedronGeometry(1, 2);
  const p = geometry.attributes.position;
  const colors = new Float32Array(p.count * 3);
  const moss = new THREE.Color(0x6f8f4e), stone = new THREE.Color(0x707774), wet = new THREE.Color(0x3c4648);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const k = 0.72 + 0.5 * hash3(+x.toFixed(3), +y.toFixed(3), +z.toFixed(3), seed);
    const ny = y * k * 0.85;
    p.setXYZ(i, x * k, ny, z * k);
    if (ny > 0.45) c.copy(moss).lerp(stone, 0.25);
    else if (ny > -0.05) c.copy(stone);
    else c.copy(wet);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();   // non-indexed, so this stays faceted
  const mesh = new THREE.Mesh(geometry, toon(0xffffff, { vertexColors: true }));
  mesh.scale.setScalar(radius);
  mesh.position.y = -radius * 0.2;
  mesh.rotation.y = seed;
  return mesh;
}

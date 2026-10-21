import * as THREE from 'three';
import type { Species } from '../../shared/species';

// Placeholder low-poly critters assembled from primitives. Each species gets a
// distinct silhouette from its shape/ears/region fields. Swap in GLTF models later
// by returning a loaded scene from buildCritter() instead.

const geoCache = new Map<string, THREE.BufferGeometry>();
function geo(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g;
}

const matCache = new Map<string, THREE.Material>();
function mat(color: string, emissive = 0): THREE.Material {
  const key = `${color}:${emissive}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      flatShading: true,
      roughness: 0.65,
      metalness: 0.05,
      emissive: emissive ? new THREE.Color(color) : new THREE.Color(0),
      emissiveIntensity: emissive,
    });
    matCache.set(key, m);
  }
  return m;
}

const WHITE = '#ffffff';
const INK = '#1d1530';

export interface CritterRig {
  group: THREE.Group;
  body: THREE.Object3D;
  wings: THREE.Object3D[];
  tail: THREE.Object3D | null;
}

/** Builds a critter of height ≈ size, origin at its feet, facing +z. */
export function buildCritter(s: Species, opts: { golden?: boolean } = {}): CritterRig {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const color = opts.golden ? '#ffc93c' : s.color;
  const accent = opts.golden ? '#fff3c4' : s.accent;
  const glow = s.rarity === 'legendary' || opts.golden ? 0.25 : s.region === 'cave' ? 0.12 : 0;
  const bodyMat = mat(color, glow);
  const accentMat = mat(accent, glow * 0.5);

  // Body: unit-ish shapes, scaled so the creature is ~1 unit tall before `size`.
  let main: THREE.Mesh;
  let headY = 0.62;
  let faceZ = 0.42;
  switch (s.shape) {
    case 'blob':
      main = new THREE.Mesh(geo('blob', () => new THREE.IcosahedronGeometry(0.46, 1)), bodyMat);
      main.position.y = 0.46;
      main.scale.set(1, 0.92, 1);
      break;
    case 'cube':
      main = new THREE.Mesh(geo('cube', () => new THREE.BoxGeometry(0.78, 0.7, 0.72)), bodyMat);
      main.position.y = 0.38;
      faceZ = 0.37;
      headY = 0.5;
      break;
    case 'cone':
      main = new THREE.Mesh(geo('cone', () => new THREE.ConeGeometry(0.46, 0.95, 7)), bodyMat);
      main.position.y = 0.48;
      faceZ = 0.27;
      headY = 0.42;
      break;
    case 'tall':
      main = new THREE.Mesh(geo('tall', () => new THREE.CapsuleGeometry(0.3, 0.5, 3, 7)), bodyMat);
      main.position.y = 0.6;
      faceZ = 0.29;
      headY = 0.82;
      break;
    case 'flat':
      main = new THREE.Mesh(geo('flat', () => new THREE.IcosahedronGeometry(0.5, 1)), bodyMat);
      main.scale.set(1.2, 0.55, 1.1);
      main.position.y = 0.28;
      faceZ = 0.52;
      headY = 0.34;
      break;
    case 'spiky':
      main = new THREE.Mesh(geo('spiky', () => new THREE.DodecahedronGeometry(0.44, 0)), bodyMat);
      main.position.y = 0.46;
      for (let i = 0; i < 7; i++) {
        const spike = new THREE.Mesh(geo('spike', () => new THREE.ConeGeometry(0.1, 0.32, 5)), accentMat);
        const a = (i / 7) * Math.PI * 2;
        spike.position.set(Math.cos(a) * 0.3, 0.75, Math.sin(a) * 0.3 - 0.08);
        spike.rotation.set(Math.sin(a) * -0.7, 0, Math.cos(a) * -0.7);
        body.add(spike);
      }
      break;
    case 'gem':
      main = new THREE.Mesh(geo('gem', () => new THREE.OctahedronGeometry(0.48, 0)), bodyMat);
      main.scale.set(0.9, 1.2, 0.9);
      main.position.y = 0.6;
      faceZ = 0.28;
      headY = 0.62;
      break;
    case 'ring':
      main = new THREE.Mesh(geo('ring', () => new THREE.TorusGeometry(0.34, 0.16, 6, 12)), bodyMat);
      main.position.y = 0.5;
      faceZ = 0.17;
      headY = 0.78;
      break;
  }
  body.add(main);

  // Belly patch for most shapes.
  if (s.shape !== 'ring' && s.shape !== 'gem') {
    const belly = new THREE.Mesh(geo('belly', () => new THREE.IcosahedronGeometry(0.22, 0)), accentMat);
    belly.scale.set(1, 1, 0.45);
    belly.position.set(0, main.position.y - 0.08, faceZ - 0.04);
    body.add(belly);
  }

  // Eyes.
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(geo('eye', () => new THREE.SphereGeometry(0.085, 8, 6)), mat(WHITE));
    eye.position.set(side * 0.14, headY, faceZ);
    const pupil = new THREE.Mesh(geo('pupil', () => new THREE.SphereGeometry(0.048, 6, 5)), mat(INK));
    pupil.position.set(0, 0, 0.055);
    eye.add(pupil);
    body.add(eye);
  }

  // Ears / head gear.
  const earY = headY + 0.26;
  for (const side of [-1, 1]) {
    let ear: THREE.Mesh | null = null;
    switch (s.ears) {
      case 'round':
        ear = new THREE.Mesh(geo('earRound', () => new THREE.IcosahedronGeometry(0.13, 0)), bodyMat);
        ear.position.set(side * 0.24, earY - 0.04, 0);
        break;
      case 'pointy':
        ear = new THREE.Mesh(geo('earPointy', () => new THREE.ConeGeometry(0.11, 0.34, 4)), bodyMat);
        ear.position.set(side * 0.2, earY + 0.06, 0);
        ear.rotation.z = -side * 0.35;
        break;
      case 'antenna':
        ear = new THREE.Mesh(geo('antenna', () => new THREE.CylinderGeometry(0.02, 0.02, 0.36, 4)), mat(INK));
        ear.position.set(side * 0.12, earY + 0.08, 0.05);
        ear.rotation.z = -side * 0.3;
        {
          const tip = new THREE.Mesh(geo('tip', () => new THREE.IcosahedronGeometry(0.07, 0)), accentMat);
          tip.position.y = 0.2;
          ear.add(tip);
        }
        break;
      case 'horn':
        ear = new THREE.Mesh(geo('horn', () => new THREE.ConeGeometry(0.08, 0.38, 5)), accentMat);
        ear.position.set(side * 0.16, earY + 0.06, 0.08);
        ear.rotation.set(0.3, 0, -side * 0.45);
        break;
      case 'leaf':
        if (side === 1) {
          ear = new THREE.Mesh(geo('leaf', () => new THREE.ConeGeometry(0.14, 0.4, 3)), mat('#3fae5a'));
          ear.position.set(0, earY + 0.1, 0);
          ear.scale.z = 0.3;
        }
        break;
    }
    if (ear) body.add(ear);
  }

  // Feet (land/cave critters).
  if (s.region !== 'ocean' && s.shape !== 'ring') {
    for (const side of [-1, 1]) {
      const foot = new THREE.Mesh(geo('foot', () => new THREE.IcosahedronGeometry(0.1, 0)), accentMat);
      foot.scale.set(1, 0.6, 1.3);
      foot.position.set(side * 0.2, 0.05, 0.1);
      group.add(foot);
    }
  }

  // Region extras.
  const wings: THREE.Object3D[] = [];
  let tail: THREE.Object3D | null = null;
  if (s.region === 'sky') {
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.3, main.position.y + 0.05, -0.05);
      const wing = new THREE.Mesh(geo('wing', () => new THREE.ConeGeometry(0.22, 0.6, 3)), accentMat);
      wing.rotation.z = side * Math.PI * 0.5;
      wing.position.x = side * 0.28;
      wing.scale.z = 0.25;
      pivot.add(wing);
      body.add(pivot);
      wings.push(pivot);
    }
  }
  if (s.region === 'ocean') {
    tail = new THREE.Mesh(geo('fin', () => new THREE.ConeGeometry(0.22, 0.42, 3)), accentMat);
    tail.rotation.x = -Math.PI / 2;
    tail.position.set(0, main.position.y, -0.5);
    tail.scale.x = 0.3;
    body.add(tail);
    const dorsal = new THREE.Mesh(geo('dorsal', () => new THREE.ConeGeometry(0.12, 0.3, 3)), accentMat);
    dorsal.position.set(0, main.position.y + 0.42, -0.05);
    dorsal.scale.z = 0.3;
    body.add(dorsal);
  } else if (s.region !== 'sky' && s.shape !== 'ring') {
    tail = new THREE.Mesh(geo('tail', () => new THREE.IcosahedronGeometry(0.12, 0)), accentMat);
    tail.position.set(0, main.position.y - 0.1, -0.45);
    body.add(tail);
  }
  if (s.region === 'cave') {
    for (let i = 0; i < 3; i++) {
      const c = new THREE.Mesh(geo('crystal', () => new THREE.OctahedronGeometry(0.1, 0)), mat('#e0aaff', 0.9));
      c.scale.y = 2;
      c.position.set((i - 1) * 0.16, main.position.y + 0.4, -0.18);
      c.rotation.z = (i - 1) * 0.4;
      body.add(c);
    }
  }
  if (s.rarity === 'legendary' || opts.golden) {
    const halo = new THREE.Mesh(geo('halo', () => new THREE.TorusGeometry(0.3, 0.035, 5, 18)), mat('#fff3b0', 1));
    halo.rotation.x = Math.PI / 2;
    halo.position.y = headY + 0.5;
    body.add(halo);
  }

  group.scale.setScalar(s.size);
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true;
  });
  return { group, body, wings, tail };
}

/** Idle/walk animation; call every frame. */
export function animateCritter(rig: CritterRig, t: number, phase: number, airborne: boolean): void {
  const hop = airborne ? 0 : Math.abs(Math.sin(t * 5 + phase)) * 0.06;
  rig.body.position.y = hop;
  rig.body.rotation.z = Math.sin(t * 2.5 + phase) * 0.05;
  for (let i = 0; i < rig.wings.length; i++) {
    const side = i === 0 ? -1 : 1;
    rig.wings[i].rotation.z = side * (airborne ? Math.sin(t * 14 + phase) * 0.7 : 0.9);
  }
  if (rig.tail) rig.tail.rotation.y = Math.sin(t * 6 + phase) * 0.4;
}

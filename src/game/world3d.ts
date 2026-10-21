import * as THREE from 'three';
import { fbm, mulberry32 } from '../../shared/noise';
import { BAZAAR, CAVE, LOBBY, PLAZA, WATER_Y, inCaveDoor, pathDistance, terrainHeight } from '../../shared/world';

export interface Island {
  scene: THREE.Scene;
  lobby: THREE.Group;
  update(t: number): void;
}

const C = (hex: string) => new THREE.Color(hex);

export function makeLabel(text: string, opts: { bg?: string; fg?: string; scale?: number } = {}): THREE.Sprite {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = '600 44px Fredoka, Inter, sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 48;
  canvas.width = w;
  canvas.height = 76;
  ctx.font = font;
  ctx.fillStyle = opts.bg ?? 'rgba(45,33,70,0.78)';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, 76, 38);
  ctx.fill();
  ctx.fillStyle = opts.fg ?? '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, 40);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true }));
  const s = opts.scale ?? 0.011;
  sprite.scale.set(w * s, 76 * s, 1);
  return sprite;
}

export function buildIsland(): Island {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog('#ffeedd', 160, 520);

  // Sky dome.
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(900, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { top: { value: C('#6fc8ff') }, mid: { value: C('#bfe9ff') }, bottom: { value: C('#fff1dc') } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader:
        'uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; varying vec3 vP; void main(){ float h = vP.y; vec3 c = h > 0.15 ? mix(mid, top, smoothstep(0.15, 0.7, h)) : mix(bottom, mid, smoothstep(-0.05, 0.15, h)); gl_FragColor = vec4(c, 1.0); }',
    }),
  );
  scene.add(sky);

  scene.add(new THREE.HemisphereLight('#d8f1ff', '#ffd9a8', 1.7));
  const sun = new THREE.DirectionalLight('#fff0d4', 2.1);
  sun.position.set(90, 140, 50);
  scene.add(sun);

  scene.add(buildTerrain());
  const ocean = buildOcean();
  scene.add(ocean.mesh);
  scene.add(buildVegetation());
  scene.add(buildPlaza());
  scene.add(buildBazaar());
  const mountain = buildMountain();
  scene.add(mountain.group);
  const clouds = buildClouds();
  scene.add(clouds);
  const lobby = buildLobby();
  scene.add(lobby);

  return {
    scene,
    lobby,
    update(t: number) {
      ocean.update(t);
      mountain.update(t);
      clouds.rotation.y = t * 0.004;
      lobby.position.y = Math.sin(t * 0.6) * 0.05;
    },
  };
}

// ── Terrain ──────────────────────────────────────────────────────────

function buildTerrain(): THREE.Mesh {
  const SIZE = 280;
  const SEG = 140;
  const base = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  base.rotateX(-Math.PI / 2);
  const p = base.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setY(i, terrainHeight(p.getX(i), p.getZ(i)));
  const g = base.toNonIndexed();
  base.dispose();
  const pos = g.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const col = new THREE.Color();
  const grassA = C('#7fd36b');
  const grassB = C('#b4e37a');
  const sand = C('#f7dfa9');
  const wetSand = C('#e7c68e');
  const path = C('#ecc591');
  const tile = C('#f3d7a8');
  const cave = C('#4b3b6e');
  const caveB = C('#6a4f99');
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    const cx = (a.x + b.x + c.x) / 3;
    const cy = (a.y + b.y + c.y) / 3;
    const cz = (a.z + b.z + c.z) / 3;
    n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
    const noise = fbm(cx * 0.08, cz * 0.08, 77, 2);
    if (Math.hypot(cx - CAVE.x, cz - CAVE.z) < CAVE.outer) col.copy(cave).lerp(caveB, noise);
    else if (cy < 0.2) col.copy(wetSand);
    else if (cy < 1.0) col.copy(sand).lerp(wetSand, noise * 0.4);
    else if (Math.hypot(cx - PLAZA.x, cz - PLAZA.z) < PLAZA.r + 1 || Math.hypot(cx - BAZAAR.x, cz - BAZAAR.z) < BAZAAR.r + 1)
      col.copy(tile).offsetHSL(0, 0, (noise - 0.5) * 0.08);
    else if (pathDistance(cx, cz) < 2.3) col.copy(path).offsetHSL(0, 0, (noise - 0.5) * 0.06);
    else {
      col.copy(grassA).lerp(grassB, noise);
      if (Math.abs(n.y) < 0.86) col.offsetHSL(0.02, -0.1, -0.05);
    }
    for (let k = 0; k < 3; k++) col.toArray(colors, (i + k) * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
}

function buildOcean() {
  const g = new THREE.PlaneGeometry(1600, 1600, 80, 80);
  g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const baseX = Float32Array.from({ length: pos.count }, (_, i) => pos.getX(i));
  const baseZ = Float32Array.from({ length: pos.count }, (_, i) => pos.getZ(i));
  const mesh = new THREE.Mesh(
    g,
    new THREE.MeshPhongMaterial({ color: '#2cc3d6', transparent: true, opacity: 0.8, shininess: 90, specular: '#e6fbff', flatShading: true }),
  );
  mesh.position.y = WATER_Y;
  return {
    mesh,
    update(t: number) {
      for (let i = 0; i < pos.count; i++) {
        const x = baseX[i];
        const z = baseZ[i];
        pos.setY(i, Math.sin(x * 0.05 + t * 0.9) * 0.18 + Math.cos(z * 0.06 + t * 0.7) * 0.16);
      }
      pos.needsUpdate = true;
    },
  };
}

// ── Vegetation ───────────────────────────────────────────────────────

function okForProp(x: number, z: number, minH: number, maxH: number): boolean {
  const h = terrainHeight(x, z);
  if (h < minH || h > maxH) return false;
  if (pathDistance(x, z) < 3.4) return false;
  if (Math.hypot(x - PLAZA.x, z - PLAZA.z) < PLAZA.r + 4) return false;
  if (Math.hypot(x - BAZAAR.x, z - BAZAAR.z) < BAZAAR.r + 3) return false;
  if (Math.hypot(x - CAVE.x, z - CAVE.z) < CAVE.outer + 2) return false;
  return true;
}

function buildVegetation(): THREE.Group {
  const group = new THREE.Group();
  const rnd = mulberry32(42);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const v = new THREE.Vector3();
  const color = new THREE.Color();

  const trees: { x: number; z: number; h: number; k: number; pine: boolean }[] = [];
  for (let i = 0; i < 900 && trees.length < 210; i++) {
    const x = (rnd() - 0.5) * 200;
    const z = (rnd() - 0.5) * 200;
    if (!okForProp(x, z, 1.6, 99)) continue;
    if (trees.some((t) => Math.hypot(t.x - x, t.z - z) < 3.2)) continue;
    trees.push({ x, z, h: terrainHeight(x, z), k: 0.8 + rnd() * 0.7, pine: rnd() < 0.35 });
  }

  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.32, 2, 5);
  trunkGeo.translate(0, 1, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: '#9a6a43', flatShading: true }), trees.length);
  const roundGeo = new THREE.IcosahedronGeometry(1.5, 0);
  const pineGeo = new THREE.ConeGeometry(1.5, 3.4, 6);
  const leafMat = new THREE.MeshLambertMaterial({ flatShading: true });
  const rounds = new THREE.InstancedMesh(roundGeo, leafMat, trees.length);
  const pines = new THREE.InstancedMesh(pineGeo, leafMat, trees.length * 2);
  const leafColors = ['#5cc46a', '#47b35f', '#84d66c', '#3fa65a', '#f59fc6'];
  let r = 0;
  let pi = 0;
  trees.forEach((t, i) => {
    q.setFromAxisAngle(v.set(0, 1, 0), rnd() * 6.28);
    m.compose(v.set(t.x, t.h - 0.2, t.z), q, s.setScalar(t.k));
    trunks.setMatrixAt(i, m);
    color.set(leafColors[t.pine ? 1 + (i % 3) : i % 17 === 0 ? 4 : i % 4]);
    if (t.pine) {
      for (let k = 0; k < 2; k++) {
        m.compose(v.set(t.x, t.h + (2.7 + k * 1.4) * t.k, t.z), q, s.setScalar(t.k * (1 - k * 0.3)));
        pines.setMatrixAt(pi, m);
        pines.setColorAt(pi++, color);
      }
    } else {
      m.compose(v.set(t.x, t.h + 2.9 * t.k, t.z), q, s.set(t.k * 1.1, t.k, t.k * 1.1));
      rounds.setMatrixAt(r, m);
      rounds.setColorAt(r++, color);
    }
  });
  rounds.count = r;
  pines.count = pi;
  group.add(trunks, rounds, pines);

  // Palms on the beach ring.
  const palms: { x: number; z: number; h: number; a: number }[] = [];
  for (let i = 0; i < 2000 && palms.length < 46; i++) {
    const a = rnd() * Math.PI * 2;
    const rr = 70 + rnd() * 30;
    const x = Math.cos(a) * rr;
    const z = Math.sin(a) * rr;
    if (!okForProp(x, z, 0.45, 1.6)) continue;
    if (palms.some((p) => Math.hypot(p.x - x, p.z - z) < 5)) continue;
    palms.push({ x, z, h: terrainHeight(x, z), a: Math.atan2(z, x) });
  }
  const palmTrunkGeo = new THREE.CylinderGeometry(0.18, 0.3, 5, 5);
  palmTrunkGeo.translate(0, 2.5, 0);
  const palmTrunks = new THREE.InstancedMesh(palmTrunkGeo, new THREE.MeshLambertMaterial({ color: '#c49a63', flatShading: true }), palms.length);
  const frondGeo = new THREE.ConeGeometry(0.55, 3.2, 3);
  frondGeo.translate(0, 1.6, 0);
  const fronds = new THREE.InstancedMesh(frondGeo, new THREE.MeshLambertMaterial({ color: '#4cbf63', flatShading: true }), palms.length * 6);
  let f = 0;
  const tilt = new THREE.Quaternion();
  palms.forEach((p, i) => {
    tilt.setFromAxisAngle(v.set(-Math.sin(p.a), 0, Math.cos(p.a)), -0.22);
    m.compose(v.set(p.x, p.h - 0.2, p.z), tilt, s.setScalar(1));
    palmTrunks.setMatrixAt(i, m);
    const top = new THREE.Vector3(0, 5, 0).applyQuaternion(tilt).add(new THREE.Vector3(p.x, p.h - 0.2, p.z));
    for (let k = 0; k < 6; k++) {
      const yaw = (k / 6) * Math.PI * 2;
      const e = new THREE.Euler(1.9, yaw, 0, 'YXZ');
      q.setFromEuler(e);
      m.compose(top, q, s.set(1, 1, 0.25));
      fronds.setMatrixAt(f++, m);
    }
  });
  group.add(palmTrunks, fronds);

  // Rocks + flowers.
  const rockGeo = new THREE.DodecahedronGeometry(0.8, 0);
  const rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshLambertMaterial({ color: '#b8b2c4', flatShading: true }), 70);
  let ri = 0;
  for (let i = 0; i < 800 && ri < 70; i++) {
    const x = (rnd() - 0.5) * 200;
    const z = (rnd() - 0.5) * 200;
    if (!okForProp(x, z, 0.6, 99)) continue;
    q.setFromEuler(new THREE.Euler(rnd() * 3, rnd() * 3, rnd() * 3));
    m.compose(v.set(x, terrainHeight(x, z), z), q, s.set(0.6 + rnd(), 0.4 + rnd() * 0.6, 0.6 + rnd()));
    rocks.setMatrixAt(ri++, m);
  }
  rocks.count = ri;
  group.add(rocks);

  const flowerGeo = new THREE.IcosahedronGeometry(0.22, 0);
  const flowers = new THREE.InstancedMesh(flowerGeo, new THREE.MeshLambertMaterial({ flatShading: true }), 400);
  const flowerColors = ['#ff6fa8', '#ffd84d', '#ffffff', '#b98cff', '#ff9a5a'];
  let fi = 0;
  for (let i = 0; i < 3000 && fi < 400; i++) {
    const x = (rnd() - 0.5) * 190;
    const z = (rnd() - 0.5) * 190;
    if (!okForProp(x, z, 1.4, 99)) continue;
    m.compose(v.set(x, terrainHeight(x, z) + 0.15, z), q.identity(), s.setScalar(0.7 + rnd() * 0.6));
    flowers.setMatrixAt(fi, m);
    flowers.setColorAt(fi++, color.set(flowerColors[Math.floor(rnd() * flowerColors.length)]));
  }
  flowers.count = fi;
  group.add(flowers);
  return group;
}

// ── Landmarks ────────────────────────────────────────────────────────

function lambert(color: string, extra: THREE.MeshLambertMaterialParameters = {}) {
  return new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
}

function buildPlaza(): THREE.Group {
  const g = new THREE.Group();
  const y = terrainHeight(PLAZA.x, PLAZA.z);
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.7, 0.8, 12), lambert('#fff4e0'));
  rim.position.set(0, y + 0.3, 0);
  const water = new THREE.Mesh(new THREE.CylinderGeometry(3.0, 3.0, 0.2, 12), new THREE.MeshPhongMaterial({ color: '#59d8e6', shininess: 80 }));
  water.position.set(0, y + 0.62, 0);
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.5, 2.2, 8), lambert('#fff4e0'));
  pillar.position.set(0, y + 1.6, 0);
  const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.9, 1), new THREE.MeshStandardMaterial({ color: '#ff3d8b', flatShading: true, emissive: '#ff3d8b', emissiveIntensity: 0.25 }));
  orb.position.set(0, y + 3.3, 0);
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.92, 0.1, 6, 20), lambert('#ffffff'));
  band.position.copy(orb.position);
  band.rotation.x = Math.PI / 2;
  g.add(rim, water, pillar, orb, band);

  const sign = (text: string, angle: number) => {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.6, 0.2), lambert('#9a6a43'));
    const x = Math.cos(angle) * 6.5;
    const z = Math.sin(angle) * 6.5;
    const h = terrainHeight(x, z);
    post.position.set(x, h + 1.3, z);
    const label = makeLabel(text, { bg: '#fff4e0', fg: '#2d2146', scale: 0.012 });
    label.position.set(x, h + 2.9, z);
    g.add(post, label);
  };
  sign('🏪 Bazaar', Math.atan2(BAZAAR.z, BAZAAR.x) + 0.3);
  sign('💎 Crystal Cave', Math.atan2(CAVE.z, CAVE.x) + 0.3);
  return g;
}

function buildBazaar(): THREE.Group {
  const g = new THREE.Group();
  const stripes = [
    ['#ff3d8b', '#ffffff'],
    ['#1fb5c4', '#ffffff'],
    ['#f2a900', '#ffffff'],
    ['#b15cff', '#ffffff'],
    ['#ff7a45', '#fff1c7'],
  ];
  const toCenter = Math.atan2(-BAZAAR.z, -BAZAAR.x);
  for (let i = 0; i < 5; i++) {
    const a = toCenter + Math.PI + (i - 2) * 0.62;
    const x = BAZAAR.x + Math.cos(a) * (BAZAAR.r - 3);
    const z = BAZAAR.z + Math.sin(a) * (BAZAAR.r - 3);
    const y = terrainHeight(x, z);
    const stall = new THREE.Group();
    stall.position.set(x, y, z);
    stall.rotation.y = Math.atan2(BAZAAR.x - x, BAZAAR.z - z);
    for (const [px, pz] of [[-1.4, -1], [1.4, -1], [-1.4, 1], [1.4, 1]]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.6, 0.16), lambert('#9a6a43'));
      post.position.set(px, 1.3, pz);
      stall.add(post);
    }
    const counter = new THREE.Mesh(new THREE.BoxGeometry(3, 1, 0.8), lambert('#f6dcae'));
    counter.position.set(0, 0.5, 0.9);
    stall.add(counter);
    const awningGeo = new THREE.ConeGeometry(2.4, 1.2, 8, 1).toNonIndexed();
    const cols = new Float32Array(awningGeo.attributes.position.count * 3);
    const [c1, c2] = stripes[i];
    for (let k = 0; k < awningGeo.attributes.position.count; k += 3) {
      const cc = C(Math.floor(k / 3) % 2 ? c1 : c2);
      for (let j = 0; j < 3; j++) cc.toArray(cols, (k + j) * 3);
    }
    awningGeo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    const awning = new THREE.Mesh(awningGeo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    awning.position.y = 3.1;
    awning.rotation.y = Math.PI / 8;
    stall.add(awning);
    for (let k = 0; k < 3; k++) {
      const crate = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 0), lambert(['#ff6fa8', '#ffd84d', '#59d8e6'][k]));
      crate.position.set(-0.8 + k * 0.8, 1.2, 0.9);
      stall.add(crate);
    }
    g.add(stall);
  }
  const archX = BAZAAR.x + Math.cos(toCenter) * (BAZAAR.r + 1);
  const archZ = BAZAAR.z + Math.sin(toCenter) * (BAZAAR.r + 1);
  const archY = terrainHeight(archX, archZ);
  const arch = new THREE.Group();
  arch.position.set(archX, archY, archZ);
  arch.lookAt(PLAZA.x, archY, PLAZA.z);
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, 4.6, 6), lambert('#ff3d8b'));
    post.position.set(side * 3.2, 2.3, 0);
    arch.add(post);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.5, 0.4), lambert('#ffffff'));
  beam.position.y = 4.6;
  arch.add(beam);
  const label = makeLabel('🏪 Critter Market', { bg: '#ff3d8b', scale: 0.016 });
  label.position.y = 5.4;
  arch.add(label);
  g.add(arch);
  return g;
}

function buildMountain() {
  const group = new THREE.Group();
  const baseY = CAVE.floorY - 0.6;
  const rings = [0, 4, 8, 12, 16, CAVE.r, CAVE.r + 3, CAVE.r + 6, CAVE.r + 9, CAVE.r + 11.5, CAVE.outer + 1];
  const SEGS = 40;
  const heightAt = (rad: number, ang: number) => {
    const H = 19 + fbm(Math.cos(ang) * 2 + 5, Math.sin(ang) * 2 + 5, 21, 3) * 10;
    if (rad <= CAVE.r) return baseY + H + Math.pow(1 - rad / CAVE.r, 1.6) * 9;
    const k = (rad - CAVE.r) / (CAVE.outer + 1 - CAVE.r);
    return baseY + H * (1 - Math.pow(k, 1.25));
  };
  const verts: number[] = [];
  const colors: number[] = [];
  const rock = C('#9d8cc4');
  const rockB = C('#c7b8ec');
  const snow = C('#f5efff');
  const col = new THREE.Color();
  const pt = (ri: number, si: number) => {
    const ang = (si / SEGS) * Math.PI * 2;
    const rad = rings[ri];
    const x = CAVE.x + Math.cos(ang) * rad;
    const z = CAVE.z + Math.sin(ang) * rad;
    const jitter = ri > 0 && ri < rings.length - 1 ? (fbm(x * 0.3, z * 0.3, 5, 1) - 0.5) * 2 : 0;
    return [x + jitter, heightAt(rad, ang), z - jitter];
  };
  for (let ri = 0; ri < rings.length - 1; ri++) {
    for (let si = 0; si < SEGS; si++) {
      const a = pt(ri, si);
      const b = pt(ri, si + 1);
      const c = pt(ri + 1, si);
      const d = pt(ri + 1, si + 1);
      for (const tri of [
        [a, b, c],
        [b, d, c],
      ]) {
        const cx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3;
        const cz = (tri[0][2] + tri[1][2] + tri[2][2]) / 3;
        const cy = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
        const rad = Math.hypot(cx - CAVE.x, cz - CAVE.z);
        if (rad > CAVE.r - 0.5 && inCaveDoor(cx, cz)) continue;
        col.copy(rock).lerp(rockB, fbm(cx * 0.2, cz * 0.2, 3, 1));
        if (cy > baseY + 25) col.lerp(snow, 0.7);
        for (const v of tri) {
          verts.push(...v);
          colors.push(col.r, col.g, col.b);
        }
      }
    }
  }
  const mg = new THREE.BufferGeometry();
  mg.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  mg.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  mg.computeVertexNormals();
  group.add(new THREE.Mesh(mg, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })));

  // Gorge walls along the door tunnel, with a rock roof near the mouth.
  const ex = Math.cos(CAVE.doorAngle);
  const ez = Math.sin(CAVE.doorAngle);
  const px = -ez;
  const pz = ex;
  const wallVerts: number[] = [];
  const steps = 10;
  for (const side of [-1, 1]) {
    for (let i = 0; i < steps; i++) {
      const r0 = CAVE.r - 1 + ((CAVE.outer + 1 - CAVE.r + 1) * i) / steps;
      const r1 = CAVE.r - 1 + ((CAVE.outer + 1 - CAVE.r + 1) * (i + 1)) / steps;
      const w = CAVE.doorHalf * side;
      const p0 = [CAVE.x + ex * r0 + px * w, CAVE.z + ez * r0 + pz * w];
      const p1 = [CAVE.x + ex * r1 + px * w, CAVE.z + ez * r1 + pz * w];
      const ang = CAVE.doorAngle;
      const t0 = heightAt(r0, ang) + 0.5;
      const t1 = heightAt(r1, ang) + 0.5;
      wallVerts.push(p0[0], baseY, p0[1], p1[0], baseY, p1[1], p0[0], t0, p0[1]);
      wallVerts.push(p1[0], baseY, p1[1], p1[0], t1, p1[1], p0[0], t0, p0[1]);
    }
  }
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute(wallVerts, 3));
  wg.computeVertexNormals();
  group.add(new THREE.Mesh(wg, lambert('#8a78b6', { side: THREE.DoubleSide })));

  const doorLen = CAVE.outer + 2 - CAVE.r;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(CAVE.doorHalf * 2 + 1.2, 1.2, doorLen), lambert('#8a78b6'));
  roof.position.set(CAVE.x + ex * (CAVE.r + doorLen / 2 - 1), baseY + 8, CAVE.z + ez * (CAVE.r + doorLen / 2 - 1));
  roof.rotation.y = Math.atan2(ex, ez);
  group.add(roof);

  // Interior dome (visible from inside), with a doorway cut.
  const dome = new THREE.SphereGeometry(CAVE.r, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2).toNonIndexed();
  const dp = dome.attributes.position as THREE.BufferAttribute;
  const keep: number[] = [];
  for (let i = 0; i < dp.count; i += 3) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let k = 0; k < 3; k++) {
      cx += dp.getX(i + k) / 3;
      cy += (dp.getY(i + k) * 0.8) / 3;
      cz += dp.getZ(i + k) / 3;
    }
    if (cy < 8.5 && inCaveDoor(CAVE.x + cx, CAVE.z + cz)) continue;
    for (let k = 0; k < 3; k++) keep.push(dp.getX(i + k), dp.getY(i + k) * 0.8, dp.getZ(i + k));
  }
  const dg = new THREE.BufferGeometry();
  dg.setAttribute('position', new THREE.Float32BufferAttribute(keep, 3));
  dg.computeVertexNormals();
  const domeMesh = new THREE.Mesh(dg, lambert('#3d2c63', { side: THREE.DoubleSide, emissive: '#1b1036' }));
  domeMesh.position.set(CAVE.x, baseY, CAVE.z);
  group.add(domeMesh);

  // Crystals inside and on the peak.
  const crystalMats = ['#ff7ad9', '#9b7bff', '#5ff2ff'].map(
    (c) => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.8, flatShading: true, roughness: 0.2 }),
  );
  const crystalGeo = new THREE.OctahedronGeometry(0.6, 0);
  const rnd = mulberry32(7);
  const crystals: THREE.Mesh[] = [];
  for (let i = 0; i < 36; i++) {
    const a = rnd() * Math.PI * 2;
    const inside = i < 26;
    const rad = inside ? CAVE.r - 1.5 - rnd() * 2.5 : rnd() * 6;
    const x = CAVE.x + Math.cos(a) * rad;
    const z = CAVE.z + Math.sin(a) * rad;
    if (inside && inCaveDoor(x, z)) continue;
    const c = new THREE.Mesh(crystalGeo, crystalMats[i % 3]);
    const sc = inside ? 0.8 + rnd() * 1.6 : 1.5 + rnd() * 2;
    c.scale.set(sc * 0.6, sc * 2, sc * 0.6);
    c.position.set(x, inside ? baseY + sc * 0.8 : heightAt(rad, a) + sc, z);
    c.rotation.set((rnd() - 0.5) * 0.6, rnd() * 3, (rnd() - 0.5) * 0.6);
    group.add(c);
    crystals.push(c);
  }
  const l1 = new THREE.PointLight('#c77dff', 60, 40, 1.6);
  l1.position.set(CAVE.x, baseY + 7, CAVE.z);
  const l2 = new THREE.PointLight('#5ff2ff', 30, 30, 1.6);
  l2.position.set(CAVE.x - ex * 6, baseY + 4, CAVE.z - ez * 6);
  group.add(l1, l2);
  const doorLabel = makeLabel('💎 Crystal Cave', { bg: '#7b2cbf', scale: 0.014 });
  doorLabel.position.set(CAVE.x + ex * (CAVE.outer + 1.5), baseY + 10, CAVE.z + ez * (CAVE.outer + 1.5));
  group.add(doorLabel);

  return {
    group,
    update(t: number) {
      const glow = 0.65 + Math.sin(t * 1.7) * 0.25;
      for (const m of crystalMats) m.emissiveIntensity = glow;
      l1.intensity = 50 + Math.sin(t * 1.3) * 12;
    },
  };
}

function buildClouds(): THREE.Group {
  const g = new THREE.Group();
  const rnd = mulberry32(99);
  const mat = new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true, emissive: '#ffffff', emissiveIntensity: 0.25 });
  const geo = new THREE.IcosahedronGeometry(1, 0);
  for (let i = 0; i < 16; i++) {
    const cloud = new THREE.Group();
    const a = rnd() * Math.PI * 2;
    const r = 60 + rnd() * 160;
    cloud.position.set(Math.cos(a) * r, 75 + rnd() * 35, Math.sin(a) * r);
    for (let k = 0; k < 5; k++) {
      const puff = new THREE.Mesh(geo, mat);
      puff.scale.setScalar(4 + rnd() * 4);
      puff.position.set((k - 2) * 4.5, rnd() * 2, (rnd() - 0.5) * 4);
      cloud.add(puff);
    }
    g.add(cloud);
  }
  return g;
}

function buildLobby(): THREE.Group {
  const g = new THREE.Group();
  const floor = new THREE.Mesh(
    new THREE.CylinderGeometry(LOBBY.r, LOBBY.r * 0.92, 0.5, 48),
    new THREE.MeshPhongMaterial({ color: '#c9f6ff', transparent: true, opacity: 0.42, shininess: 120, specular: '#ffffff' }),
  );
  floor.position.set(LOBBY.x, LOBBY.y - 0.25, LOBBY.z);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(LOBBY.r, 0.22, 8, 64), lambert('#ff3d8b'));
  rim.rotation.x = Math.PI / 2;
  rim.position.set(LOBBY.x, LOBBY.y, LOBBY.z);
  const rail = new THREE.Mesh(
    new THREE.CylinderGeometry(LOBBY.r, LOBBY.r, 1.1, 64, 1, true),
    new THREE.MeshPhongMaterial({ color: '#e8fcff', transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
  );
  rail.position.set(LOBBY.x, LOBBY.y + 0.55, LOBBY.z);
  const topRail = new THREE.Mesh(new THREE.TorusGeometry(LOBBY.r, 0.08, 6, 64), lambert('#ffffff'));
  topRail.rotation.x = Math.PI / 2;
  topRail.position.set(LOBBY.x, LOBBY.y + 1.1, LOBBY.z);
  g.add(floor, rim, rail, topRail);

  const center = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.4, 0.3, 16), lambert('#f2a900'));
  center.position.set(LOBBY.x, LOBBY.y + 0.05, LOBBY.z);
  g.add(center);

  const balloonColors = ['#ff3d8b', '#f2a900', '#1fb5c4', '#b15cff'];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const bx = LOBBY.x + Math.cos(a) * (LOBBY.r + 1.5);
    const bz = LOBBY.z + Math.sin(a) * (LOBBY.r + 1.5);
    for (let k = 0; k < 3; k++) {
      const balloon = new THREE.Mesh(new THREE.IcosahedronGeometry(1.4, 1), lambert(balloonColors[(i + k) % 4]));
      balloon.scale.y = 1.2;
      balloon.position.set(bx + (k - 1) * 1.3, LOBBY.y + 9 + k * 1.2, bz + (k % 2) * 1.2);
      g.add(balloon);
      const string = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 9, 3), lambert('#ffffff'));
      string.position.set((bx + LOBBY.x + Math.cos(a) * LOBBY.r) / 2 + (k - 1) * 0.6, LOBBY.y + 4.5, (bz + LOBBY.z + Math.sin(a) * LOBBY.r) / 2);
      g.add(string);
    }
  }
  const sign = makeLabel('🎟️ Launching soon', { bg: '#ff3d8b', scale: 0.02 });
  sign.position.set(LOBBY.x, LOBBY.y + 5.5, LOBBY.z);
  g.add(sign);
  return g;
}

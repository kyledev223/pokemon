import * as THREE from 'three';
import { fbm, mulberry32 } from '../../shared/noise';
import {
  ARENA,
  BAZAAR,
  CAVE,
  DEX_MASTER,
  LOBBY,
  PLAZA,
  PONDS,
  WATER_Y,
  inCaveDoor,
  inlandWater,
  pathDistance,
  terrainHeight,
} from '../../shared/world';

export interface Island {
  scene: THREE.Scene;
  lobby: THREE.Group;
  update(t: number): void;
  /** Redraws the big screen in the arena stadium (top 5 rows are shown). */
  setLeaderboard(rows: { name: string; score: number }[]): void;
}

const C = (hex: string) => new THREE.Color(hex);
const INK = '#2a2140';
const FONT = '"Fredoka", "Segoe UI", system-ui, sans-serif';
const PALETTE = { pink: '#ff5ea8', yellow: '#ffd23f', gold: '#ffc928', blue: '#3fa7ff', green: '#4cc38a', purple: '#8b6cf0', orange: '#ff8a3d' };

// ── Canvas text (labels, name tags, signboards) ──────────────────────

/** Resolves once Fredoka is available so canvases drawn with a fallback font can repaint. */
const fontsReady: Promise<unknown> | null =
  typeof document !== 'undefined' && document.fonts
    ? Promise.all([document.fonts.load(`700 40px ${FONT}`), document.fonts.load(`600 40px ${FONT}`)]).catch(() => null)
    : null;

/** A canvas texture that repaints itself when the web font arrives. `paint` sizes the canvas and draws. */
function liveTexture(paint: (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => void, onRepaint?: () => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  paint(canvas, ctx);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  void fontsReady?.then(() => {
    const w = canvas.width;
    const h = canvas.height;
    paint(canvas, ctx);
    // A resized canvas needs fresh GPU storage, not a sub-image update.
    if (canvas.width !== w || canvas.height !== h) tex.dispose();
    tex.needsUpdate = true;
    onRepaint?.();
  });
  return tex;
}

/** Bordered pill with a hard offset shadow, the 2D "soft neo-brutalism" look. */
function pill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fill: string, shadow = 6, lw = 6): void {
  const r = (h - lw) / 2;
  if (shadow) {
    ctx.beginPath();
    ctx.roundRect(x + lw / 2 + shadow, y + lw / 2 + shadow, w - lw, h - lw, r);
    ctx.fillStyle = INK;
    ctx.fill();
  }
  ctx.beginPath();
  ctx.roundRect(x + lw / 2, y + lw / 2, w - lw, h - lw, r);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = lw;
  ctx.strokeStyle = INK;
  ctx.stroke();
}

function spriteFrom(tex: THREE.CanvasTexture): THREE.Sprite {
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true, sizeAttenuation: true }));
}

/** White bordered pill label (or `bg`/`fg` colored), centered on its position. */
export function makeLabel(text: string, opts: { bg?: string; fg?: string; scale?: number } = {}): THREE.Sprite {
  const s = opts.scale ?? 0.011;
  const H = 86;
  let sprite: THREE.Sprite | null = null;
  const resize = (canvas: HTMLCanvasElement) => sprite?.scale.set(canvas.width * s, canvas.height * s, 1);
  const tex = liveTexture(
    (canvas, ctx) => {
      ctx.font = `600 44px ${FONT}`;
      const w = Math.ceil(ctx.measureText(text).width) + 62;
      canvas.width = w;
      canvas.height = H;
      pill(ctx, 0, 0, w - 6, H - 6, opts.bg ?? '#ffffff');
      ctx.font = `600 44px ${FONT}`;
      ctx.fillStyle = opts.fg ?? INK;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, (w - 6) / 2, (H - 6) / 2 + 2);
    },
    () => resize(tex.image as HTMLCanvasElement),
  );
  sprite = spriteFrom(tex);
  resize(tex.image as HTMLCanvasElement);
  return sprite;
}

/**
 * Floating player tag: "● name" in a bordered white pill, with an optional gold title badge
 * (e.g. "Ocean Master") stacked above it. Anchored at its bottom center.
 */
export function makeNameTag(name: string, opts: { title?: string | null; dot?: string; scale?: number } = {}): THREE.Sprite {
  const s = opts.scale ?? 0.009;
  const NAME_H = 86;
  const TITLE_H = 62;
  const GAP = 8;
  const title = opts.title?.trim() || null;
  let sprite: THREE.Sprite | null = null;
  const resize = (canvas: HTMLCanvasElement) => sprite?.scale.set(canvas.width * s, canvas.height * s, 1);
  const tex = liveTexture(
    (canvas, ctx) => {
      ctx.font = `600 44px ${FONT}`;
      const nameW = Math.ceil(ctx.measureText(name).width) + 62 + 34;
      ctx.font = `700 30px ${FONT}`;
      const titleW = title ? Math.ceil(ctx.measureText(title).width) + 48 : 0;
      const w = Math.max(nameW, titleW);
      canvas.width = w;
      canvas.height = NAME_H + (title ? TITLE_H + GAP : 0);
      const top = title ? TITLE_H + GAP : 0;
      if (title) {
        const x = (w - titleW) / 2;
        pill(ctx, x, 0, titleW - 4, TITLE_H - 4, PALETTE.gold, 4, 5);
        ctx.font = `700 30px ${FONT}`;
        ctx.fillStyle = INK;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(title, x + (titleW - 4) / 2, (TITLE_H - 4) / 2 + 2);
      }
      const x = (w - nameW) / 2;
      pill(ctx, x, top, nameW - 6, NAME_H - 6, '#ffffff');
      ctx.beginPath();
      ctx.arc(x + 36, top + (NAME_H - 6) / 2, 11, 0, Math.PI * 2);
      ctx.fillStyle = opts.dot ?? PALETTE.green;
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = INK;
      ctx.stroke();
      ctx.font = `600 44px ${FONT}`;
      ctx.fillStyle = INK;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, x + 58, top + (NAME_H - 6) / 2 + 2);
    },
    () => resize(tex.image as HTMLCanvasElement),
  );
  sprite = spriteFrom(tex);
  sprite.center.set(0.5, 0);
  resize(tex.image as HTMLCanvasElement);
  return sprite;
}

const WOOD = '#c98f55';
const WOOD_DARK = '#9a6a43';

function woodFaceTexture(text: string, aspect: number, opts: { bg?: string; fg?: string } = {}): THREE.CanvasTexture {
  return liveTexture((canvas, ctx) => {
    const H = 128;
    const W = Math.round(H * aspect);
    canvas.width = W;
    canvas.height = H;
    ctx.fillStyle = opts.bg ?? '#f3d29b';
    ctx.fillRect(0, 0, W, H);
    if (!opts.bg) {
      ctx.strokeStyle = '#e0b878';
      ctx.lineWidth = 3;
      for (let y = H / 3; y < H; y += H / 3) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }
    }
    ctx.strokeStyle = INK;
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, W - 10, H - 10);
    let size = 64;
    ctx.font = `700 ${size}px ${FONT}`;
    while (ctx.measureText(text).width > W - 44 && size > 24) {
      size -= 4;
      ctx.font = `700 ${size}px ${FONT}`;
    }
    ctx.fillStyle = opts.fg ?? INK;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, W / 2, H / 2 + 4);
  });
}

/** A plank whose front (+z) reads `front` and back reads `back` (defaults to the same text). */
function plank(front: string, w: number, h: number, back = front, opts: { bg?: string; fg?: string } = {}): THREE.Mesh {
  const side = lambert(WOOD);
  const mats = [
    side,
    side,
    side,
    side,
    new THREE.MeshLambertMaterial({ map: woodFaceTexture(front, w / h, opts) }),
    new THREE.MeshLambertMaterial({ map: woodFaceTexture(back, w / h, opts) }),
  ];
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.16), mats);
}

/** Free-standing signboard on two posts; origin at ground center, text faces +z. */
function signboard(text: string, w = 3.6, h = 1.1, postH = 1.9): THREE.Group {
  const g = new THREE.Group();
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.2, postH + h, 0.2), lambert(WOOD_DARK));
    post.position.set(side * (w / 2 - 0.3), (postH + h) / 2, -0.12);
    g.add(post);
  }
  const board = plank(text, w, h);
  board.position.y = postH + h / 2 - 0.1;
  g.add(board);
  return g;
}

/** Places an object on the terrain at (x,z) with its +z side facing (fx,fz). */
function placeFacing(o: THREE.Object3D, x: number, z: number, fx: number, fz: number, y = terrainHeight(x, z)): void {
  o.position.set(x, y, z);
  o.rotation.y = Math.atan2(fx - x, fz - z);
}

// ── Island ───────────────────────────────────────────────────────────

export function buildIsland(): Island {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog('#fdeedd', 170, 560);

  // Sky dome: soft blue overhead fading to warm cream at the horizon.
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(900, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { top: { value: C('#6cc2ff') }, mid: { value: C('#c4eaff') }, bottom: { value: C('#fff1dc') } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader:
        'uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; varying vec3 vP; void main(){ float h = vP.y; vec3 c = h > 0.12 ? mix(mid, top, smoothstep(0.12, 0.7, h)) : mix(bottom, mid, smoothstep(-0.05, 0.12, h)); gl_FragColor = vec4(c, 1.0); }',
    }),
  );
  scene.add(sky);

  scene.add(new THREE.HemisphereLight('#dff3ff', '#ffd9a8', 1.6));
  const sun = new THREE.DirectionalLight('#ffe7c2', 2.3);
  sun.position.set(90, 140, 50);
  scene.add(sun);

  scene.add(buildTerrain());
  const ocean = buildOcean();
  scene.add(ocean.mesh);
  const ponds = buildPondDecor();
  scene.add(ponds.group);
  scene.add(buildVegetation());
  scene.add(buildSpawnPad());
  scene.add(buildBazaar());
  const arena = buildArena();
  scene.add(arena.group);
  const dex = buildDexMaster();
  scene.add(dex.group);
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
      ponds.update(t);
      mountain.update(t);
      arena.update(t);
      dex.update(t);
      clouds.rotation.y = t * 0.004;
      lobby.position.y = Math.sin(t * 0.6) * 0.05;
    },
    setLeaderboard: arena.setLeaderboard,
  };
}

/** Water surface height of the animated ocean plane (ponds and river share it). */
function waveY(x: number, z: number, t: number): number {
  return Math.sin(x * 0.05 + t * 0.9) * 0.18 + Math.cos(z * 0.06 + t * 0.7) * 0.16;
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
  const grassB = C('#a8e07a');
  const sand = C('#f5dfb0');
  const wetSand = C('#e8c993');
  const bed = C('#d9c58f');
  const path = C('#e8c99a');
  const pitchA = C('#6fcf5f');
  const pitchB = C('#88dc6e');
  const rockFoot = C('#a9a9b4');
  const caveFloor = C('#4b3b6e');
  const caveFloorB = C('#6a4f99');
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
    const dc = Math.hypot(cx - CAVE.x, cz - CAVE.z);
    const da = Math.hypot(cx - ARENA.x, cz - ARENA.z);
    const water = inlandWater(cx, cz);
    if (dc < CAVE.r) col.copy(caveFloor).lerp(caveFloorB, noise);
    else if (dc < CAVE.outer) col.copy(rockFoot).offsetHSL(0, 0, (noise - 0.5) * 0.1);
    else if (water > 0.35 && cy < 0.4) col.copy(bed).offsetHSL(0, 0, (noise - 0.5) * 0.06);
    else if (cy < 0.2) col.copy(wetSand);
    else if (cy < 1.0 || (water > 0.15 && cy < 1.6)) col.copy(sand).lerp(wetSand, noise * 0.4);
    else if (da < ARENA.r - 3.5) col.copy(Math.floor((cx - ARENA.x + 40) / 2.6) % 2 ? pitchA : pitchB);
    else if (da < ARENA.r + 0.5) col.copy(path).offsetHSL(0, 0, -0.04);
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
    new THREE.MeshPhongMaterial({ color: '#3fd0d4', transparent: true, opacity: 0.84, shininess: 90, specular: '#eafeff', flatShading: true }),
  );
  mesh.position.y = WATER_Y;
  return {
    mesh,
    update(t: number) {
      for (let i = 0; i < pos.count; i++) pos.setY(i, waveY(baseX[i], baseZ[i], t));
      pos.needsUpdate = true;
    },
  };
}

/** Lily pads bobbing on the ponds. */
function buildPondDecor() {
  const group = new THREE.Group();
  const rnd = mulberry32(5);
  const pads: { x: number; z: number; r: number }[] = [];
  for (const p of PONDS) {
    for (let i = 0; i < 6; i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * p.r * 0.55;
      pads.push({ x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r, r: rnd() * 6.28 });
    }
  }
  const geo = new THREE.CylinderGeometry(0.55, 0.55, 0.06, 7, 1, false, 0.5, Math.PI * 1.75);
  const mesh = new THREE.InstancedMesh(geo, lambert('#4cc38a'), pads.length);
  const flowerGeo = new THREE.IcosahedronGeometry(0.16, 0);
  const flowers = new THREE.InstancedMesh(flowerGeo, lambert('#ff9cc6'), pads.length);
  group.add(mesh, flowers);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3(1, 1, 1);
  const v = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  return {
    group,
    update(t: number) {
      pads.forEach((p, i) => {
        const y = WATER_Y + waveY(p.x, p.z, t) + 0.05;
        q.setFromAxisAngle(up, p.r + Math.sin(t * 0.3 + i) * 0.1);
        mesh.setMatrixAt(i, m.compose(v.set(p.x, y, p.z), q, s.setScalar(1)));
        flowers.setMatrixAt(i, m.compose(v.set(p.x + 0.15, y + 0.1, p.z), q, s.setScalar(i % 3 === 0 ? 1 : 0.001)));
      });
      mesh.instanceMatrix.needsUpdate = true;
      flowers.instanceMatrix.needsUpdate = true;
    },
  };
}

// ── Vegetation ───────────────────────────────────────────────────────

function okForProp(x: number, z: number, minH: number, maxH: number): boolean {
  const h = terrainHeight(x, z);
  if (h < minH || h > maxH) return false;
  if (inlandWater(x, z) > 0.02) return false;
  if (pathDistance(x, z) < 3.4) return false;
  if (Math.hypot(x - PLAZA.x, z - PLAZA.z) < PLAZA.r + 4) return false;
  if (Math.hypot(x - BAZAAR.x, z - BAZAAR.z) < BAZAAR.r + 3) return false;
  if (Math.hypot(x - ARENA.x, z - ARENA.z) < ARENA.r + 3) return false;
  if (Math.hypot(x - DEX_MASTER.x, z - DEX_MASTER.z) < DEX_MASTER.r + 3) return false;
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
  const up = new THREE.Vector3(0, 1, 0);

  type Kind = 'round' | 'blossom' | 'pine';
  const trees: { x: number; z: number; h: number; k: number; kind: Kind }[] = [];
  for (let i = 0; i < 1000 && trees.length < 220; i++) {
    const x = (rnd() - 0.5) * 200;
    const z = (rnd() - 0.5) * 200;
    if (!okForProp(x, z, 1.6, 99)) continue;
    if (trees.some((t) => Math.hypot(t.x - x, t.z - z) < 3.2)) continue;
    const r = rnd();
    trees.push({ x, z, h: terrainHeight(x, z), k: 0.8 + rnd() * 0.7, kind: r < 0.15 ? 'blossom' : r < 0.2 ? 'pine' : 'round' });
  }

  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.32, 2, 5);
  trunkGeo.translate(0, 1, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, lambert('#9a6a43'), trees.length);
  const roundGeo = new THREE.IcosahedronGeometry(1.5, 0);
  const pineGeo = new THREE.ConeGeometry(1.5, 3.4, 6);
  const leafMat = new THREE.MeshLambertMaterial({ flatShading: true });
  const rounds = new THREE.InstancedMesh(roundGeo, leafMat, trees.length * 3);
  const pines = new THREE.InstancedMesh(pineGeo, leafMat, trees.length * 2);
  const greens = ['#5cc46a', '#4cb862', '#79d36a', '#3fa65a'];
  const blossoms = ['#ffb3d1', '#ff9cc6', '#ffc6de'];
  let r = 0;
  let pi = 0;
  trees.forEach((t, i) => {
    q.setFromAxisAngle(up, rnd() * 6.28);
    m.compose(v.set(t.x, t.h - 0.2, t.z), q, s.setScalar(t.k));
    trunks.setMatrixAt(i, m);
    if (t.kind === 'pine') {
      color.set(greens[3]);
      for (let k = 0; k < 2; k++) {
        m.compose(v.set(t.x, t.h + (2.7 + k * 1.4) * t.k, t.z), q, s.setScalar(t.k * (1 - k * 0.3)));
        pines.setMatrixAt(pi, m);
        pines.setColorAt(pi++, color);
      }
      return;
    }
    const palette = t.kind === 'blossom' ? blossoms : greens;
    // A main canopy plus two smaller puffs for a rounder, toy-like silhouette.
    const puffs: [number, number, number, number][] = [
      [0, 2.9, 0, 1],
      [0.75, 2.5, 0.3, 0.62],
      [-0.6, 3.5, -0.35, 0.58],
    ];
    puffs.forEach(([ox, oy, oz, sc], k) => {
      color.set(palette[(i + k) % palette.length]);
      v.set(ox, 0, oz).applyQuaternion(q);
      m.compose(v.set(t.x + v.x * t.k, t.h + oy * t.k, t.z + v.z * t.k), q, s.set(t.k * 1.1 * sc, t.k * sc, t.k * 1.1 * sc));
      rounds.setMatrixAt(r, m);
      rounds.setColorAt(r++, color);
    });
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
  const palmTrunks = new THREE.InstancedMesh(palmTrunkGeo, lambert('#c49a63'), palms.length);
  const frondGeo = new THREE.ConeGeometry(0.55, 3.2, 3);
  frondGeo.translate(0, 1.6, 0);
  const fronds = new THREE.InstancedMesh(frondGeo, lambert('#4cc38a'), palms.length * 6);
  const coconutGeo = new THREE.IcosahedronGeometry(0.24, 0);
  const coconuts = new THREE.InstancedMesh(coconutGeo, lambert('#8a5a34'), palms.length * 3);
  let f = 0;
  let ci = 0;
  const tilt = new THREE.Quaternion();
  palms.forEach((p, i) => {
    tilt.setFromAxisAngle(v.set(-Math.sin(p.a), 0, Math.cos(p.a)), -0.22);
    m.compose(v.set(p.x, p.h - 0.2, p.z), tilt, s.setScalar(1));
    palmTrunks.setMatrixAt(i, m);
    const top = new THREE.Vector3(0, 5, 0).applyQuaternion(tilt).add(new THREE.Vector3(p.x, p.h - 0.2, p.z));
    for (let k = 0; k < 6; k++) {
      const yaw = (k / 6) * Math.PI * 2;
      q.setFromEuler(new THREE.Euler(1.9, yaw, 0, 'YXZ'));
      m.compose(top, q, s.set(1, 1, 0.25));
      fronds.setMatrixAt(f++, m);
    }
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2;
      m.compose(v.set(top.x + Math.cos(a) * 0.3, top.y - 0.3, top.z + Math.sin(a) * 0.3), q.identity(), s.setScalar(1));
      coconuts.setMatrixAt(ci++, m);
    }
  });
  group.add(palmTrunks, fronds, coconuts);

  // Rocks + flowers.
  const rockGeo = new THREE.DodecahedronGeometry(0.8, 0);
  const rocks = new THREE.InstancedMesh(rockGeo, lambert('#b9b6c4'), 70);
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
  const flowers = new THREE.InstancedMesh(flowerGeo, new THREE.MeshLambertMaterial({ flatShading: true }), 420);
  const flowerColors = ['#ff6fa8', '#ffd84d', '#ffffff', '#b98cff', '#ff9a5a'];
  let fi = 0;
  for (let i = 0; i < 3000 && fi < 420; i++) {
    const x = (rnd() - 0.5) * 190;
    const z = (rnd() - 0.5) * 190;
    if (!okForProp(x, z, 1.4, 99)) continue;
    m.compose(v.set(x, terrainHeight(x, z) + 0.15, z), q.identity(), s.setScalar(0.7 + rnd() * 0.6));
    flowers.setMatrixAt(fi, m);
    flowers.setColorAt(fi++, color.set(flowerColors[Math.floor(rnd() * flowerColors.length)]));
  }
  flowers.count = fi;
  group.add(flowers);

  // Grass tufts: three leaning blades per tuft, one instanced mesh for the whole island.
  const blade: number[] = [];
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.3;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const w = 0.08;
    blade.push(ca * 0.05 - sa * w, 0, sa * 0.05 + ca * w, ca * 0.05 + sa * w, 0, sa * 0.05 - ca * w, ca * 0.2, 0.46 - k * 0.07, sa * 0.2);
  }
  const tuftGeo = new THREE.BufferGeometry();
  tuftGeo.setAttribute('position', new THREE.Float32BufferAttribute(blade, 3));
  tuftGeo.computeVertexNormals();
  const TUFTS = 3600;
  const tufts = new THREE.InstancedMesh(tuftGeo, new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, flatShading: true }), TUFTS);
  const tuftColors = ['#5cbf55', '#6fcf5f', '#8bdc6a', '#4fae4f'];
  let ti = 0;
  for (let i = 0; i < 20000 && ti < TUFTS; i++) {
    const x = (rnd() - 0.5) * 180;
    const z = (rnd() - 0.5) * 180;
    const h = terrainHeight(x, z);
    if (h < 1.3 || inlandWater(x, z) > 0.02 || pathDistance(x, z) < 2.6) continue;
    if (Math.hypot(x - PLAZA.x, z - PLAZA.z) < PLAZA.r + 1 || Math.hypot(x - ARENA.x, z - ARENA.z) < ARENA.r + 1) continue;
    if (Math.hypot(x - BAZAAR.x, z - BAZAAR.z) < BAZAAR.r + 1 || Math.hypot(x - DEX_MASTER.x, z - DEX_MASTER.z) < DEX_MASTER.r + 1) continue;
    if (Math.hypot(x - CAVE.x, z - CAVE.z) < CAVE.outer + 1) continue;
    q.setFromAxisAngle(up, rnd() * 6.28);
    m.compose(v.set(x, h - 0.05, z), q, s.setScalar(0.8 + rnd() * 0.9));
    tufts.setMatrixAt(ti, m);
    tufts.setColorAt(ti++, color.set(tuftColors[Math.floor(rnd() * tuftColors.length)]));
  }
  tufts.count = ti;
  group.add(tufts);
  return group;
}

// ── Landmarks ────────────────────────────────────────────────────────

function lambert(color: string, extra: THREE.MeshLambertMaterialParameters = {}) {
  return new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
}

/** Flat four-point star in the XZ plane, `depth` tall. */
function fourPointStar(outer: number, inner: number, depth: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const r = i % 2 === 0 ? outer : inner;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  return g;
}

function buildSpawnPad(): THREE.Group {
  const g = new THREE.Group();
  const y = terrainHeight(PLAZA.x, PLAZA.z);
  g.position.set(PLAZA.x, y, PLAZA.z);
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(7.3, 7.5, 1.0, 40), lambert(INK));
  rim.position.y = -0.42;
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(6.9, 6.9, 1.0, 40), lambert(PALETTE.pink));
  pad.position.y = -0.38;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(5.9, 0.12, 4, 48), lambert('#ffffff'));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.14;
  const starInk = new THREE.Mesh(fourPointStar(5.4, 1.75, 0.12), lambert(INK));
  starInk.position.y = 0.12;
  const star = new THREE.Mesh(
    fourPointStar(5.0, 1.5, 0.2),
    new THREE.MeshStandardMaterial({ color: PALETTE.gold, emissive: '#ffb300', emissiveIntensity: 0.25, metalness: 0.35, roughness: 0.35, flatShading: true }),
  );
  star.position.y = 0.14;
  star.rotation.y = Math.PI / 4;
  starInk.rotation.y = Math.PI / 4;
  g.add(rim, pad, ring, starInk, star);

  // Crossroads signpost just off the pad, between the south and south-west paths.
  const post = new THREE.Group();
  const px = -2.9;
  const pz = 10.6;
  post.position.set(px, terrainHeight(px, pz), pz);
  const pole = new THREE.Mesh(new THREE.BoxGeometry(0.26, 3.6, 0.26), lambert(WOOD_DARK));
  pole.position.y = 1.8;
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.4, 4), lambert(PALETTE.pink));
  cap.position.y = 3.8;
  cap.rotation.y = Math.PI / 4;
  post.add(pole, cap);
  const dests: [string, number, number][] = [
    ['⚔️ Arena', ARENA.x, ARENA.z],
    ['💎 Crystal Cave', CAVE.x, CAVE.z],
    ['🏪 Market', BAZAAR.x, BAZAAR.z],
    ['📖 Dex Master', DEX_MASTER.x, DEX_MASTER.z],
  ];
  dests.forEach(([text, dx, dz], i) => {
    const arm = new THREE.Group();
    arm.position.y = 3.15 - i * 0.66;
    arm.rotation.y = Math.atan2(-(dz - pz), dx - px);
    const board = plank(`${text} ▶`, 3.3, 0.56, `◀ ${text}`);
    board.position.x = 1.75;
    arm.add(board);
    post.add(arm);
  });
  g.updateMatrixWorld(true);
  g.attach(post);
  return g;
}

function buildBazaar(): THREE.Group {
  const g = new THREE.Group();
  const stripes = [
    [PALETTE.pink, '#ffffff'],
    [PALETTE.blue, '#ffffff'],
    [PALETTE.yellow, '#ffffff'],
    [PALETTE.purple, '#ffffff'],
    [PALETTE.orange, '#fff1c7'],
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
    for (const [px, pz] of [
      [-1.4, -1],
      [1.4, -1],
      [-1.4, 1],
      [1.4, 1],
    ]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 2.6, 0.16), lambert(WOOD_DARK));
      post.position.set(px, 1.3, pz);
      stall.add(post);
    }
    const counter = new THREE.Mesh(new THREE.BoxGeometry(3, 1, 0.8), lambert('#f6dcae'));
    counter.position.set(0, 0.5, 0.9);
    stall.add(counter);
    stall.add(stripedCone(2.4, 1.2, stripes[i][0], stripes[i][1], 3.1));
    for (let k = 0; k < 3; k++) {
      const goods = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 0), lambert([PALETTE.pink, PALETTE.yellow, PALETTE.blue][k]));
      goods.position.set(-0.8 + k * 0.8, 1.2, 0.9);
      stall.add(goods);
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
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, 4.6, 6), lambert(PALETTE.pink));
    post.position.set(side * 3.2, 2.3, 0);
    arch.add(post);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.5, 0.4), lambert('#ffffff'));
  beam.position.y = 4.6;
  arch.add(beam);
  const board = plank('🏪 Market', 5.2, 1.3);
  board.position.set(0, 5.5, 0.1);
  arch.add(board);
  g.add(arch);
  return g;
}

/** Low-poly cone with alternating colored faces (awnings, roofs). */
function stripedCone(radius: number, height: number, c1: string, c2: string, y: number): THREE.Mesh {
  const geo = new THREE.ConeGeometry(radius, height, 8, 1).toNonIndexed();
  const cols = new Float32Array(geo.attributes.position.count * 3);
  for (let k = 0; k < geo.attributes.position.count; k += 3) {
    const cc = C(Math.floor(k / 3) % 2 ? c1 : c2);
    for (let j = 0; j < 3; j++) cc.toArray(cols, (k + j) * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  mesh.position.y = y;
  mesh.rotation.y = Math.PI / 8;
  return mesh;
}

/** Flat ring sector (angles are world angles: x = cos φ, z = sin φ) extruded `height` up from y = 0. */
function ringSector(rIn: number, rOut: number, phi0: number, phi1: number, height: number, segs = 28): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  for (let i = 0; i <= segs; i++) {
    const p = phi0 + ((phi1 - phi0) * i) / segs;
    if (i === 0) shape.moveTo(Math.cos(p) * rOut, -Math.sin(p) * rOut);
    else shape.lineTo(Math.cos(p) * rOut, -Math.sin(p) * rOut);
  }
  for (let i = segs; i >= 0; i--) {
    const p = phi0 + ((phi1 - phi0) * i) / segs;
    shape.lineTo(Math.cos(p) * rIn, -Math.sin(p) * rIn);
  }
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 1 });
  g.rotateX(-Math.PI / 2);
  return g;
}

function buildArena() {
  const group = new THREE.Group();
  const baseY = terrainHeight(ARENA.x, ARENA.z);
  group.position.set(ARENA.x, 0, ARENA.z);
  const entrance = Math.atan2(PLAZA.z - ARENA.z, PLAZA.x - ARENA.x);
  const GAP = 0.34;
  const phi0 = entrance + GAP;
  const phi1 = entrance + Math.PI * 2 - GAP;
  const R = ARENA.r;
  const tiers = [
    { rIn: R - 3.4, h: 1.1, color: PALETTE.blue },
    { rIn: R - 2.3, h: 2.1, color: PALETTE.yellow },
    { rIn: R - 1.2, h: 3.1, color: PALETTE.pink },
  ];
  const sink = 1.2;
  for (const t of tiers) {
    const m = new THREE.Mesh(ringSector(t.rIn, R, phi0, phi1, t.h + sink), lambert(t.color));
    m.position.y = baseY - sink;
    group.add(m);
  }
  const wall = new THREE.Mesh(ringSector(R, R + 0.45, phi0, phi1, 3.6 + sink), lambert('#ffffff'));
  wall.position.y = baseY - sink;
  group.add(wall);
  const top = baseY + 3.6;

  // Pitch markings: center circle + halfway line, slightly above the striped grass.
  const lineMat = lambert('#ffffff');
  const circle = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.09, 3, 36), lineMat);
  circle.rotation.x = Math.PI / 2;
  circle.position.y = baseY + 0.05;
  const line = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.05, (R - 3.6) * 2), lineMat);
  line.position.y = baseY + 0.03;
  line.rotation.y = -entrance;
  group.add(circle, line);

  // Flags on poles around the rim.
  const flagColors = [PALETTE.pink, PALETTE.yellow, PALETTE.blue, PALETTE.green, PALETTE.purple];
  const flagGeo = new THREE.BufferGeometry();
  flagGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, -1.0, 0, 1.6, -0.5, 0], 3));
  flagGeo.computeVertexNormals();
  const flags: THREE.Mesh[] = [];
  const poleGeo = new THREE.CylinderGeometry(0.07, 0.07, 3.4, 5);
  poleGeo.translate(0, 1.7, 0);
  const poleCount = 14;
  const poles = new THREE.InstancedMesh(poleGeo, lambert('#ffffff'), poleCount);
  const mtx = new THREE.Matrix4();
  for (let i = 0; i < poleCount; i++) {
    const p = phi0 + ((phi1 - phi0) * i) / (poleCount - 1);
    const x = Math.cos(p) * (R + 0.2);
    const z = Math.sin(p) * (R + 0.2);
    poles.setMatrixAt(i, mtx.makeTranslation(x, top, z));
    const flag = new THREE.Mesh(flagGeo, lambert(flagColors[i % flagColors.length], { side: THREE.DoubleSide }));
    flag.position.set(x, top + 3.4, z);
    flag.userData.phase = i * 0.7;
    group.add(flag);
    flags.push(flag);
  }
  group.add(poles);

  // Entrance arch with the signboard facing the path.
  const ex = Math.cos(entrance);
  const ez = Math.sin(entrance);
  const arch = new THREE.Group();
  placeFacing(arch, ex * (R + 0.6), ez * (R + 0.6), ex * 50, ez * 50, baseY);
  for (const side of [-1, 1]) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.7, 5.2, 0.7), lambert(PALETTE.purple));
    pillar.position.set(side * 4.4, 2.6, 0);
    arch.add(pillar);
    const knob = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 0), lambert(PALETTE.gold));
    knob.position.set(side * 4.4, 5.6, 0);
    arch.add(knob);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(9.6, 0.6, 0.6), lambert('#ffffff'));
  beam.position.y = 4.9;
  arch.add(beam);
  const board = plank('⚔️ Arena', 5.4, 1.4);
  board.position.set(0, 5.9, 0.15);
  arch.add(board);
  group.add(arch);

  // Leaderboard screen above the far stands, facing the pitch.
  const LW = 512;
  const LH = 288;
  let rows: { name: string; score: number }[] = [];
  const paintScreen = (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => {
    canvas.width = LW;
    canvas.height = LH;
    ctx.fillStyle = INK;
    ctx.fillRect(0, 0, LW, LH);
    ctx.fillStyle = PALETTE.yellow;
    ctx.font = `700 40px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🏆 RANKS', LW / 2, 36);
    ctx.fillStyle = PALETTE.pink;
    ctx.fillRect(24, 64, LW - 48, 4);
    ctx.font = `600 30px ${FONT}`;
    if (!rows.length) {
      ctx.fillStyle = '#ffffff';
      ctx.fillText('No champions yet. Be first!', LW / 2, 160);
      return;
    }
    rows.forEach((r, i) => {
      const y = 98 + i * 40;
      ctx.textAlign = 'left';
      ctx.fillStyle = i === 0 ? PALETTE.yellow : '#ffffff';
      ctx.fillText(`${i + 1}. ${r.name.slice(0, 16)}`, 36, y);
      ctx.textAlign = 'right';
      ctx.fillStyle = PALETTE.yellow;
      ctx.fillText(String(r.score), LW - 36, y);
    });
  };
  const screenTex = liveTexture(paintScreen);
  const screen = new THREE.Group();
  const far = entrance + Math.PI;
  placeFacing(screen, Math.cos(far) * (R + 0.4), Math.sin(far) * (R + 0.4), 0, 0, top);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(9.8, 5.9, 0.4), lambert(INK));
  frame.position.y = 4.4;
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(9, 5.06), new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false }));
  panel.position.set(0, 4.4, 0.22);
  screen.add(frame, panel);
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.6, 0.4), lambert(INK));
    leg.position.set(side * 3.5, 0.8, 0);
    screen.add(leg);
  }
  group.add(screen);

  return {
    group,
    update(t: number) {
      for (const f of flags) f.rotation.y = Math.sin(t * 2.2 + f.userData.phase) * 0.35;
    },
    setLeaderboard(next: { name: string; score: number }[]) {
      rows = next.slice(0, 5);
      const canvas = screenTex.image as HTMLCanvasElement;
      paintScreen(canvas, canvas.getContext('2d')!);
      screenTex.needsUpdate = true;
    },
  };
}

function buildDexMaster() {
  const group = new THREE.Group();
  const y = terrainHeight(DEX_MASTER.x, DEX_MASTER.z);
  group.position.set(DEX_MASTER.x, y, DEX_MASTER.z);

  const base = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 3.6, 0.6, 24), lambert(INK));
  base.position.y = -0.2;
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(3.3, 3.3, 0.6, 24), lambert('#fff4e0'));
  deck.position.y = -0.14;
  group.add(base, deck);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 3.4, 6), lambert('#ffffff'));
    post.position.set(Math.cos(a) * 2.9, 1.85, Math.sin(a) * 2.9);
    group.add(post);
  }
  group.add(stripedCone(4.0, 1.9, PALETTE.purple, '#ffffff', 4.45));
  const gem = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.45, 0),
    new THREE.MeshStandardMaterial({ color: PALETTE.gold, emissive: '#ffb300', emissiveIntensity: 0.5, flatShading: true }),
  );
  gem.position.y = 6.1;
  group.add(gem);

  // The Dex Master: a round, friendly scholar holding an open book. Faces the spawn pad.
  const npc = new THREE.Group();
  npc.position.y = 0.16;
  const coat = new THREE.Mesh(new THREE.IcosahedronGeometry(0.72, 1), lambert(PALETTE.blue));
  coat.scale.set(1, 1.05, 0.9);
  coat.position.y = 0.8;
  const apron = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 0), lambert('#fff4e0'));
  apron.scale.set(1, 1.1, 0.45);
  apron.position.set(0, 0.75, 0.5);
  const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.12, 5, 12), lambert(PALETTE.orange));
  scarf.rotation.x = Math.PI / 2;
  scarf.position.y = 1.42;
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.46, 1), lambert('#ffd9b3'));
  head.position.y = 1.9;
  const hair = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 0), lambert('#d8d2e6'));
  hair.position.set(0, 2.32, -0.12);
  const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.5, 0.2, 10), lambert(PALETTE.purple));
  hat.position.y = 2.36;
  const nose = new THREE.Mesh(new THREE.IcosahedronGeometry(0.08, 0), lambert('#ffb08a'));
  nose.position.set(0, 1.86, 0.45);
  npc.add(coat, apron, scarf, head, hair, hat, nose);
  for (const side of [-1, 1]) {
    const lens = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.025, 4, 12), lambert(INK));
    lens.position.set(side * 0.16, 1.95, 0.43);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 4), new THREE.MeshBasicMaterial({ color: INK }));
    eye.position.set(side * 0.16, 1.95, 0.42);
    const cheek = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 4), lambert('#ff9cc6'));
    cheek.position.set(side * 0.28, 1.8, 0.36);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.45, 3, 6), lambert(PALETTE.blue));
    arm.position.set(side * 0.55, 1.05, 0.38);
    arm.rotation.set(-1.1, 0, side * 0.35);
    const foot = new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 0), lambert(INK));
    foot.scale.set(1, 0.6, 1.4);
    foot.position.set(side * 0.28, 0.08, 0.12);
    npc.add(lens, eye, cheek, arm, foot);
  }
  const book = new THREE.Group();
  book.position.set(0, 1.18, 0.78);
  book.rotation.x = -0.6;
  for (const side of [-1, 1]) {
    const cover = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.04, 0.56), lambert(PALETTE.pink));
    cover.position.set(side * 0.22, 0, 0);
    cover.rotation.z = side * 0.18;
    const pages = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.05, 0.5), lambert('#ffffff'));
    pages.position.set(side * 0.21, 0.04, 0);
    pages.rotation.z = side * 0.18;
    book.add(cover, pages);
  }
  npc.add(book);
  npc.rotation.y = Math.atan2(PLAZA.x - DEX_MASTER.x, PLAZA.z - DEX_MASTER.z);
  group.add(npc);

  const sign = signboard('📖 Dex Master', 3.8, 1.0, 1.4);
  const sx = DEX_MASTER.x - 4.6;
  const sz = DEX_MASTER.z + 3.2;
  placeFacing(sign, sx, sz, PLAZA.x, PLAZA.z);
  group.updateMatrixWorld(true);
  group.attach(sign);

  return {
    group,
    update(t: number) {
      gem.rotation.y = t * 1.5;
      gem.position.y = 6.1 + Math.sin(t * 2) * 0.15;
      npc.position.y = 0.16 + Math.abs(Math.sin(t * 1.6)) * 0.04;
      book.rotation.x = -0.6 + Math.sin(t * 0.8) * 0.05;
    },
  };
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
  const rock = C('#9b9aa6');
  const rockB = C('#c3c2cc');
  const snow = C('#f4f3f8');
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
        if (cy > baseY + 25) col.lerp(snow, 0.75);
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
  group.add(new THREE.Mesh(wg, lambert('#8d8c99', { side: THREE.DoubleSide })));

  const doorLen = CAVE.outer + 2 - CAVE.r;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(CAVE.doorHalf * 2 + 1.2, 1.2, doorLen), lambert('#8d8c99'));
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

  // Glowing crystals: inside the cave, on the slopes and on the peak. One instanced mesh per color.
  const crystalColors = ['#ff7ad9', '#9b7bff', '#5ff2ff'];
  const crystalMats = crystalColors.map(
    (c) => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.8, flatShading: true, roughness: 0.2 }),
  );
  const crystalGeo = new THREE.OctahedronGeometry(0.6, 0);
  const rnd = mulberry32(7);
  const placements: THREE.Matrix4[][] = [[], [], []];
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const sv = new THREE.Vector3();
  const pv = new THREE.Vector3();
  const add = (x: number, y: number, z: number, sc: number, tilt: number, ci: number) => {
    q.setFromEuler(e.set((rnd() - 0.5) * tilt, rnd() * 3, (rnd() - 0.5) * tilt));
    placements[ci].push(new THREE.Matrix4().compose(pv.set(x, y, z), q, sv.set(sc * 0.6, sc * 2, sc * 0.6)));
  };
  let ci = 0;
  for (let i = 0; i < 30; i++) {
    const a = rnd() * Math.PI * 2;
    const rad = CAVE.r - 1.5 - rnd() * 2.5;
    const x = CAVE.x + Math.cos(a) * rad;
    const z = CAVE.z + Math.sin(a) * rad;
    if (inCaveDoor(x, z)) continue;
    const sc = 0.8 + rnd() * 1.6;
    add(x, baseY + sc * 0.8, z, sc, 0.6, ci++ % 3);
  }
  for (let i = 0; i < 22; i++) {
    const a = rnd() * Math.PI * 2;
    let da = Math.abs(a - ((CAVE.doorAngle + Math.PI * 2) % (Math.PI * 2)));
    da = Math.min(da, Math.PI * 2 - da);
    if (da < 0.35) continue;
    const rad = CAVE.r + 2 + rnd() * (CAVE.outer - CAVE.r - 5);
    const cx = CAVE.x + Math.cos(a) * rad;
    const cz = CAVE.z + Math.sin(a) * rad;
    const cy = heightAt(rad, a);
    for (let k = 0; k < 3; k++) {
      const sc = 0.7 + rnd() * 1.1;
      add(cx + (rnd() - 0.5) * 1.6, cy + sc * 0.6, cz + (rnd() - 0.5) * 1.6, sc, 0.9, (ci + k) % 3);
    }
    ci++;
  }
  for (let i = 0; i < 8; i++) {
    const a = rnd() * Math.PI * 2;
    const rad = rnd() * 6;
    const sc = 1.5 + rnd() * 2;
    add(CAVE.x + Math.cos(a) * rad, heightAt(rad, a) + sc, CAVE.z + Math.sin(a) * rad, sc, 0.6, i % 3);
  }
  placements.forEach((list, k) => {
    const inst = new THREE.InstancedMesh(crystalGeo, crystalMats[k], list.length);
    list.forEach((mm, i) => inst.setMatrixAt(i, mm));
    group.add(inst);
  });
  const l1 = new THREE.PointLight('#c77dff', 60, 40, 1.6);
  l1.position.set(CAVE.x, baseY + 7, CAVE.z);
  const l2 = new THREE.PointLight('#5ff2ff', 30, 30, 1.6);
  l2.position.set(CAVE.x - ex * 6, baseY + 4, CAVE.z - ez * 6);
  group.add(l1, l2);

  const sign = signboard('💎 Crystal Cave', 4.2, 1.1, 1.6);
  const mouth = CAVE.outer + 2.5;
  const sx = CAVE.x + ex * mouth + px * (CAVE.doorHalf + 2.2);
  const sz = CAVE.z + ez * mouth + pz * (CAVE.doorHalf + 2.2);
  placeFacing(sign, sx, sz, sx + ex * 10, sz + ez * 10);
  group.add(sign);

  return {
    group,
    update(t: number) {
      const glow = 0.65 + Math.sin(t * 1.7) * 0.25;
      for (const mat of crystalMats) mat.emissiveIntensity = glow;
      l1.intensity = 50 + Math.sin(t * 1.3) * 12;
    },
  };
}

function buildClouds(): THREE.Group {
  const g = new THREE.Group();
  const rnd = mulberry32(99);
  const mat = new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true, emissive: '#ffffff', emissiveIntensity: 0.3 });
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const CLOUDS = 18;
  const PUFFS = 7;
  const inst = new THREE.InstancedMesh(geo, mat, CLOUDS * PUFFS);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const v = new THREE.Vector3();
  let n = 0;
  for (let i = 0; i < CLOUDS; i++) {
    const a = rnd() * Math.PI * 2;
    const r = 60 + rnd() * 170;
    const cx = Math.cos(a) * r;
    const cy = 75 + rnd() * 35;
    const cz = Math.sin(a) * r;
    const heading = rnd() * Math.PI;
    for (let k = 0; k < PUFFS; k++) {
      const along = (k - (PUFFS - 1) / 2) * 3.6;
      const mid = 1 - Math.abs(along) / 14;
      const sc = (3.2 + rnd() * 2.5) * (0.6 + mid * 0.6);
      v.set(Math.cos(heading) * along + (rnd() - 0.5) * 3, rnd() * 2 + mid * 2, Math.sin(heading) * along + (rnd() - 0.5) * 3);
      q.setFromEuler(new THREE.Euler(rnd(), rnd() * 3, rnd()));
      m.compose(v.add(new THREE.Vector3(cx, cy, cz)), q, s.set(sc, sc * 0.75, sc));
      inst.setMatrixAt(n++, m);
    }
  }
  g.add(inst);
  return g;
}

function buildLobby(): THREE.Group {
  const g = new THREE.Group();
  const floor = new THREE.Mesh(
    new THREE.CylinderGeometry(LOBBY.r, LOBBY.r * 0.92, 0.5, 48),
    new THREE.MeshPhongMaterial({ color: '#c9f6ff', transparent: true, opacity: 0.42, shininess: 120, specular: '#ffffff' }),
  );
  floor.position.set(LOBBY.x, LOBBY.y - 0.25, LOBBY.z);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(LOBBY.r, 0.24, 8, 64), lambert(PALETTE.pink));
  rim.rotation.x = Math.PI / 2;
  rim.position.set(LOBBY.x, LOBBY.y, LOBBY.z);
  const underRim = new THREE.Mesh(new THREE.TorusGeometry(LOBBY.r * 0.92, 0.14, 6, 64), lambert(INK));
  underRim.rotation.x = Math.PI / 2;
  underRim.position.set(LOBBY.x, LOBBY.y - 0.5, LOBBY.z);
  const rail = new THREE.Mesh(
    new THREE.CylinderGeometry(LOBBY.r, LOBBY.r, 1.1, 64, 1, true),
    new THREE.MeshPhongMaterial({ color: '#e8fcff', transparent: true, opacity: 0.18, side: THREE.DoubleSide, depthWrite: false }),
  );
  rail.position.set(LOBBY.x, LOBBY.y + 0.55, LOBBY.z);
  const topRail = new THREE.Mesh(new THREE.TorusGeometry(LOBBY.r, 0.09, 6, 64), lambert(PALETTE.gold));
  topRail.rotation.x = Math.PI / 2;
  topRail.position.set(LOBBY.x, LOBBY.y + 1.1, LOBBY.z);
  g.add(floor, rim, underRim, rail, topRail);

  const center = new THREE.Mesh(fourPointStar(2.2, 0.75, 0.25), lambert(PALETTE.gold));
  center.position.set(LOBBY.x, LOBBY.y + 0.01, LOBBY.z);
  center.rotation.y = Math.PI / 4;
  g.add(center);

  const balloonColors = [PALETTE.pink, PALETTE.yellow, PALETTE.blue, PALETTE.purple];
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
  const sign = makeLabel('🎟️ Launching soon', { bg: PALETTE.pink, fg: '#ffffff', scale: 0.02 });
  sign.position.set(LOBBY.x, LOBBY.y + 5.5, LOBBY.z);
  g.add(sign);
  return g;
}

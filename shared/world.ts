// The island is fully procedural and deterministic: the browser builds its mesh from
// terrainHeight() and the server uses the very same function to validate movement and
// re-simulate throws. Coordinates: +x = east, -z = north, y = up. Water sits at y = 0.

import { fbm, lerp, mulberry32, ramp } from './noise';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export type Mode = 'lobby' | 'island';
export type CritterKind = 'land' | 'ocean' | 'sky' | 'cave';

export const WATER_Y = 0;
export const EYE_HEIGHT = 1.6;
export const WALK_SPEED = 6;
export const RUN_SPEED = 10;
export const JUMP_SPEED = 7.5;
export const PLAYER_GRAVITY = -22;
export const THROW_SPEED = 26;
export const BALL_GRAVITY = -14;
export const THROW_MAX_T = 3;
export const PICKUP_RADIUS = 2.2;
/** The roaming card slab floats this high above the ground (its centre). */
export const CARD_HOVER = 1.8;
export const CARD_HIT_RADIUS = 1.8;
/** Clients draw the server-simulated card this far in the past; hit checks use the same delay. */
export const INTERP_DELAY_MS = 150;

export const LOBBY = { x: 0, y: 58, z: 0, r: 11 };
export const PLAZA = { x: 0, z: 0, r: 8 };
export const BAZAAR = { x: -52, z: 48, r: 11 };
/** Stadium on the west side. `r` is the outer wall radius; the pitch is flattened inside it. */
export const ARENA = { x: -46, z: 4, r: 13 };
/** Dex Master NPC pavilion just east of the spawn pad. */
export const DEX_MASTER = { x: 18, z: 2, r: 4 };

/** Shallow ponds (wadeable: the bed sits above the DEEP walking limit). */
export const PONDS = [
  { x: -26, z: -48, r: 7 },
  { x: 38, z: 6, r: 6 },
  { x: -14, z: 46, r: 6 },
];
/** A short river running from the mountain foot east into the sea. */
export const RIVER: [number, number][] = [[72, -16], [79, -11], [88, -10], [96, -5], [108, 0]];
export const RIVER_HALF_WIDTH = 2.4;
const WATER_BED = -0.85;

/** Low-frequency "flat" terrain level; landmarks are leveled to this at their center. */
const flatLevel = (x: number, z: number) => 2.4 + fbm(x * 0.012, z * 0.012, 9, 2) * 3;
/** Exact ground height of the spawn pad, arena pitch and Dex Master pavilion. */
export const PLAZA_Y = flatLevel(PLAZA.x, PLAZA.z);
export const ARENA_Y = flatLevel(ARENA.x, ARENA.z);
export const DEX_MASTER_Y = flatLevel(DEX_MASTER.x, DEX_MASTER.z);
/** Crystal mountain in the north-east. `r` is the cave's inner wall, `outer` the mountain foot. */
export const CAVE = { x: 46, z: -44, r: 18, outer: 31, floorY: 3, doorHalf: 3.2, doorAngle: Math.atan2(44, -46) };

export const PATHS: [number, number][][] = [
  [[0, 0], [16, -14], [28, -26], [36, -34.5], [46, -44]], // NE → crystal cave
  [[0, 0], [-16, 14], [-34, 30], [-52, 48]], // SW → bazaar
  [[0, 0], [-24, -16], [-50, -30], [-78, -40]], // NW beach
  [[0, 0], [22, 18], [46, 40], [66, 58]], // SE beach
  [[0, 0], [10, 30], [4, 56], [-4, 82]], // south beach
  [[0, 0], [-6, -30], [2, -58], [-4, -84]], // north beach
  [[0, 0], [-20, 2], [-33, 4]], // W → arena
];

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax;
  const vz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / (vx * vx + vz * vz)));
  return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
}

export function pathDistance(x: number, z: number): number {
  let best = Infinity;
  for (const p of PATHS) {
    for (let i = 0; i < p.length - 1; i++) {
      const d = segDist(x, z, p[i][0], p[i][1], p[i + 1][0], p[i + 1][1]);
      if (d < best) best = d;
    }
  }
  return best;
}

export function riverDistance(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < RIVER.length - 1; i++) {
    const d = segDist(x, z, RIVER[i][0], RIVER[i][1], RIVER[i + 1][0], RIVER[i + 1][1]);
    if (d < best) best = d;
  }
  return best;
}

/** 0 on dry land, 1 in the middle of a pond or river. */
export function inlandWater(x: number, z: number): number {
  let k = ramp(riverDistance(x, z), RIVER_HALF_WIDTH + 2.2, RIVER_HALF_WIDTH * 0.5);
  for (const p of PONDS) k = Math.max(k, ramp(Math.hypot(x - p.x, z - p.z), p.r + 2.5, p.r * 0.45));
  return k;
}

export function coastRadius(angle: number): number {
  const n = fbm(Math.cos(angle) * 1.3 + 20, Math.sin(angle) * 1.3 + 20, 11, 3);
  return 90 + (n - 0.5) * 22;
}

export function terrainHeight(x: number, z: number): number {
  const d = Math.hypot(x, z);
  const t = d / coastRadius(Math.atan2(z, x));

  const rolling = 2.4 + fbm(x * 0.03 + 3, z * 0.03 + 7, 5, 4) * 7.5;
  const flat = flatLevel(x, z);
  const flatten = Math.max(
    ramp(pathDistance(x, z), 4.5, 1.8),
    ramp(Math.hypot(x - PLAZA.x, z - PLAZA.z), PLAZA.r + 5, PLAZA.r),
    ramp(Math.hypot(x - BAZAAR.x, z - BAZAAR.z), BAZAAR.r + 5, BAZAAR.r),
    ramp(Math.hypot(x - ARENA.x, z - ARENA.z), ARENA.r + 6, ARENA.r + 1),
    ramp(Math.hypot(x - DEX_MASTER.x, z - DEX_MASTER.z), DEX_MASTER.r + 4, DEX_MASTER.r),
  );
  let inland = lerp(rolling, flat, flatten);
  inland = lerp(inland, PLAZA_Y, ramp(Math.hypot(x - PLAZA.x, z - PLAZA.z), PLAZA.r + 3, PLAZA.r - 0.5));
  inland = lerp(inland, ARENA_Y, ramp(Math.hypot(x - ARENA.x, z - ARENA.z), ARENA.r + 4, ARENA.r));
  inland = lerp(inland, DEX_MASTER_Y, ramp(Math.hypot(x - DEX_MASTER.x, z - DEX_MASTER.z), DEX_MASTER.r + 3, DEX_MASTER.r));

  const sea = lerp(-5, 0.6, ramp(t, 1.12, 0.98));
  let h = lerp(sea, inland, ramp(t, 0.92, 0.72));

  const dc = Math.hypot(x - CAVE.x, z - CAVE.z);
  if (dc < CAVE.outer + 6) h = lerp(h, CAVE.floorY, ramp(dc, CAVE.outer + 6, CAVE.outer - 4));

  const w = inlandWater(x, z);
  if (w > 0) h = Math.min(h, lerp(h, WATER_BED, w));
  return h;
}

export function groundHeight(x: number, z: number, mode: Mode): number {
  return mode === 'lobby' ? LOBBY.y : terrainHeight(x, z);
}

// ── Cave collision ─────────────────────────────────────────────────────

/** True when (x,z) is inside the straight tunnel that cuts through the mountain ring. */
export function inCaveDoor(x: number, z: number): boolean {
  const ex = Math.cos(CAVE.doorAngle);
  const ez = Math.sin(CAVE.doorAngle);
  const px = x - CAVE.x;
  const pz = z - CAVE.z;
  const along = px * ex + pz * ez;
  const perp = Math.abs(px * ez - pz * ex);
  return along > 0 && perp < CAVE.doorHalf;
}

function inMountainRing(x: number, z: number): boolean {
  const d = Math.hypot(x - CAVE.x, z - CAVE.z);
  return d > CAVE.r - 0.6 && d < CAVE.outer + 0.6 && !inCaveDoor(x, z);
}

export function insideCave(x: number, z: number): boolean {
  return Math.hypot(x - CAVE.x, z - CAVE.z) < CAVE.r;
}

/** Shared movement rules. Returns where a walker trying to go from → to actually ends up. */
export function resolveMove(fromX: number, fromZ: number, toX: number, toZ: number, mode: Mode): { x: number; z: number } {
  if (mode === 'lobby') {
    const d = Math.hypot(toX - LOBBY.x, toZ - LOBBY.z);
    const max = LOBBY.r - 0.7;
    if (d <= max) return { x: toX, z: toZ };
    const k = max / d;
    return { x: LOBBY.x + (toX - LOBBY.x) * k, z: LOBBY.z + (toZ - LOBBY.z) * k };
  }

  let x = toX;
  let z = toZ;
  const DEEP = -1.4;
  if (terrainHeight(x, z) < DEEP) {
    if (terrainHeight(x, fromZ) >= DEEP) z = fromZ;
    else if (terrainHeight(fromX, z) >= DEEP) x = fromX;
    else return { x: fromX, z: fromZ };
  }

  if (inMountainRing(x, z)) {
    const dFrom = Math.hypot(fromX - CAVE.x, fromZ - CAVE.z);
    const dx = x - CAVE.x;
    const dz = z - CAVE.z;
    const d = Math.hypot(dx, dz) || 1;
    if (dFrom < CAVE.r - 0.6) {
      const k = (CAVE.r - 0.7) / d;
      return { x: CAVE.x + dx * k, z: CAVE.z + dz * k };
    }
    if (dFrom > CAVE.outer + 0.6) {
      const k = (CAVE.outer + 0.7) / d;
      return { x: CAVE.x + dx * k, z: CAVE.z + dz * k };
    }
    return { x: fromX, z: fromZ };
  }
  return { x, z };
}

// ── Throws ─────────────────────────────────────────────────────────────

export function ballAt(o: Vec3, d: Vec3, t: number): Vec3 {
  return {
    x: o.x + d.x * THROW_SPEED * t,
    y: o.y + d.y * THROW_SPEED * t + 0.5 * BALL_GRAVITY * t * t,
    z: o.z + d.z * THROW_SPEED * t,
  };
}

/** Steps a thrown ball and returns the flight time at which it touches the target sphere, or null. */
export function traceHit(o: Vec3, d: Vec3, target: (t: number) => Vec3, radius: number): number | null {
  const r2 = radius * radius;
  for (let t = 0; t <= THROW_MAX_T; t += 1 / 60) {
    const p = ballAt(o, d, t);
    const c = target(t);
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const dz = p.z - c.z;
    if (dx * dx + dy * dy + dz * dz <= r2) return t;
    if (p.y < Math.max(terrainHeight(p.x, p.z), WATER_Y - 3)) return null;
  }
  return null;
}

// ── Creature motion (deterministic so both sides agree where things are) ──

export interface SpawnInfo {
  id: string;
  species: number;
  kind: CritterKind;
  hx: number;
  hz: number;
  seed: number;
  born: number;
}

export interface Pose {
  x: number;
  y: number;
  z: number;
  heading: number;
  airborne: boolean;
}

function wander(seed: number, t: number, amp: number, speed: number) {
  const r = mulberry32(seed);
  const w1 = speed * (0.7 + r() * 0.6);
  const w2 = speed * (0.7 + r() * 0.6);
  const w3 = speed * (1.7 + r());
  const w4 = speed * (1.9 + r());
  const p1 = r() * 6.283;
  const p2 = r() * 6.283;
  const p3 = r() * 6.283;
  const p4 = r() * 6.283;
  const x = amp * (0.8 * Math.sin(w1 * t + p1) + 0.2 * Math.sin(w3 * t + p3));
  const z = amp * (0.8 * Math.sin(w2 * t + p2) + 0.2 * Math.sin(w4 * t + p4));
  const dx = 0.8 * w1 * Math.cos(w1 * t + p1) + 0.2 * w3 * Math.cos(w3 * t + p3);
  const dz = 0.8 * w2 * Math.cos(w2 * t + p2) + 0.2 * w4 * Math.cos(w4 * t + p4);
  return { x, z, heading: Math.atan2(dx, dz) };
}

const SKY_PERIOD = 40;

export function critterPose(s: SpawnInfo, nowMs: number): Pose {
  const t = (nowMs - s.born) / 1000;
  switch (s.kind) {
    case 'land': {
      const w = wander(s.seed, t, 6, 0.25);
      const x = s.hx + w.x;
      const z = s.hz + w.z;
      return { x, y: terrainHeight(x, z), z, heading: w.heading, airborne: false };
    }
    case 'cave': {
      const w = wander(s.seed, t, 3.5, 0.3);
      const x = s.hx + w.x;
      const z = s.hz + w.z;
      return { x, y: terrainHeight(x, z), z, heading: w.heading, airborne: false };
    }
    case 'ocean': {
      const w = wander(s.seed, t, 7, 0.2);
      return {
        x: s.hx + w.x,
        y: WATER_Y - 0.25 + 0.12 * Math.sin(t * 2.1 + (s.seed % 7)),
        z: s.hz + w.z,
        heading: w.heading,
        airborne: false,
      };
    }
    case 'sky': {
      const ground = terrainHeight(s.hx, s.hz);
      const offset = s.seed % SKY_PERIOD;
      const fly = (tt: number): Pose => {
        const a = tt * 0.45 + (s.seed % 6);
        return {
          x: s.hx + Math.cos(a) * 10,
          y: ground + 13 + Math.sin(tt * 0.9) * 1.5,
          z: s.hz + Math.sin(a) * 10,
          heading: Math.atan2(-Math.sin(a), Math.cos(a)),
          airborne: true,
        };
      };
      const ph = (((t + offset) % SKY_PERIOD) + SKY_PERIOD) % SKY_PERIOD;
      const home: Pose = { x: s.hx, y: ground, z: s.hz, heading: s.seed % 6, airborne: false };
      if (ph < 28) return fly(t);
      if (ph < 30) return mix(fly(t - (ph - 28)), home, (ph - 28) / 2);
      if (ph < 37) return home;
      return mix(home, fly(t - ph + SKY_PERIOD), (ph - 37) / 3);
    }
  }
}

function mix(a: Pose, b: Pose, k: number): Pose {
  const s = k * k * (3 - 2 * k);
  return { x: lerp(a.x, b.x, s), y: lerp(a.y, b.y, s), z: lerp(a.z, b.z, s), heading: s < 0.5 ? a.heading : b.heading, airborne: true };
}

/** Center of a critter's hit sphere. */
export function critterCenter(p: Pose, size: number): Vec3 {
  return { x: p.x, y: p.y + 0.55 * size, z: p.z };
}
export const critterHitRadius = (size: number) => 0.6 * size + 0.5;

// ── Spawn placement (server side, but kept here next to the terrain rules) ──

export function randomLandPoint(rnd: () => number, margin = 7): { x: number; z: number } {
  for (let i = 0; i < 400; i++) {
    const a = rnd() * Math.PI * 2;
    const r = 10 + Math.sqrt(rnd()) * 70;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (terrainHeight(x, z) < 1.4) continue;
    if (Math.hypot(x - CAVE.x, z - CAVE.z) < CAVE.outer + margin + 2) continue;
    if (Math.hypot(x - BAZAAR.x, z - BAZAAR.z) < BAZAAR.r + 3) continue;
    if (Math.hypot(x - ARENA.x, z - ARENA.z) < ARENA.r + 2) continue;
    if (Math.hypot(x - DEX_MASTER.x, z - DEX_MASTER.z) < DEX_MASTER.r + 2) continue;
    let ok = true;
    for (let k = 0; k < 8 && ok; k++) {
      const b = (k / 8) * Math.PI * 2;
      if (terrainHeight(x + Math.cos(b) * margin, z + Math.sin(b) * margin) < 0.6) ok = false;
    }
    if (ok) return { x, z };
  }
  return { x: 6, z: 6 };
}

export function randomOceanPoint(rnd: () => number): { x: number; z: number } {
  for (let i = 0; i < 400; i++) {
    const a = rnd() * Math.PI * 2;
    const r = coastRadius(a) + 16 + rnd() * 10;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (terrainHeight(x, z) > -3) continue;
    let ok = true;
    for (let k = 0; k < 8 && ok; k++) {
      const b = (k / 8) * Math.PI * 2;
      if (terrainHeight(x + Math.cos(b) * 9, z + Math.sin(b) * 9) > -1) ok = false;
    }
    if (ok) return { x, z };
  }
  return { x: 0, z: 125 };
}

export function randomCavePoint(rnd: () => number): { x: number; z: number } {
  const a = rnd() * Math.PI * 2;
  const r = Math.sqrt(rnd()) * (CAVE.r - 6);
  return { x: CAVE.x + Math.cos(a) * r, z: CAVE.z + Math.sin(a) * r };
}

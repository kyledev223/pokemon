import { CAVE, CARD_HOVER, inlandWater, randomLandPoint, terrainHeight, type Vec3 } from '../shared/world';

// The roaming card slab is simulated on the server only: it wanders, runs from nearby
// trainers and teleports every few minutes. Clients render the broadcast positions about
// INTERP_DELAY_MS behind real time, and hit checks look up the same delayed position.

const WANDER_SPEED = 2.4;
const FLEE_SPEED = 7.2; // walkers (6) can't keep up, runners (10) can
const FLEE_RADIUS = 15;
const MAX_RADIUS = 86;
const HISTORY_MS = 4_000;

export interface CardSample {
  at: number;
  x: number;
  y: number;
  z: number;
  /** True on the first sample after a teleport (never interpolate across it). */
  jump: boolean;
}

function walkable(x: number, z: number): boolean {
  if (Math.hypot(x, z) > MAX_RADIUS) return false;
  if (terrainHeight(x, z) < 1.2 || inlandWater(x, z) > 0) return false;
  return Math.hypot(x - CAVE.x, z - CAVE.z) > CAVE.outer + 3;
}

export class CardMover {
  x: number;
  z: number;
  private heading = Math.random() * Math.PI * 2;
  private turn = 0;
  private history: CardSample[] = [];
  nextTeleportAt: number;
  fleeing = false;

  constructor(
    private teleportMs: () => number,
    now = Date.now(),
  ) {
    const p = randomLandPoint(Math.random, 6);
    this.x = p.x;
    this.z = p.z;
    this.nextTeleportAt = now + this.jitter();
    this.push(now, true);
  }

  private jitter(): number {
    return this.teleportMs() * (0.75 + Math.random() * 0.5);
  }

  get y(): number {
    return terrainHeight(this.x, this.z) + CARD_HOVER;
  }

  /** Advance by dt seconds given trainer positions. Returns true when it teleported. */
  step(dt: number, now: number, trainers: Iterable<Vec3>): boolean {
    if (now >= this.nextTeleportAt) {
      this.teleport(now);
      return true;
    }
    let nearest: Vec3 | null = null;
    let nd = Infinity;
    for (const p of trainers) {
      const d = Math.hypot(p.x - this.x, p.z - this.z);
      if (d < nd) {
        nd = d;
        nearest = p;
      }
    }
    this.fleeing = !!nearest && nd < FLEE_RADIUS;
    let speed = WANDER_SPEED;
    if (this.fleeing && nearest) {
      const away = Math.atan2(this.x - nearest.x, this.z - nearest.z);
      this.heading = lerpAngle(this.heading, away, Math.min(1, dt * 6));
      speed = FLEE_SPEED;
    } else {
      this.turn += (Math.random() - 0.5) * dt * 2;
      this.turn = Math.max(-0.8, Math.min(0.8, this.turn));
      this.heading += this.turn * dt;
    }
    // Try the desired heading, then fan out until something is walkable (coast, cave, ponds).
    for (const off of [0, 0.5, -0.5, 1, -1, 1.6, -1.6, 2.4, -2.4, Math.PI]) {
      const h = this.heading + off;
      const nx = this.x + Math.sin(h) * speed * dt;
      const nz = this.z + Math.cos(h) * speed * dt;
      if (walkable(nx, nz)) {
        this.x = nx;
        this.z = nz;
        if (off !== 0) this.heading = h;
        break;
      }
    }
    this.push(now, false);
    return false;
  }

  teleport(now: number): void {
    for (let i = 0; i < 30; i++) {
      const p = randomLandPoint(Math.random, 6);
      if (Math.hypot(p.x - this.x, p.z - this.z) > 35 && walkable(p.x, p.z)) {
        this.x = p.x;
        this.z = p.z;
        break;
      }
    }
    this.heading = Math.random() * Math.PI * 2;
    this.nextTeleportAt = now + this.jitter();
    this.push(now, true);
  }

  private push(now: number, jump: boolean): void {
    this.history.push({ at: now, x: this.x, y: this.y, z: this.z, jump });
    while (this.history.length > 2 && this.history[0].at < now - HISTORY_MS) this.history.shift();
  }

  latest(): CardSample {
    return this.history[this.history.length - 1];
  }

  /** Position at server time `t` from the recorded path (clamped to the recorded window). */
  posAt(t: number): Vec3 {
    const h = this.history;
    if (t <= h[0].at) return h[0];
    for (let i = h.length - 1; i > 0; i--) {
      const a = h[i - 1];
      const b = h[i];
      if (t >= a.at) {
        if (t >= b.at) return b;
        if (b.jump) return a;
        const k = (t - a.at) / (b.at - a.at);
        return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k };
      }
    }
    return h[h.length - 1];
  }
}

function lerpAngle(a: number, b: number, k: number): number {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

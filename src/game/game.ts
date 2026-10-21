import * as THREE from 'three';
import { speciesById } from '../../shared/species';
import { hashString } from '../../shared/noise';
import {
  BALL_GRAVITY,
  BAZAAR,
  CAVE,
  CARD_HIT_RADIUS,
  CARD_SCALE,
  EYE_HEIGHT,
  JUMP_SPEED,
  LOBBY,
  PICKUP_RADIUS,
  PLAYER_GRAVITY,
  RUN_SPEED,
  THROW_SPEED,
  WALK_SPEED,
  WATER_Y,
  cardCenter,
  cardPose,
  critterCenter,
  critterHitRadius,
  critterPose,
  groundHeight,
  resolveMove,
  terrainHeight,
  traceHit,
  type Mode,
  type SpawnInfo,
  type Vec3,
} from '../../shared/world';
import type { Ball, Economy, EventInfo, PublicCard, ServerMsg, ThrowKind, YouInfo } from '../../shared/protocol';
import { buildIsland, makeLabel, type Island } from './world3d';
import { animateCritter, buildCritter, type CritterRig } from './critterMesh';
import { Input } from './input';
import { Net } from './net';
import { Sfx } from './audio';

export interface GameHooks {
  onEconomy(e: Economy): void;
  onCard(card: PublicCard | null): void;
  onYou(you: YouInfo): void;
  onGold(n: number): void;
  onDex(dex: number[]): void;
  onEvent(e: EventInfo | null): void;
  onToast(text: string, tone: 'info' | 'gold' | 'pink' | 'warn'): void;
  onCardCaught(m: Extract<ServerMsg, { t: 'cardCaught' }>, mine: boolean): void;
  onPause(paused: boolean): void;
  onKey(code: string): void;
  onNearBazaar(near: boolean): void;
}

interface Remote {
  group: THREE.Group;
  target: THREE.Vector3;
  ry: number;
}

interface CritterView {
  info: SpawnInfo;
  rig: CritterRig;
  size: number;
  phase: number;
  wobbleUntil: number;
  dying: number;
}

interface Projectile {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  kind: ThrowKind;
  bounces: number;
  life: number;
  stopAt: number | null;
  age: number;
}

interface Burst {
  points: THREE.Points;
  vel: Float32Array;
  age: number;
}

const ORB_GEO = new THREE.IcosahedronGeometry(0.22, 1);
const ORB_MAT = new THREE.MeshStandardMaterial({ color: '#ff3d8b', emissive: '#ff3d8b', emissiveIntensity: 0.35, flatShading: true });
const GOLD_MAT = new THREE.MeshStandardMaterial({ color: '#ffc21a', emissive: '#ffb300', emissiveIntensity: 0.5, metalness: 0.5, roughness: 0.3, flatShading: true });
const BALL_GEO = new THREE.IcosahedronGeometry(0.36, 1);
const BEAM_GEO = new THREE.CylinderGeometry(0.08, 0.08, 7, 6, 1, true);
const BEAM_MAT = new THREE.MeshBasicMaterial({ color: '#ffd34d', transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending });

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1200);
  readonly net = new Net();
  readonly sfx = new Sfx();
  readonly input: Input;
  private island: Island;
  private timer = new THREE.Timer();

  mode: Mode = 'lobby';
  playing = false;
  joined = false;
  private spawned = false;
  private pos = new THREE.Vector3(0, LOBBY.y, 4);
  private velY = 0;
  private yaw = 0;
  private pitch = 0;
  private onGround = true;

  slot: 1 | 2 = 1;
  gold = 0;
  you: YouInfo | null = null;
  economy: Economy | null = null;
  event: EventInfo | null = null;

  private remotes = new Map<string, Remote>();
  private balls = new Map<string, THREE.Group>();
  private critters = new Map<string, CritterView>();
  private card: { info: PublicCard; rig: CritterRig; holder: THREE.Group; plane: THREE.Mesh; light: THREE.PointLight } | null = null;
  private projectiles: Projectile[] = [];
  private bursts: Burst[] = [];
  private lastPosSent = 0;
  private lastThrow = 0;
  private pickupSent = new Map<string, number>();
  private nearBazaar = false;
  private textureLoader = new THREE.TextureLoader();

  constructor(
    private shell: HTMLElement,
    canvas: HTMLCanvasElement,
    private hooks: GameHooks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.island = buildIsland();
    this.island.scene.add(this.camera);
    this.input = new Input(canvas);
    this.input.onThrow = (k) => this.throwBall(k === 'gold' || this.slot === 2 ? 'gold' : 'orb');
    this.input.onWheel = () => this.setSlot(this.slot === 1 ? 2 : 1);
    this.input.onKey = (code) => {
      if (code === 'Digit1') this.setSlot(1);
      else if (code === 'Digit2') this.setSlot(2);
      else if (code === 'KeyF') this.throwBall('gold');
      else if (code === 'KeyE' && this.nearBazaar) hooks.onKey('market');
      else hooks.onKey(code);
    };

    document.addEventListener('pointerlockchange', () => {
      if (!this.playing || this.input.isTouch) return;
      hooks.onPause(!this.input.locked);
    });

    new ResizeObserver(() => this.resize()).observe(shell);
    this.resize();
    this.net.on((m) => this.onMessage(m));
    this.net.connect();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ── Public controls ─────────────────────────────────────────────────

  join(name: string): void {
    this.sfx.unlock();
    this.joined = true;
    this.net.join(name);
  }

  play(): void {
    this.playing = true;
    this.input.active = true;
    this.shell.classList.add('playing');
    this.input.lock();
  }

  resume(): void {
    this.input.lock();
  }

  setSlot(s: 1 | 2): void {
    this.slot = s;
    this.shell.querySelectorAll('.slot').forEach((el) => el.classList.toggle('active', (el as HTMLElement).dataset.slot === String(s)));
  }

  /** Card hit preview so the HUD can show the odds of the next hit. */
  get currentCard(): PublicCard | null {
    return this.card?.info ?? null;
  }

  // ── Network ─────────────────────────────────────────────────────────

  private onMessage(m: ServerMsg): void {
    switch (m.t) {
      case 'init':
        for (const id of [...this.critters.keys()]) this.removeCritter(id, false);
        for (const id of [...this.balls.keys()]) this.removeBall(id);
        m.critters.forEach((s) => this.addCritter(s));
        m.balls.forEach((b) => this.addBall(b));
        this.setCard(m.card);
        this.setEconomy(m.economy);
        this.event = m.event;
        this.hooks.onEvent(m.event);
        break;
      case 'you': {
        this.you = m.you;
        this.gold = m.you.gold;
        const modeChanged = m.mode !== this.mode;
        this.mode = m.mode;
        if (!this.spawned || modeChanged) {
          this.pos.set(m.spawn.x, m.spawn.y, m.spawn.z);
          this.velY = 0;
          this.yaw = m.mode === 'lobby' ? 0 : Math.atan2(-CAVE.x, -CAVE.z); // face the crystal mountain
          this.spawned = true;
        }
        this.island.lobby.visible = this.mode === 'lobby' || !this.economy?.launched;
        this.hooks.onYou(m.you);
        this.hooks.onGold(this.gold);
        this.hooks.onDex(m.you.dex);
        break;
      }
      case 'players': {
        const seen = new Set<string>();
        for (const p of m.list) {
          if (p.id === this.you?.id) continue;
          seen.add(p.id);
          let r = this.remotes.get(p.id);
          if (!r) {
            r = this.makeRemote(p.id, p.name);
            r.group.position.set(p.x, p.y, p.z);
            this.remotes.set(p.id, r);
          }
          r.target.set(p.x, p.y, p.z);
          r.ry = p.ry;
        }
        for (const [id, r] of this.remotes) {
          if (!seen.has(id)) {
            this.island.scene.remove(r.group);
            this.remotes.delete(id);
          }
        }
        break;
      }
      case 'left': {
        const r = this.remotes.get(m.id);
        if (r) this.island.scene.remove(r.group);
        this.remotes.delete(m.id);
        break;
      }
      case 'balls+':
        m.balls.forEach((b) => this.addBall(b));
        break;
      case 'ball-':
        if (this.pickupSent.has(m.id)) {
          this.sfx.pickup();
          const b = this.balls.get(m.id);
          if (b) this.burst(b.position, '#ffd34d');
        }
        this.removeBall(m.id);
        break;
      case 'critter+':
        m.spawns.forEach((s) => this.addCritter(s));
        break;
      case 'critter-':
        this.removeCritter(m.id, true);
        break;
      case 'catch':
        this.onCatch(m);
        break;
      case 'card':
        this.setCard(m.card);
        break;
      case 'cardHit':
        if (this.card && this.card.info.id === m.cardId) {
          this.card.info.throws = m.index + 1;
          this.card.info.nextOdds = Math.min(0.25, m.odds + 0.00012);
          this.hooks.onCard(this.card.info);
          this.burst(this.card.holder.position.clone().setY(this.card.holder.position.y + 1.5), '#ffd34d');
        }
        if (m.byId === this.you?.id && !m.won) {
          this.sfx.cardHit();
          this.hooks.onToast(`🎯 Hit #${m.index + 1} at ${(m.odds * 100).toFixed(3)}%. Not this time, odds go up!`, 'gold');
        }
        break;
      case 'cardCaught': {
        const mine = m.byId === this.you?.id;
        if (this.card) this.burst(this.card.holder.position, '#ffd34d', 80);
        if (mine) this.sfx.fanfare();
        this.hooks.onCardCaught(m, mine);
        break;
      }
      case 'economy':
        this.setEconomy(m.e);
        break;
      case 'bag':
        this.gold = m.gold;
        this.hooks.onGold(m.gold);
        break;
      case 'dex':
        if (this.you) this.you.dex = m.dex;
        this.hooks.onDex(m.dex);
        break;
      case 'fx':
        if (m.by !== this.you?.id) this.spawnProjectile(m.kind, m.o, m.d);
        break;
      case 'toast':
        this.hooks.onToast(m.text, m.tone);
        break;
      case 'correct':
        this.pos.set(m.x, m.y, m.z);
        this.velY = 0;
        break;
      case 'event':
        this.event = m.event;
        this.hooks.onEvent(m.event);
        break;
    }
  }

  private setEconomy(e: Economy): void {
    this.economy = e;
    this.island.lobby.visible = !e.launched || this.mode === 'lobby';
    this.hooks.onEconomy(e);
  }

  private onCatch(m: Extract<ServerMsg, { t: 'catch' }>): void {
    const v = this.critters.get(m.spawnId);
    const mine = m.byId === this.you?.id;
    const sp = speciesById(m.species);
    if (m.ok) {
      if (v) this.burst(v.rig.group.position, '#ff3d8b', 40);
      if (mine) {
        this.sfx.caught();
        this.hooks.onToast(m.isNew ? `📖 New! You caught ${sp.name}.` : `You caught another ${sp.name}.`, 'pink');
      }
    } else {
      if (v) v.wobbleUntil = performance.now() + 900;
      if (mine) {
        this.sfx.escaped();
        this.hooks.onToast(`${sp.name} broke free!`, 'info');
      }
    }
  }

  // ── Scene objects ───────────────────────────────────────────────────

  private makeRemote(id: string, name: string): Remote {
    const g = new THREE.Group();
    const hue = (hashString(id) % 360) / 360;
    const color = new THREE.Color().setHSL(hue, 0.7, 0.62);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.8, 3, 8), new THREE.MeshLambertMaterial({ color, flatShading: true }));
    body.position.y = 0.85;
    const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.36, 1), new THREE.MeshLambertMaterial({ color: '#ffe3c4', flatShading: true }));
    head.position.y = 1.65;
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.38, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: '#ff3d8b' }));
    cap.position.y = 1.72;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.05, 0.3), new THREE.MeshLambertMaterial({ color: '#ff3d8b' }));
    visor.position.set(0, 1.74, 0.36);
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 4), new THREE.MeshBasicMaterial({ color: '#1d1530' }));
      eye.position.set(side * 0.13, 1.65, 0.32);
      g.add(eye);
    }
    const label = makeLabel(name, { scale: 0.009 });
    label.position.y = 2.5;
    g.add(body, head, cap, visor, label);
    this.island.scene.add(g);
    return { group: g, target: new THREE.Vector3(), ry: 0 };
  }

  private addBall(b: Ball): void {
    if (this.balls.has(b.id)) return;
    const g = new THREE.Group();
    const ball = new THREE.Mesh(BALL_GEO, GOLD_MAT);
    const beam = new THREE.Mesh(BEAM_GEO, BEAM_MAT);
    beam.position.y = 3.5;
    g.add(ball, beam);
    g.position.set(b.x, b.y, b.z);
    g.userData.phase = Math.random() * 6;
    g.userData.baseY = b.y;
    this.balls.set(b.id, g);
    this.island.scene.add(g);
  }

  private removeBall(id: string): void {
    const g = this.balls.get(id);
    if (g) this.island.scene.remove(g);
    this.balls.delete(id);
    this.pickupSent.delete(id);
  }

  private addCritter(s: SpawnInfo): void {
    if (this.critters.has(s.id)) return;
    const sp = speciesById(s.species);
    const rig = buildCritter(sp);
    this.island.scene.add(rig.group);
    this.critters.set(s.id, { info: s, rig, size: sp.size, phase: Math.random() * 6, wobbleUntil: 0, dying: 0 });
  }

  private removeCritter(id: string, animate: boolean): void {
    const v = this.critters.get(id);
    if (!v) return;
    if (animate) {
      v.dying = performance.now();
      return;
    }
    this.island.scene.remove(v.rig.group);
    this.critters.delete(id);
  }

  private setCard(info: PublicCard | null): void {
    if (this.card && (!info || info.id !== this.card.info.id)) {
      this.island.scene.remove(this.card.holder);
      this.card = null;
    }
    if (info && !this.card) {
      const rig = buildCritter(speciesById(info.species), { golden: true });
      rig.group.scale.setScalar(CARD_SCALE);
      const holder = new THREE.Group();
      holder.add(rig.group);
      const tex = this.textureLoader.load(info.image);
      tex.colorSpace = THREE.SRGBColorSpace;
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 2.38), new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide }));
      plane.position.y = CARD_SCALE * 1.35 + 1.5;
      holder.add(plane);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 60, 8, 1, true), BEAM_MAT);
      beam.position.y = 30;
      holder.add(beam);
      const light = new THREE.PointLight('#ffd34d', 18, 14, 1.5);
      light.position.y = 3;
      holder.add(light);
      this.island.scene.add(holder);
      this.card = { info, rig, holder, plane, light };
    } else if (info && this.card) this.card.info = info;
    this.hooks.onCard(info);
  }

  // ── Throwing ────────────────────────────────────────────────────────

  private throwBall(kind: ThrowKind): void {
    if (!this.playing || !this.joined) return;
    const now = performance.now();
    if (now - this.lastThrow < (kind === 'gold' ? 500 : 280)) return;
    if (kind === 'gold') {
      if (!this.economy?.launched) return this.hooks.onToast('Golden balls arrive at launch. Pink orbs are free!', 'info');
      if (this.gold <= 0) return this.hooks.onToast('No golden balls yet. Walk over the glowing ones on the island!', 'warn');
      this.gold--;
      this.hooks.onGold(this.gold);
    }
    this.lastThrow = now;
    const d = new THREE.Vector3();
    this.camera.getWorldDirection(d);
    d.y += 0.1;
    d.normalize();
    const o = this.camera.getWorldPosition(new THREE.Vector3()).addScaledVector(d, 0.5);
    o.y -= 0.15;
    const ov = { x: o.x, y: o.y, z: o.z };
    const dv = { x: d.x, y: d.y, z: d.z };
    this.net.send({ t: 'throw', kind, o: ov, d: dv, at: this.net.now() });
    this.spawnProjectile(kind, ov, dv);
    this.sfx.throw(kind === 'gold');
  }

  /** Visual projectile; predicts where it stops if it will hit a creature. */
  private spawnProjectile(kind: ThrowKind, o: Vec3, d: Vec3): void {
    const mesh = new THREE.Mesh(ORB_GEO, kind === 'gold' ? GOLD_MAT : ORB_MAT);
    mesh.position.set(o.x, o.y, o.z);
    this.island.scene.add(mesh);
    const at = this.net.now();
    let stopAt: number | null = null;
    if (kind === 'gold' && this.card) {
      const c = this.card.info;
      stopAt = traceHit(o, d, (dt) => cardCenter(cardPose(c.seed, c.releasedAt, at + dt * 1000)), CARD_HIT_RADIUS);
    } else if (kind === 'orb' && this.economy?.launched) {
      for (const v of this.critters.values()) {
        const p0 = critterPose(v.info, at);
        if (Math.hypot(p0.x - o.x, p0.z - o.z) > 90) continue;
        const t = traceHit(o, d, (dt) => critterCenter(critterPose(v.info, at + dt * 1000), v.size), critterHitRadius(v.size));
        if (t !== null && (stopAt === null || t < stopAt)) stopAt = t;
      }
    }
    this.projectiles.push({
      mesh,
      vel: new THREE.Vector3(d.x, d.y, d.z).multiplyScalar(THROW_SPEED),
      kind,
      bounces: 0,
      life: 8,
      stopAt,
      age: 0,
    });
  }

  private ballGround(x: number, y: number, z: number): number {
    if (this.mode === 'lobby' && Math.hypot(x - LOBBY.x, z - LOBBY.z) < LOBBY.r && y > LOBBY.y - 1) return LOBBY.y;
    return terrainHeight(x, z);
  }

  private updateProjectiles(dt: number): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.age += dt;
      p.life -= dt;
      if (p.stopAt !== null && p.age >= p.stopAt) {
        this.burst(p.mesh.position, p.kind === 'gold' ? '#ffd34d' : '#ff7ab6', 14);
        p.life = 0;
      } else {
        p.vel.y += BALL_GRAVITY * dt;
        p.mesh.position.addScaledVector(p.vel, dt);
        p.mesh.rotation.x += dt * 8;
        const { x, y, z } = p.mesh.position;
        const g = this.ballGround(x, y, z);
        if (y < WATER_Y - 0.3 && g < WATER_Y) {
          this.burst(p.mesh.position, '#bff3ff', 10);
          p.life = 0;
        } else if (y < g + 0.2) {
          p.mesh.position.y = g + 0.2;
          if (p.kind === 'gold' || p.bounces >= 3) p.life = Math.min(p.life, 0.6);
          p.vel.y = Math.abs(p.vel.y) * 0.45;
          p.vel.x *= 0.6;
          p.vel.z *= 0.6;
          p.bounces++;
        }
      }
      if (p.life <= 0) {
        this.island.scene.remove(p.mesh);
        this.projectiles.splice(i, 1);
      }
    }
  }

  private burst(at: THREE.Vector3, color: string, n = 24): void {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos.set([at.x, at.y + 0.5, at.z], i * 3);
      const a = Math.random() * Math.PI * 2;
      const u = Math.random() * 2 - 1;
      const s = 3 + Math.random() * 4;
      vel.set([Math.cos(a) * Math.sqrt(1 - u * u) * s, Math.abs(u) * s + 2, Math.sin(a) * Math.sqrt(1 - u * u) * s], i * 3);
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const points = new THREE.Points(g, new THREE.PointsMaterial({ color, size: 0.35, transparent: true, depthWrite: false }));
    this.island.scene.add(points);
    this.bursts.push({ points, vel, age: 0 });
  }

  private updateBursts(dt: number): void {
    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i];
      b.age += dt;
      const attr = b.points.geometry.attributes.position as THREE.BufferAttribute;
      for (let k = 0; k < attr.count; k++) {
        b.vel[k * 3 + 1] -= 9 * dt;
        attr.setXYZ(k, attr.getX(k) + b.vel[k * 3] * dt, attr.getY(k) + b.vel[k * 3 + 1] * dt, attr.getZ(k) + b.vel[k * 3 + 2] * dt);
      }
      attr.needsUpdate = true;
      (b.points.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - b.age / 1.1);
      if (b.age > 1.1) {
        this.island.scene.remove(b.points);
        b.points.geometry.dispose();
        this.bursts.splice(i, 1);
      }
    }
  }

  // ── Frame loop ──────────────────────────────────────────────────────

  private resize(): void {
    const w = this.shell.clientWidth;
    const h = this.shell.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  private frame(): void {
    this.timer.update();
    const dt = Math.min(0.05, this.timer.getDelta());
    const t = this.timer.getElapsed();
    const now = this.net.now();

    if (this.playing && this.spawned) this.updatePlayer(dt);
    else this.updateAttract(t);

    for (const r of this.remotes.values()) {
      r.group.position.lerp(r.target, 1 - Math.exp(-10 * dt));
      r.group.rotation.y = r.ry + Math.PI;
    }

    const wall = performance.now();
    for (const [id, v] of this.critters) {
      const p = critterPose(v.info, now);
      v.rig.group.position.set(p.x, p.y, p.z);
      v.rig.group.rotation.y = p.heading;
      animateCritter(v.rig, t, v.phase, p.airborne);
      if (wall < v.wobbleUntil) v.rig.body.rotation.z = Math.sin(wall * 0.04) * 0.4;
      if (v.dying) {
        const k = 1 - (wall - v.dying) / 450;
        if (k <= 0) {
          this.island.scene.remove(v.rig.group);
          this.critters.delete(id);
        } else v.rig.group.scale.setScalar(v.size * k);
      }
    }

    if (this.card) {
      const c = this.card.info;
      const p = cardPose(c.seed, c.releasedAt, now);
      this.card.holder.position.set(p.x, p.y, p.z);
      this.card.rig.group.rotation.y = p.heading;
      animateCritter(this.card.rig, t, 0, false);
      this.card.plane.quaternion.copy(this.camera.quaternion);
      this.card.plane.position.y = CARD_SCALE * 1.35 + 1.5 + Math.sin(t * 2) * 0.15;
    }

    for (const b of this.balls.values()) {
      b.children[0].position.y = Math.sin(t * 2 + b.userData.phase) * 0.15;
      b.children[0].rotation.y = t * 2;
    }

    this.updateProjectiles(dt);
    this.updateBursts(dt);
    this.island.update(t);
    this.renderer.render(this.island.scene, this.camera);
  }

  private updateAttract(t: number): void {
    const launched = this.economy?.launched;
    const a = t * 0.04;
    const r = launched ? 135 : 40;
    const cy = launched ? 60 : LOBBY.y + 12;
    this.camera.position.set(Math.cos(a) * r, cy, Math.sin(a) * r);
    this.camera.lookAt(0, launched ? 4 : LOBBY.y - 14, 0);
  }

  private updatePlayer(dt: number): void {
    const look = this.input.consumeLook();
    const sens = this.input.isTouch ? 0.0035 : 0.0022;
    this.yaw -= look.x * sens;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - look.y * sens));

    const mv = this.input.moveVector();
    const speed = mv.run ? RUN_SPEED : WALK_SPEED;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const dx = (-sin * mv.y + cos * mv.x) * speed * dt;
    const dz = (-cos * mv.y - sin * mv.x) * speed * dt;
    const next = resolveMove(this.pos.x, this.pos.z, this.pos.x + dx, this.pos.z + dz, this.mode);
    this.pos.x = next.x;
    this.pos.z = next.z;

    if (this.input.jump && this.onGround) {
      this.velY = JUMP_SPEED;
      this.onGround = false;
      this.sfx.jump();
    }
    this.input.jump = false;
    this.velY += PLAYER_GRAVITY * dt;
    this.pos.y += this.velY * dt;
    const ground = groundHeight(this.pos.x, this.pos.z, this.mode);
    if (this.pos.y <= ground) {
      this.pos.y = ground;
      this.velY = 0;
      this.onGround = true;
    }

    this.camera.position.set(this.pos.x, this.pos.y + EYE_HEIGHT, this.pos.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');

    const now = performance.now();
    if (this.joined && now - this.lastPosSent > 100) {
      this.lastPosSent = now;
      this.net.send({ t: 'pos', x: this.pos.x, y: this.pos.y, z: this.pos.z, ry: this.yaw });
    }

    if (this.mode === 'island' && this.economy?.launched) {
      for (const [id, b] of this.balls) {
        if (Math.hypot(b.position.x - this.pos.x, b.position.z - this.pos.z) > PICKUP_RADIUS) continue;
        if (Math.abs(b.userData.baseY - this.pos.y) > 2.5) continue;
        const sent = this.pickupSent.get(id) ?? 0;
        if (now - sent > 1500) {
          this.pickupSent.set(id, now);
          this.net.send({ t: 'pickup', id });
        }
      }
    }

    const near = this.mode === 'island' && Math.hypot(this.pos.x - BAZAAR.x, this.pos.z - BAZAAR.z) < BAZAAR.r + 1;
    if (near !== this.nearBazaar) {
      this.nearBazaar = near;
      this.hooks.onNearBazaar(near);
    }
  }
}

import * as THREE from 'three';
import { speciesById } from '../../shared/species';
import { hashString } from '../../shared/noise';
import {
  ARENA,
  BALL_GRAVITY,
  BAZAAR,
  CAVE,
  CARD_HIT_RADIUS,
  DEX_MASTER,
  EYE_HEIGHT,
  INTERP_DELAY_MS,
  JUMP_SPEED,
  LOBBY,
  PICKUP_RADIUS,
  PLAYER_GRAVITY,
  RUN_SPEED,
  THROW_SPEED,
  WALK_SPEED,
  WATER_Y,
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
import type { Ball, ChatLine, Economy, EventInfo, PublicCard, ServerMsg, ThrowKind, YouInfo } from '../../shared/protocol';
import type { MyClaim } from '../../shared/prizes';
import { buildIsland, makeNameTag, type Island } from './world3d';
import { animateCritter, buildCritter, type CritterRig } from './critterMesh';
import { BEAM_GEO, BEAM_MAT, GOLD_MAT, makeGoldBall, makePinkOrb, sparkleTexture } from './orbs';
import { CardSlab } from './cardSlab';
import { pct } from '../ui';
import { Hand } from './hand';
import { Input } from './input';
import { Net } from './net';
import { Sfx } from './audio';

/** Places you can press E at. */
export type Spot = 'market' | 'arena' | 'dex';

export interface GameHooks {
  onEconomy(e: Economy): void;
  onCard(card: PublicCard | null): void;
  onYou(you: YouInfo): void;
  onGold(n: number, thisHour: number): void;
  onDex(dex: number[]): void;
  onEvent(e: EventInfo | null): void;
  onToast(text: string, tone: 'info' | 'gold' | 'pink' | 'warn'): void;
  onCardCaught(m: Extract<ServerMsg, { t: 'cardCaught' }>, mine: boolean): void;
  onPrizeWon(claim: MyClaim): void;
  onBanner(text: string): void;
  onChat(line: ChatLine): void;
  onChatReset(lines: ChatLine[]): void;
  onPause(paused: boolean): void;
  onKey(code: string): void;
  onSpot(spot: Spot | null): void;
}

interface Remote {
  group: THREE.Group;
  tag: THREE.Sprite;
  name: string;
  title: string | null;
  target: THREE.Vector3;
  ry: number;
}

interface CritterView {
  info: SpawnInfo;
  rig: CritterRig;
  tag: THREE.Sprite;
  size: number;
  phase: number;
  /** Set while the critter is inside a wobbling orb. */
  caught: Capture | null;
  dying: number;
}

/** A pink orb sitting on the ground with a critter inside: 3 wobbles, then sparkle or burst. */
interface Capture {
  spawnId: string;
  orb: THREE.Group;
  start: number;
  /** Wall-clock ms when the result arrived; the orb finishes its wobbles first. */
  result: { ok: boolean; at: number } | null;
}

interface Projectile {
  mesh: THREE.Object3D;
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
  life: number;
}

const MAX_BALLS = 320;
const WOBBLE_MS = 2600;
const BALL_SIZE = 0.36;
const ORB_SIZE = 0.2;
const TAG_RANGE = 38;

export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1200);
  readonly net = new Net();
  readonly sfx = new Sfx();
  readonly input: Input;
  readonly island: Island;
  private hand = new Hand();
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
  private moving = 0;

  slot: 1 | 2 = 1;
  gold = 0;
  you: YouInfo | null = null;
  economy: Economy | null = null;
  event: EventInfo | null = null;

  private remotes = new Map<string, Remote>();
  private balls = new Map<string, Ball & { phase: number }>();
  private ballMesh: THREE.InstancedMesh;
  private beamMesh: THREE.InstancedMesh;
  private critters = new Map<string, CritterView>();
  private captures = new Map<string, Capture>();
  private card: CardSlab | null = null;
  private projectiles: Projectile[] = [];
  private bursts: Burst[] = [];
  private lastPosSent = 0;
  private lastThrow = 0;
  private pickupSent = new Map<string, number>();
  private spot: Spot | null = null;
  private textureLoader = new THREE.TextureLoader();
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v3 = new THREE.Vector3();
  private s3 = new THREE.Vector3();

  constructor(
    private shell: HTMLElement,
    canvas: HTMLCanvasElement,
    private hooks: GameHooks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.autoClear = false;
    this.island = buildIsland();
    this.island.scene.add(this.camera);

    const ballGeo = new THREE.IcosahedronGeometry(BALL_SIZE, 2);
    this.ballMesh = new THREE.InstancedMesh(ballGeo, GOLD_MAT, MAX_BALLS);
    this.beamMesh = new THREE.InstancedMesh(BEAM_GEO, BEAM_MAT, MAX_BALLS);
    for (const m of [this.ballMesh, this.beamMesh]) {
      m.count = 0;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.island.scene.add(m);
    }

    this.input = new Input(canvas);
    this.input.onThrow = (k) => this.throwBall(k === 'gold' || this.slot === 2 ? 'gold' : 'orb');
    this.input.onWheel = () => this.setSlot(this.slot === 1 ? 2 : 1);
    this.input.onKey = (code) => {
      if (code === 'Digit1') this.setSlot(1);
      else if (code === 'Digit2') this.setSlot(2);
      else if (code === 'KeyF') this.throwBall('gold');
      else if (code === 'KeyE') {
        if (this.spot) hooks.onKey(`spot:${this.spot}`);
      } else hooks.onKey(code);
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

  /** Back to the landing page: the camera orbits again, you stay connected. */
  leave(): void {
    this.playing = false;
    this.input.active = false;
    this.input.keys.clear();
    this.shell.classList.remove('playing');
    if (document.pointerLockElement) document.exitPointerLock();
  }

  resume(): void {
    this.input.lock();
  }

  setSlot(s: 1 | 2): void {
    this.slot = s;
    this.hand.setSlot(s);
    this.shell.querySelectorAll('.slot').forEach((el) => el.classList.toggle('active', (el as HTMLElement).dataset.slot === String(s)));
  }

  sendChat(text: string): void {
    this.net.send({ t: 'chat', text });
  }

  get currentCard(): PublicCard | null {
    return this.card?.info ?? null;
  }

  // Minimap feeds.
  mapMe() {
    return this.spawned && this.mode === 'island' ? { x: this.pos.x, z: this.pos.z, yaw: this.yaw } : null;
  }
  mapBalls(): Iterable<{ x: number; z: number }> {
    return this.balls.values();
  }
  mapOthers(): { x: number; z: number }[] {
    return [...this.remotes.values()].map((r) => ({ x: r.target.x, z: r.target.z }));
  }
  mapCard(): { x: number; z: number } | null {
    return this.card?.group.visible ? { x: this.card.center.x, z: this.card.center.z } : null;
  }

  // ── Network ─────────────────────────────────────────────────────────

  private onMessage(m: ServerMsg): void {
    switch (m.t) {
      case 'init':
        for (const id of [...this.critters.keys()]) this.removeCritter(id, false);
        this.balls.clear();
        m.critters.forEach((s) => this.addCritter(s));
        m.balls.forEach((b) => this.addBall(b));
        this.setCard(m.card);
        this.setEconomy(m.economy);
        this.event = m.event;
        this.hooks.onEvent(m.event);
        this.hooks.onChatReset(m.chat);
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
          this.pitch = 0;
          this.spawned = true;
        }
        this.syncLobby();
        this.hooks.onYou(m.you);
        this.hooks.onGold(this.gold, m.you.goldThisHour);
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
            r = this.makeRemote(p.id, p.name, p.title);
            r.group.position.set(p.x, p.y, p.z);
            this.remotes.set(p.id, r);
          } else if (r.name !== p.name || r.title !== p.title) this.retag(p.id, r, p.name, p.title);
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
          if (b) this.burst(new THREE.Vector3(b.x, b.y, b.z), '#ffd23f');
        }
        this.balls.delete(m.id);
        this.pickupSent.delete(m.id);
        break;
      case 'critter+':
        m.spawns.forEach((s) => this.addCritter(s));
        break;
      case 'critter-':
        this.removeCritter(m.id, true);
        break;
      case 'catchStart':
        this.startCapture(m.spawnId, m.at);
        break;
      case 'catch':
        this.onCatch(m);
        break;
      case 'card':
        this.setCard(m.card);
        break;
      case 'cardPos':
        if (this.card?.info.id === m.id) {
          this.card.push({ at: m.at, x: m.x, y: m.y, z: m.z, jump: m.jump });
          this.card.fleeing = m.fleeing;
        }
        break;
      case 'cardHit':
        if (this.card && this.card.info.id === m.cardId) {
          const info = this.card.info;
          info.throws = m.index + 1;
          info.nextOdds = Math.min(info.odds.cap, m.odds + info.odds.step);
          this.hooks.onCard(info);
          this.burst(this.card.center, '#ffd23f');
        }
        if (m.byId === this.you?.id && !m.won) {
          this.sfx.cardHit();
          this.hooks.onToast(`🎯 Hit #${m.index + 1} at ${pct(m.odds)}. Not this time, odds go up!`, 'gold');
        }
        break;
      case 'cardCaught': {
        const mine = m.byId === this.you?.id;
        if (this.card) this.sparkle(this.card.center);
        if (mine) this.sfx.fanfare();
        this.hooks.onCardCaught(m, mine);
        break;
      }
      case 'economy':
        this.setEconomy(m.e);
        break;
      case 'bag':
        this.gold = m.gold;
        this.hooks.onGold(m.gold, m.goldThisHour);
        break;
      case 'prizeWon':
        this.hooks.onPrizeWon(m.claim);
        break;
      case 'banner':
        this.hooks.onBanner(m.text);
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
      case 'chat':
        this.hooks.onChat(m.line);
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
    this.syncLobby();
    this.hooks.onEconomy(e);
  }

  /** The glass lobby is the pre-launch waiting room; after launch it only shows for anyone still up there. */
  private syncLobby(): void {
    this.island.lobby.visible = !this.economy?.launched || (this.spawned && this.mode === 'lobby');
  }

  // ── Catching ────────────────────────────────────────────────────────

  private startCapture(spawnId: string, at: Vec3): void {
    const v = this.critters.get(spawnId);
    const orb = makePinkOrb(true);
    orb.scale.setScalar(ORB_SIZE * 1.4);
    const ground = Math.max(terrainHeight(at.x, at.z), WATER_Y);
    orb.position.set(at.x, ground + ORB_SIZE * 1.4, at.z);
    this.island.scene.add(orb);
    const cap: Capture = { spawnId, orb, start: performance.now(), result: null };
    this.captures.set(spawnId, cap);
    if (v) v.caught = cap;
    this.burst(orb.position, '#ff5ea8', 18);
  }

  private onCatch(m: Extract<ServerMsg, { t: 'catch' }>): void {
    const mine = m.byId === this.you?.id;
    const sp = speciesById(m.species);
    const cap = this.captures.get(m.spawnId);
    const announce = () => {
      if (!mine) return;
      if (m.ok) {
        this.sfx.caught();
        this.hooks.onToast(m.isNew ? `📖 New! You caught ${sp.name}.` : `You caught another ${sp.name}.`, 'pink');
      } else {
        this.sfx.escaped();
        this.hooks.onToast(`${sp.name} broke free!`, 'info');
      }
    };
    if (cap) {
      cap.result = { ok: m.ok, at: performance.now() };
      // Let the third wobble finish before revealing the result.
      setTimeout(announce, Math.max(0, cap.start + WOBBLE_MS - performance.now()));
    } else announce();
  }

  private updateCaptures(now: number): void {
    for (const [id, cap] of this.captures) {
      const t = now - cap.start;
      const v = this.critters.get(id);
      // Critter shrinks into the orb over the first 300ms.
      if (v) {
        const k = Math.max(0, 1 - t / 300);
        if (!cap.result || t < WOBBLE_MS) v.rig.group.scale.setScalar(v.size * k);
        v.tag.visible = false;
      }
      // Three wobbles, each a short damped rock with a pause between.
      const w = (t - 400) / 700;
      const inWobble = w >= 0 && w < 3 && w % 1 < 0.6;
      cap.orb.rotation.z = inWobble ? Math.sin(((w % 1) / 0.6) * Math.PI * 2) * 0.45 : 0;
      cap.orb.position.y += 0;
      if (cap.result && t >= WOBBLE_MS) {
        if (cap.result.ok) this.sparkle(cap.orb.position);
        else {
          this.burst(cap.orb.position, '#ff5ea8', 26);
          if (v) {
            v.caught = null;
            v.rig.group.scale.setScalar(v.size);
          }
        }
        this.island.scene.remove(cap.orb);
        this.captures.delete(id);
      } else if (!cap.result && t > WOBBLE_MS + 5000) {
        // Result never came (reconnect); give the critter back.
        this.island.scene.remove(cap.orb);
        this.captures.delete(id);
        if (v) {
          v.caught = null;
          v.rig.group.scale.setScalar(v.size);
        }
      }
    }
  }

  // ── Scene objects ───────────────────────────────────────────────────

  private remoteColor(id: string): THREE.Color {
    return new THREE.Color().setHSL((hashString(id) % 360) / 360, 0.75, 0.6);
  }

  private makeRemote(id: string, name: string, title: string | null): Remote {
    const g = new THREE.Group();
    const color = this.remoteColor(id);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.8, 3, 8), new THREE.MeshLambertMaterial({ color, flatShading: true }));
    body.position.y = 0.85;
    const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.36, 1), new THREE.MeshLambertMaterial({ color: '#ffe3c4', flatShading: true }));
    head.position.y = 1.65;
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.38, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: '#ff5ea8' }));
    cap.position.y = 1.72;
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.05, 0.3), new THREE.MeshLambertMaterial({ color: '#ff5ea8' }));
    visor.position.set(0, 1.74, 0.36);
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 4), new THREE.MeshBasicMaterial({ color: '#2a2140' }));
      eye.position.set(side * 0.13, 1.65, 0.32);
      g.add(eye);
    }
    const tag = makeNameTag(name, { title, dot: `#${color.getHexString()}` });
    tag.position.y = 2.55;
    g.add(body, head, cap, visor, tag);
    this.island.scene.add(g);
    return { group: g, tag, name, title, target: new THREE.Vector3(), ry: 0 };
  }

  private retag(id: string, r: Remote, name: string, title: string | null): void {
    r.group.remove(r.tag);
    (r.tag.material as THREE.SpriteMaterial).map?.dispose();
    r.tag = makeNameTag(name, { title, dot: `#${this.remoteColor(id).getHexString()}` });
    r.tag.position.y = 2.55;
    r.group.add(r.tag);
    r.name = name;
    r.title = title;
  }

  private addBall(b: Ball): void {
    if (this.balls.has(b.id) || this.balls.size >= MAX_BALLS) return;
    this.balls.set(b.id, { ...b, phase: Math.random() * 6 });
  }

  private addCritter(s: SpawnInfo): void {
    if (this.critters.has(s.id)) return;
    const sp = speciesById(s.species);
    const rig = buildCritter(sp);
    const tag = makeNameTag(sp.name, { dot: sp.color, scale: 0.0075 });
    tag.position.y = 1.5;
    tag.visible = false;
    // Tag lives on the group so it rides along, but is counter-scaled so every critter's tag is the same size.
    tag.scale.multiplyScalar(1 / sp.size);
    rig.group.add(tag);
    this.island.scene.add(rig.group);
    this.critters.set(s.id, { info: s, rig, tag, size: sp.size, phase: Math.random() * 6, caught: null, dying: 0 });
  }

  private removeCritter(id: string, animate: boolean): void {
    const v = this.critters.get(id);
    if (!v) return;
    if (animate && !v.caught) {
      v.dying = performance.now();
      return;
    }
    this.island.scene.remove(v.rig.group);
    this.critters.delete(id);
  }

  private setCard(info: PublicCard | null): void {
    if (this.card && (!info || info.id !== this.card.info.id)) {
      this.island.scene.remove(this.card.group);
      this.card = null;
    }
    if (info && !this.card) {
      this.card = new CardSlab(info, this.textureLoader);
      this.island.scene.add(this.card.group);
    } else if (info && this.card) this.card.setInfo(info);
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
      this.hooks.onGold(this.gold, -1);
    }
    this.lastThrow = now;
    if (kind === 'gold' && this.slot !== 2) this.setSlot(2);
    this.hand.throw();
    const d = new THREE.Vector3();
    this.camera.getWorldDirection(d);
    d.y += 0.1;
    d.normalize();
    // Leaves from the hand's side of the screen.
    const right = new THREE.Vector3().crossVectors(d, this.camera.up).normalize();
    const o = this.camera.getWorldPosition(new THREE.Vector3()).addScaledVector(d, 0.5).addScaledVector(right, 0.25);
    o.y -= 0.2;
    const ov = { x: o.x, y: o.y, z: o.z };
    const dv = { x: d.x, y: d.y, z: d.z };
    this.net.send({ t: 'throw', kind, o: ov, d: dv, at: this.net.now() });
    this.spawnProjectile(kind, ov, dv);
    this.sfx.throw(kind === 'gold');
  }

  /** Visual projectile; predicts where it stops if it will hit a creature. */
  private spawnProjectile(kind: ThrowKind, o: Vec3, d: Vec3): void {
    const mesh = kind === 'gold' ? makeGoldBall() : makePinkOrb();
    mesh.scale.setScalar(ORB_SIZE);
    mesh.position.set(o.x, o.y, o.z);
    this.island.scene.add(mesh);
    const at = this.net.now();
    // Golden balls are checked against the drawn card every frame (it flees, so no prediction).
    let stopAt: number | null = null;
    if (kind === 'orb' && this.economy?.launched) {
      for (const v of this.critters.values()) {
        if (v.caught) continue;
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
      const hitCard = p.kind === 'gold' && this.card?.group.visible && p.mesh.position.distanceTo(this.card.center) < CARD_HIT_RADIUS;
      if (hitCard || (p.stopAt !== null && p.age >= p.stopAt)) {
        this.burst(p.mesh.position, p.kind === 'gold' ? '#ffd23f' : '#ff7ab6', 14);
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
        } else if (y < g + ORB_SIZE) {
          p.mesh.position.y = g + ORB_SIZE;
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

  private burst(at: THREE.Vector3, color: string, n = 24, opts: { size?: number; star?: boolean; life?: number } = {}): void {
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
    const material = new THREE.PointsMaterial({
      color,
      size: opts.size ?? 0.5,
      transparent: true,
      depthWrite: false,
      map: sparkleTexture(),
      blending: opts.star ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const points = new THREE.Points(g, material);
    this.island.scene.add(points);
    this.bursts.push({ points, vel, age: 0, life: opts.life ?? 1.1 });
  }

  /** Successful catch: a two-colour star shower. */
  private sparkle(at: THREE.Vector3): void {
    this.burst(at, '#ffd23f', 30, { size: 0.9, star: true, life: 1.4 });
    this.burst(at, '#ff5ea8', 22, { size: 0.7, star: true, life: 1.2 });
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
      (b.points.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - b.age / b.life);
      if (b.age > b.life) {
        this.island.scene.remove(b.points);
        b.points.geometry.dispose();
        (b.points.material as THREE.Material).dispose();
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
    this.hand.resize(this.camera.aspect);
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
    const eye = this.camera.position;
    for (const [id, v] of this.critters) {
      const p = critterPose(v.info, now);
      if (!v.caught) {
        v.rig.group.position.set(p.x, p.y, p.z);
        v.rig.group.rotation.y = p.heading;
        animateCritter(v.rig, t, v.phase, p.airborne);
        const dist = Math.hypot(p.x - eye.x, p.z - eye.z);
        v.tag.visible = this.playing && dist > 4 && dist < TAG_RANGE;
      }
      if (v.dying) {
        const k = 1 - (wall - v.dying) / 450;
        if (k <= 0) {
          this.island.scene.remove(v.rig.group);
          this.critters.delete(id);
        } else v.rig.group.scale.setScalar(v.size * k);
      }
    }
    this.updateCaptures(wall);

    if (this.card) {
      const from = this.card.update(now - INTERP_DELAY_MS, t, this.camera);
      if (from) {
        this.burst(from, '#ffd23f', 30, { star: true, size: 0.8 });
        this.burst(this.card.center, '#ffd23f', 30, { star: true, size: 0.8 });
      }
    }

    this.updateBalls(t);
    this.updateProjectiles(dt);
    this.updateBursts(dt);
    this.island.update(t);
    BEAM_MAT.uniforms.time.value = t;

    this.renderer.clear();
    this.renderer.render(this.island.scene, this.camera);
    if (this.playing) {
      this.hand.update(dt, this.moving, t);
      this.hand.render(this.renderer);
    }
  }

  private updateBalls(t: number): void {
    const launched = !!this.economy?.launched;
    let i = 0;
    if (launched) {
      for (const b of this.balls.values()) {
        const bob = Math.sin(t * 2 + b.phase) * 0.15;
        this.q.setFromAxisAngle(this.v3.set(0, 1, 0), t * 2 + b.phase);
        this.m4.compose(this.v3.set(b.x, b.y + bob, b.z), this.q, this.s3.set(1, 1, 1));
        this.ballMesh.setMatrixAt(i, this.m4);
        this.m4.compose(this.v3.set(b.x, b.y - 0.3, b.z), this.q.identity(), this.s3.set(1, 1, 1));
        this.beamMesh.setMatrixAt(i, this.m4);
        i++;
      }
    }
    this.ballMesh.count = i;
    this.beamMesh.count = i;
    this.ballMesh.instanceMatrix.needsUpdate = true;
    this.beamMesh.instanceMatrix.needsUpdate = true;
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
    // Right stick turns at up to ~150°/s.
    look.x += this.input.lookJoy.x * dt * 1200;
    look.y += this.input.lookJoy.y * dt * 700;
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
    this.moving = this.onGround ? Math.min(1, Math.hypot(mv.x, mv.y)) * (mv.run ? 1.3 : 1) : 0;

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
        if (Math.hypot(b.x - this.pos.x, b.z - this.pos.z) > PICKUP_RADIUS) continue;
        if (Math.abs(b.y - this.pos.y) > 2.5) continue;
        const sent = this.pickupSent.get(id) ?? 0;
        if (now - sent > 1500) {
          this.pickupSent.set(id, now);
          this.net.send({ t: 'pickup', id });
        }
      }
    }

    const near = (p: { x: number; z: number }, r: number) => Math.hypot(this.pos.x - p.x, this.pos.z - p.z) < r;
    const spot: Spot | null =
      this.mode !== 'island' ? null : near(BAZAAR, BAZAAR.r + 1) ? 'market' : near(ARENA, ARENA.r) ? 'arena' : near(DEX_MASTER, DEX_MASTER.r + 3) ? 'dex' : null;
    if (spot !== this.spot) {
      this.spot = spot;
      this.hooks.onSpot(spot);
    }
  }
}

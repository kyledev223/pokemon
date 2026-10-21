import * as THREE from 'three';
import { makeGoldBall, makePinkOrb, outline } from './orbs';

// First-person cartoon glove holding the selected orb, bottom-right of the screen.
// Rendered in its own scene after the world (depth cleared) so it never clips into terrain.

const GLOVE = new THREE.MeshToonMaterial({ color: '#ffffff' });
const CUFF = new THREE.MeshToonMaterial({ color: '#ff5ea8' });

function part(geo: THREE.BufferGeometry, mat: THREE.Material, thickness = 0.08): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  outline(m, thickness);
  return m;
}

export class Hand {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.01, 10);
  private rig = new THREE.Group();
  private holder = new THREE.Group();
  private orbs: Record<1 | 2, THREE.Group>;
  private slot: 1 | 2 = 1;
  private throwT = 1;
  private swapT = 1;
  private bob = 0;
  visible = true;

  constructor() {
    this.scene.add(new THREE.HemisphereLight('#ffffff', '#ffd9b0', 2.2));
    const sun = new THREE.DirectionalLight('#fff4e0', 2);
    sun.position.set(-1, 2, 2);
    this.scene.add(sun);

    // Palm, four curled fingers wrapping the orb from below, a thumb across the side and a pink cuff.
    const palm = part(new THREE.SphereGeometry(0.2, 14, 10), GLOVE);
    palm.scale.set(1, 0.72, 1.1);
    palm.position.set(0.02, -0.17, 0.04);
    this.rig.add(palm);
    for (let i = 0; i < 4; i++) {
      const finger = part(new THREE.CapsuleGeometry(0.052, 0.13, 4, 8), GLOVE, 0.12);
      finger.position.set(-0.11 + i * 0.075, -0.05 + Math.abs(i - 1.5) * -0.02, -0.12);
      finger.rotation.set(1.1, 0, (i - 1.5) * 0.12);
      this.rig.add(finger);
    }
    const thumb = part(new THREE.CapsuleGeometry(0.058, 0.12, 4, 8), GLOVE, 0.12);
    thumb.position.set(-0.17, -0.06, 0.06);
    thumb.rotation.set(0.4, 0, 0.9);
    this.rig.add(thumb);
    const cuff = part(new THREE.CylinderGeometry(0.17, 0.19, 0.12, 14), CUFF, 0.06);
    cuff.position.set(0.04, -0.32, 0.12);
    cuff.rotation.x = 0.5;
    const wrist = part(new THREE.CylinderGeometry(0.13, 0.16, 0.5, 12), GLOVE, 0.06);
    wrist.position.set(0.06, -0.55, 0.26);
    wrist.rotation.x = 0.5;
    this.rig.add(cuff, wrist);

    this.orbs = { 1: makePinkOrb(true), 2: makeGoldBall(true) };
    for (const o of Object.values(this.orbs)) {
      o.scale.setScalar(0.13);
      this.holder.add(o);
    }
    this.holder.position.set(-0.02, -0.02, -0.04);
    this.rig.add(this.holder);
    this.rig.rotation.set(0.25, -0.35, 0.12);
    this.scene.add(this.rig);
    this.setSlot(1, true);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    // Bottom-right on wide screens; on phones it sits low between the two sticks.
    const narrow = aspect < 1;
    this.base.set(narrow ? 0.1 : 0.5 * Math.min(1.25, aspect / 1.6), narrow ? -0.46 : -0.4, -1.05);
    this.rig.scale.setScalar(narrow ? 0.45 : 0.6);
  }
  private base = new THREE.Vector3(0.5, -0.4, -1.05);

  setSlot(s: 1 | 2, instant = false): void {
    if (s === this.slot && !instant) return;
    this.slot = s;
    this.swapT = instant ? 1 : 0;
    if (instant) this.applySlot();
  }

  private applySlot(): void {
    this.orbs[1].visible = this.slot === 1;
    this.orbs[2].visible = this.slot === 2;
  }

  /** Plays the throw: the orb leaves the hand and a fresh one pops back in. */
  throw(): void {
    this.throwT = 0;
  }

  update(dt: number, moving: number, t: number): void {
    this.bob += dt * (4 + moving * 6);
    const sway = moving * 0.025;
    const pos = this.base.clone();
    pos.x += Math.cos(this.bob) * sway;
    pos.y += Math.abs(Math.sin(this.bob)) * sway + Math.sin(t * 1.6) * 0.008;

    // Swap: dip down, change orb, come back up.
    if (this.swapT < 1) {
      this.swapT = Math.min(1, this.swapT + dt * 4);
      if (this.swapT >= 0.5) this.applySlot();
      pos.y -= Math.sin(this.swapT * Math.PI) * 0.35;
    }
    // Throw: flick forward, orb hidden until it regrows.
    let orbScale = 0.13;
    if (this.throwT < 1) {
      this.throwT = Math.min(1, this.throwT + dt * 3.2);
      const k = this.throwT;
      const flick = k < 0.25 ? k / 0.25 : 1 - (k - 0.25) / 0.75;
      pos.z -= flick * 0.25;
      pos.y += flick * 0.12;
      this.rig.rotation.x = 0.25 - flick * 0.9;
      orbScale = k < 0.15 ? 0.13 : k < 0.55 ? 0 : 0.13 * THREE.MathUtils.smoothstep(k, 0.55, 0.9);
    } else this.rig.rotation.x = 0.25;
    this.holder.scale.setScalar(orbScale / 0.13);
    this.holder.rotation.y = t * 0.6;
    this.rig.position.copy(pos);
  }

  render(renderer: THREE.WebGLRenderer): void {
    if (!this.visible) return;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }
}

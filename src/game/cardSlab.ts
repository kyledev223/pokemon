import * as THREE from 'three';
import type { PublicCard } from '../../shared/protocol';
import { BEAM_GEO, BEAM_MAT, INK, outline } from './orbs';
import { makeNameTag } from './world3d';

// The real card loose on the island: a glowing gold-framed slab showing the operator's photo
// of the card. Its position comes from the server (~10 Hz) and is interpolated here.

const TIER_GLOW = { S: '#ffc928', A: '#ff5ea8', B: '#3fa7ff' } as const;
const W = 1.5;
const H = 2.1;

interface Sample {
  at: number;
  x: number;
  y: number;
  z: number;
  jump: boolean;
}

let backTex: THREE.Texture | null = null;
/** Card back: ink with a gold four-point star, same on every slab. */
function cardBack(): THREE.Texture {
  if (backTex) return backTex;
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 358;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = INK;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#ffc928';
  ctx.lineWidth = 10;
  ctx.strokeRect(14, 14, c.width - 28, c.height - 28);
  ctx.translate(c.width / 2, c.height / 2);
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 ? 22 : 74;
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fillStyle = '#ffc928';
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = '700 26px Fredoka, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('REAL CARD', 0, 130);
  backTex = new THREE.CanvasTexture(c);
  backTex.colorSpace = THREE.SRGBColorSpace;
  return backTex;
}

let haloTex: THREE.Texture | null = null;
function halo(): THREE.Texture {
  if (haloTex) return haloTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 8, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  haloTex = new THREE.CanvasTexture(c);
  return haloTex;
}

export class CardSlab {
  readonly group = new THREE.Group();
  private slab = new THREE.Group();
  private samples: Sample[] = [];
  private photo: THREE.MeshBasicMaterial;
  private tag: THREE.Sprite;
  private light: THREE.PointLight;
  private lastImage = '';
  fleeing = false;

  constructor(
    public info: PublicCard,
    private loader: THREE.TextureLoader,
  ) {
    const glow = TIER_GLOW[info.tier];
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(W, H, 0.14),
      new THREE.MeshStandardMaterial({ color: '#ffc928', emissive: '#ffb300', emissiveIntensity: 0.45, metalness: 0.5, roughness: 0.3 }),
    );
    outline(frame, 0.05);
    this.photo = new THREE.MeshBasicMaterial({ color: '#ffffff' });
    const front = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.2, H - 0.2), this.photo);
    front.position.z = 0.075;
    const back = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.2, H - 0.2), new THREE.MeshBasicMaterial({ map: cardBack() }));
    back.position.z = -0.075;
    back.rotation.y = Math.PI;
    this.slab.add(frame, front, back);

    const haloSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: halo(), color: glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    haloSprite.scale.set(4.2, 4.6, 1);
    this.slab.add(haloSprite);

    const beam = new THREE.Mesh(BEAM_GEO, BEAM_MAT);
    beam.scale.set(1.6, 2.2, 1.6);
    beam.position.y = -1.8;
    this.light = new THREE.PointLight(glow, 16, 14, 1.5);
    this.tag = this.makeTag();
    this.group.add(this.slab, beam, this.light, this.tag);
    this.setInfo(info);
  }

  private makeTag(): THREE.Sprite {
    const tag = makeNameTag(this.info.name, { title: `Tier ${this.info.tier} · real card`, dot: TIER_GLOW[this.info.tier], scale: 0.011 });
    tag.position.y = H / 2 + 0.5;
    return tag;
  }

  setInfo(info: PublicCard): void {
    const renamed = info.name !== this.info.name || info.tier !== this.info.tier;
    this.info = info;
    if (renamed) {
      this.group.remove(this.tag);
      this.tag = this.makeTag();
      this.group.add(this.tag);
    }
    if (info.image !== this.lastImage) {
      this.lastImage = info.image;
      this.loader.load(info.image, (tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        this.photo.map?.dispose();
        this.photo.map = tex;
        this.photo.needsUpdate = true;
      });
    }
  }

  push(s: Sample): void {
    this.samples.push(s);
    if (this.samples.length > 40) this.samples.shift();
  }

  /** Interpolated position at server time `t`; null until the first sample arrives. */
  private posAt(t: number): THREE.Vector3 | null {
    const h = this.samples;
    if (!h.length) return null;
    if (t <= h[0].at) return new THREE.Vector3(h[0].x, h[0].y, h[0].z);
    for (let i = h.length - 1; i > 0; i--) {
      const a = h[i - 1];
      const b = h[i];
      if (t >= a.at) {
        if (t >= b.at || b.jump) return new THREE.Vector3((t >= b.at ? b : a).x, (t >= b.at ? b : a).y, (t >= b.at ? b : a).z);
        const k = (t - a.at) / (b.at - a.at);
        return new THREE.Vector3(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
      }
    }
    const last = h[h.length - 1];
    return new THREE.Vector3(last.x, last.y, last.z);
  }

  /** Returns the old position when the slab just teleported (for a puff of sparkles there). */
  update(renderAt: number, t: number, camera: THREE.Camera): THREE.Vector3 | null {
    const p = this.posAt(renderAt);
    this.group.visible = !!p;
    if (!p) return null;
    const jumped = this.group.position.distanceTo(p) > 12 && this.group.position.lengthSq() > 0 ? this.group.position.clone() : null;
    this.group.position.copy(p);
    // Always roughly faces the viewer so the photo reads; a lazy sway, or a nervous shake while fleeing.
    const face = Math.atan2(camera.position.x - p.x, camera.position.z - p.z);
    this.slab.rotation.y = face + (this.fleeing ? Math.sin(t * 11) * 0.35 : Math.sin(t * 1.3) * 0.45);
    this.slab.rotation.z = this.fleeing ? Math.sin(t * 13) * 0.12 : 0;
    this.slab.position.y = Math.sin(t * 2) * 0.12;
    this.light.intensity = 14 + Math.sin(t * 3) * 4;
    return jumped;
  }

  get center(): THREE.Vector3 {
    return this.group.position;
  }
}

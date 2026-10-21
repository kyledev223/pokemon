import { ARENA, BAZAAR, CAVE, DEX_MASTER, PLAZA, pathDistance, terrainHeight } from '../../shared/world';

// North-up circular minimap of the whole island. The terrain is rasterised once from the
// shared heightfield; balls, the card, other trainers and you are drawn on top ~10×/s.

const RANGE = 112; // world units from centre to edge
const RES = 150; // terrain raster resolution

export interface MapDot {
  x: number;
  z: number;
}

export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement | null = null;
  private size: number;

  constructor(canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.size = canvas.width;
  }

  private buildBase(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = c.height = RES;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(RES, RES);
    for (let j = 0; j < RES; j++) {
      for (let i = 0; i < RES; i++) {
        const x = ((i + 0.5) / RES - 0.5) * 2 * RANGE;
        const z = ((j + 0.5) / RES - 0.5) * 2 * RANGE;
        const h = terrainHeight(x, z);
        const dc = Math.hypot(x - CAVE.x, z - CAVE.z);
        let col: [number, number, number];
        if (dc < CAVE.r) col = [96, 80, 130];
        else if (dc < CAVE.outer) col = [170, 168, 176];
        else if (h < -1.4) col = [63, 208, 212];
        else if (h < 0) col = [118, 226, 222];
        else if (h < 1) col = [247, 223, 169];
        else if (pathDistance(x, z) < 2.4) col = [232, 201, 154];
        else col = h > 7 ? [98, 184, 92] : [126, 211, 107];
        const k = (j * RES + i) * 4;
        img.data[k] = col[0];
        img.data[k + 1] = col[1];
        img.data[k + 2] = col[2];
        img.data[k + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  private toPx(x: number, z: number): [number, number] {
    return [(x / RANGE / 2 + 0.5) * this.size, (z / RANGE / 2 + 0.5) * this.size];
  }

  draw(me: { x: number; z: number; yaw: number } | null, balls: Iterable<MapDot>, others: Iterable<MapDot>, card: MapDot | null): void {
    if (!this.base) this.base = this.buildBase();
    const { ctx, size } = this;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.base, 0, 0, size, size);

    const s = size / 136; // scale marks with the canvas resolution
    const landmark = (x: number, z: number, color: string) => {
      const [px, py] = this.toPx(x, z);
      ctx.fillStyle = color;
      ctx.strokeStyle = '#2a2140';
      ctx.lineWidth = 1.5 * s;
      ctx.beginPath();
      ctx.roundRect(px - 3.5 * s, py - 3.5 * s, 7 * s, 7 * s, 2 * s);
      ctx.fill();
      ctx.stroke();
    };
    landmark(PLAZA.x, PLAZA.z, '#ff5ea8');
    landmark(ARENA.x, ARENA.z, '#3fa7ff');
    landmark(BAZAAR.x, BAZAAR.z, '#4cc38a');
    landmark(DEX_MASTER.x, DEX_MASTER.z, '#8b6cf0');
    landmark(CAVE.x, CAVE.z, '#ff8a3d');

    ctx.fillStyle = '#ffd23f';
    ctx.strokeStyle = '#2a2140';
    ctx.lineWidth = 1 * s;
    for (const b of balls) {
      const [px, py] = this.toPx(b.x, b.z);
      ctx.beginPath();
      ctx.arc(px, py, 2.4 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.fillStyle = '#ffffff';
    for (const o of others) {
      const [px, py] = this.toPx(o.x, o.z);
      ctx.beginPath();
      ctx.arc(px, py, 2.2 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (card) {
      const [px, py] = this.toPx(card.x, card.z);
      star(ctx, px, py, 6 * s, '#ffc928', s);
    }
    if (me) {
      const [px, py] = this.toPx(me.x, me.z);
      ctx.save();
      ctx.translate(px, py);
      // yaw 0 faces -z (north/up); positive yaw turns left.
      ctx.rotate(-me.yaw);
      ctx.beginPath();
      ctx.moveTo(0, -7 * s);
      ctx.lineTo(5 * s, 5 * s);
      ctx.lineTo(0, 2.5 * s);
      ctx.lineTo(-5 * s, 5 * s);
      ctx.closePath();
      ctx.fillStyle = '#ff5ea8';
      ctx.lineWidth = 1.8 * s;
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, s: number): void {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 ? r * 0.38 : r;
    ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.lineWidth = 1.5 * s;
  ctx.fill();
  ctx.stroke();
}

/** Keyboard + mouse (pointer lock) + touch joystick input. Uses KeyboardEvent.code so ZQSD on AZERTY maps to WASD automatically. */
export class Input {
  readonly keys = new Set<string>();
  lookX = 0;
  lookY = 0;
  joy = { x: 0, y: 0 };
  jump = false;
  readonly isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  active = false;

  onThrow: (kind: 'primary' | 'gold') => void = () => {};
  onKey: (code: string) => void = () => {};
  onWheel: (dir: number) => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (!this.active || isTyping(e.target)) return;
      if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
      if (!e.repeat) this.onKey(e.code);
      this.keys.add(e.code);
      if (e.code === 'Space') this.jump = true;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.lookX += e.movementX;
      this.lookY += e.movementY;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) this.onThrow('primary');
      if (e.button === 2) this.onThrow('gold');
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.locked) return;
        e.preventDefault();
        this.onWheel(Math.sign(e.deltaY));
      },
      { passive: false },
    );
  }

  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  lock(): void {
    if (this.isTouch) return;
    const p = this.canvas.requestPointerLock?.() as unknown as Promise<void> | undefined;
    p?.catch?.(() => {});
  }

  /** Wires the on-screen joystick, look pad and buttons. */
  bindTouch(els: { stickZone: HTMLElement; stick: HTMLElement; look: HTMLElement; pink: HTMLElement; gold: HTMLElement; jump: HTMLElement }): void {
    const knob = els.stick.querySelector('i') as HTMLElement;
    let stickId: number | null = null;
    let origin = { x: 0, y: 0 };
    const R = 46;
    els.stickZone.addEventListener('pointerdown', (e) => {
      stickId = e.pointerId;
      els.stickZone.setPointerCapture(e.pointerId);
      const rect = els.stick.getBoundingClientRect();
      origin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      move(e);
    });
    const move = (e: PointerEvent) => {
      if (e.pointerId !== stickId) return;
      let dx = e.clientX - origin.x;
      let dy = e.clientY - origin.y;
      const d = Math.hypot(dx, dy);
      if (d > R) {
        dx = (dx / d) * R;
        dy = (dy / d) * R;
      }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.joy = { x: dx / R, y: -dy / R };
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== stickId) return;
      stickId = null;
      knob.style.transform = '';
      this.joy = { x: 0, y: 0 };
    };
    els.stickZone.addEventListener('pointermove', move);
    els.stickZone.addEventListener('pointerup', end);
    els.stickZone.addEventListener('pointercancel', end);

    const looks = new Map<number, { x: number; y: number }>();
    els.look.addEventListener('pointerdown', (e) => {
      els.look.setPointerCapture(e.pointerId);
      looks.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    els.look.addEventListener('pointermove', (e) => {
      const last = looks.get(e.pointerId);
      if (!last) return;
      this.lookX += (e.clientX - last.x) * 2.2;
      this.lookY += (e.clientY - last.y) * 2.2;
      looks.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    const lookEnd = (e: PointerEvent) => looks.delete(e.pointerId);
    els.look.addEventListener('pointerup', lookEnd);
    els.look.addEventListener('pointercancel', lookEnd);

    const tap = (el: HTMLElement, fn: () => void) =>
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      });
    tap(els.pink, () => this.onThrow('primary'));
    tap(els.gold, () => this.onThrow('gold'));
    tap(els.jump, () => (this.jump = true));
  }

  /** Movement vector in local space: x = strafe right, y = forward. */
  moveVector(): { x: number; y: number; run: boolean } {
    let x = this.joy.x;
    let y = this.joy.y;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    const run = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || Math.hypot(this.joy.x, this.joy.y) > 0.92;
    return { x, y, run };
  }

  consumeLook(): { x: number; y: number } {
    const out = { x: this.lookX, y: this.lookY };
    this.lookX = 0;
    this.lookY = 0;
    return out;
  }
}

function isTyping(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
}

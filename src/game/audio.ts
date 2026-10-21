import { prefGet, prefSet } from '../api';

/** Tiny synth for UI/game blips. No audio files needed. */
export class Sfx {
  private ctx: AudioContext | null = null;
  enabled = prefGet('cove.sound') !== 'off';

  toggle(): boolean {
    this.enabled = !this.enabled;
    prefSet('cove.sound', this.enabled ? 'on' : 'off');
    return this.enabled;
  }

  /** Must be called from a user gesture once to unlock audio. */
  unlock(): void {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        return;
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.12, slideTo?: number, delay = 0): void {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  throw(gold = false): void {
    this.tone(gold ? 700 : 520, 0.14, 'triangle', 0.08, gold ? 380 : 260);
  }
  pickup(): void {
    [660, 880, 1320].forEach((f, i) => this.tone(f, 0.12, 'sine', 0.1, undefined, i * 0.06));
  }
  caught(): void {
    [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.1, undefined, i * 0.08));
  }
  escaped(): void {
    this.tone(260, 0.22, 'square', 0.05, 150);
  }
  cardHit(): void {
    this.tone(990, 0.3, 'sine', 0.12, 1480);
  }
  fanfare(): void {
    [523, 659, 784, 1046, 784, 1046, 1318].forEach((f, i) => this.tone(f, 0.22, 'triangle', 0.12, undefined, i * 0.11));
  }
  jump(): void {
    this.tone(330, 0.12, 'sine', 0.05, 520);
  }
}

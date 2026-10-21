import type { ChatLine } from '../shared/protocol';
import { $, esc } from './ui';

// Bottom-left chat: bordered bubbles with optional title badges, Enter to type, Enter to send.

const MAX_LINES = 40;

export class Chat {
  private log = $('#chat-log');
  private form = $<HTMLFormElement>('#chat-form');
  readonly input = $<HTMLInputElement>('#chat-input');
  private box = $('#chat');
  myName = '';

  constructor(send: (text: string) => void) {
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = this.input.value.trim();
      if (text) send(text);
      this.input.value = '';
      this.input.blur();
    });
    this.input.addEventListener('focus', () => this.box.classList.add('typing'));
    this.input.addEventListener('blur', () => this.box.classList.remove('typing'));
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // never steer the trainer while typing
      if (e.key === 'Escape') this.input.blur();
    });
  }

  get typing(): boolean {
    return document.activeElement === this.input;
  }

  open(): void {
    this.input.focus();
  }

  reset(lines: ChatLine[]): void {
    this.log.innerHTML = '';
    lines.forEach((l) => this.add(l));
  }

  add(line: ChatLine): void {
    const el = document.createElement('div');
    const mine = !line.system && line.name === this.myName;
    el.className = `bubble${line.system ? ' system' : ''}${mine ? ' mine' : ''}`;
    el.innerHTML = line.system
      ? esc(line.text)
      : `${line.title ? `<span class="tag gold">${esc(line.title)}</span>` : ''}<b>${esc(line.name)}</b>${esc(line.text)}`;
    this.log.append(el);
    while (this.log.children.length > MAX_LINES) this.log.firstElementChild!.remove();
    this.log.scrollTop = this.log.scrollHeight;
  }
}

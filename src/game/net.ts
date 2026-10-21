import type { ClientMsg, ServerMsg } from '../../shared/protocol';
import { token } from '../api';

type Handler = (m: ServerMsg) => void;

/** WebSocket client with auto-reconnect and a server clock estimate. */
export class Net {
  private ws: WebSocket | null = null;
  private handlers: Handler[] = [];
  private offset = 0;
  private name: string | null = null;
  private pingTimer = 0;
  connected = false;

  on(h: Handler): void {
    this.handlers.push(h);
  }

  /** Server time in ms (used to evaluate deterministic creature paths). */
  now(): number {
    return Date.now() + this.offset;
  }

  connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      if (this.name) this.send({ t: 'hello', token: token(), name: this.name });
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping', c: Date.now() }), 10_000);
      this.send({ t: 'ping', c: Date.now() });
    };
    ws.onmessage = (ev) => {
      let m: ServerMsg;
      try {
        m = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (m.t === 'init') this.offset = m.now - Date.now();
      if (m.t === 'pong') this.offset = m.now + (Date.now() - m.c) / 2 - Date.now();
      for (const h of this.handlers) h(m);
    };
    ws.onclose = (ev) => {
      this.connected = false;
      clearInterval(this.pingTimer);
      if (ev.code === 4000) return; // replaced by another tab
      setTimeout(() => this.connect(), 2000);
    };
  }

  join(name: string): void {
    this.name = name;
    this.send({ t: 'hello', token: token(), name });
  }

  send(m: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
export const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export const usd = (n: number) => `$${n.toFixed(2)}`;
export const pct = (p: number) => `${(p * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`;

export function mmss(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function countdown(ms: number): string {
  if (ms <= 0) return 'Now';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

export function shortSig(sig: string): string {
  return sig.length > 14 ? `${sig.slice(0, 6)}…${sig.slice(-6)}` : sig;
}

let explorerSuffix = '';
export const setExplorerSuffix = (s: string) => (explorerSuffix = s);

export function txLink(sig: string | null | undefined, label = 'Solscan ↗'): string {
  if (!sig) return '';
  if (sig.startsWith('mock')) return `<span class="muted" title="${esc(sig)}">mock tx</span>`;
  return `<a href="https://solscan.io/tx/${esc(sig)}${explorerSuffix}" target="_blank" rel="noopener">${esc(label)}</a>`;
}

export function accountLink(addr: string): string {
  return `https://solscan.io/account/${addr}${explorerSuffix}`;
}

// ── Modal ───────────────────────────────────────────────────────────

type CloseFn = () => void;
let onCloseCb: CloseFn | null = null;

export function openModal(html: string, onClose?: CloseFn, opts: { wide?: boolean } = {}): HTMLElement {
  const dlg = $<HTMLDialogElement>('#modal');
  const body = $('#modal-body');
  dlg.classList.toggle('wide', !!opts.wide);
  body.innerHTML = html;
  onCloseCb = onClose ?? null;
  if (document.pointerLockElement) document.exitPointerLock();
  if (!dlg.open) dlg.showModal();
  return body;
}

export function closeModal(): void {
  const dlg = $<HTMLDialogElement>('#modal');
  if (dlg.open) dlg.close();
}

export function modalOpen(): boolean {
  return $<HTMLDialogElement>('#modal').open;
}

export function initModal(): void {
  const dlg = $<HTMLDialogElement>('#modal');
  dlg.addEventListener('close', () => {
    const cb = onCloseCb;
    onCloseCb = null;
    cb?.();
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
}

// ── Toasts (inside the game shell) ─────────────────────────────────

export function toast(text: string, tone: 'info' | 'gold' | 'pink' | 'warn' = 'info', ms = 3800): void {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.textContent = text;
  box.prepend(el);
  while (box.children.length > 4) box.lastElementChild!.remove();
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 400);
  }, ms);
}

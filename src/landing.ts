import { BRAND } from '../shared/brand';
import { bonusForPosition } from '../shared/fair';
import type { Economy } from '../shared/protocol';
import { api, prefGet, type Status } from './api';
import { $, $$, accountLink, countdown, esc, setExplorerSuffix, shortSig, txLink, usd } from './ui';

// Landing sections around the hero: brand, CA, vault, callouts, cards gallery.

export let status: Status | null = null;
let launchAt: number | null = null;

export function applyBrand(): void {
  $$('[data-brand]').forEach((el) => (el.textContent = BRAND.name));
  $$('[data-ticker]').forEach((el) => (el.textContent = BRAND.ticker));
  $$('[data-tagline]').forEach((el) => (el.textContent = BRAND.tagline));
  document.title = `${BRAND.name} · catch real cards on a shared island`;
  $<HTMLAnchorElement>('#social-x').href = BRAND.socials.x;
  $<HTMLAnchorElement>('#buy-btn').href = BRAND.buyUrl;

  const toggle = $('#nav-toggle');
  const links = $('#nav-links');
  toggle.addEventListener('click', () => {
    const open = links.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  $$('a', links).forEach((a) => a.addEventListener('click', () => links.classList.remove('open')));
}

export async function refreshStatus(): Promise<Status | null> {
  try {
    status = await api.status();
  } catch {
    return null;
  }
  setExplorerSuffix(status.explorerSuffix);
  launchAt = status.launchAt ? Date.parse(status.launchAt) : null;
  $('#how-waitlist').textContent = status.waitlistTotal.toLocaleString();
  $('#how-hits').textContent = `~${Math.round(status.odds.expectedHits)}`;
  $$('.js-threshold').forEach((el) => (el.textContent = money(status!.economy.threshold)));
  applyEconomy(status.economy);
  applyToken(status.tokenMint);
  applyVault(status.vaultWallet);
  return status;
}

/** "$10" for whole dollars, "$7.50" otherwise. */
export const money = (n: number) => (Number.isInteger(n) ? `$${n}` : usd(n));

export function applyEconomy(e: Economy): void {
  $('#how-caught').textContent = String(e.cardsCaught);
  const balls = `${e.balls} golden ball${e.balls === 1 ? '' : 's'} on the island`;
  $('#hero-status').textContent = e.launched
    ? `${balls} · vault ${usd(e.vaultUsd)} / next card at ${money(e.threshold)}`
    : `Pre-launch · vault ${usd(e.vaultUsd)} / next card at ${money(e.threshold)}`;
  if (e.launched) $('#early-countdown').textContent = 'Live';
}

function applyToken(mint: string | null): void {
  const pill = $<HTMLButtonElement>('#ca-pill');
  if (!mint) return;
  $('#ca-addr').textContent = shortSig(mint);
  pill.title = `Copy ${mint}`;
  pill.onclick = () => copyText(mint, $('#ca-addr'));
  $<HTMLAnchorElement>('#buy-btn').href = `https://jup.ag/swap/SOL-${mint}`;
}

function applyVault(addr: string | null): void {
  if (!addr) return;
  $('#vault-address').textContent = addr;
  const copy = $<HTMLButtonElement>('#vault-copy');
  copy.disabled = false;
  copy.onclick = () => copyText(addr, copy);
  const link = $<HTMLAnchorElement>('#vault-explorer');
  if (addr.startsWith('Mock')) return; // offline mock: nothing to look at
  link.href = accountLink(addr);
  link.removeAttribute('aria-disabled');
}

function copyText(text: string, el: HTMLElement): void {
  void navigator.clipboard?.writeText(text).then(() => {
    const prev = el.textContent;
    el.textContent = 'Copied!';
    setTimeout(() => (el.textContent = prev), 1200);
  });
}

export function tickCountdown(): void {
  if (status?.economy.launched) return;
  $('#early-countdown').textContent = launchAt ? `Launch in ${countdown(launchAt - Date.now())}` : 'Launching soon';
}

export function setMySpot(position: number | null): void {
  if (!position) return;
  const el = $('#early-spot');
  el.hidden = false;
  el.textContent = `Your spot #${position.toLocaleString()} · ${bonusForPosition(position)} bonus balls`;
}

export async function loadMySpot(): Promise<void> {
  if (!prefGet('cove.waitlisted') && !prefGet('cove.name')) return;
  try {
    const me = await api.me();
    setMySpot(me.waitlist?.position ?? null);
  } catch {
    /* not joined yet */
  }
}

export async function renderCards(): Promise<void> {
  const grid = $('#cards-grid');
  let cards;
  try {
    cards = await api.wonCards();
  } catch {
    return;
  }
  if (!cards.length) return;
  grid.innerHTML = cards
    .map(
      (c) => `<article class="card slab">
        <img src="${esc(c.image)}" alt="${esc(c.name)}" loading="lazy" />
        <h3>${esc(c.name)}</h3>
        <div class="meta"><span class="tag gold">${esc(c.grade)}</span><span class="tag">${usd(c.valueUsd)}</span><span class="tag pink">${c.throws} hits</span></div>
        <div class="meta">🏆 <b>${esc(c.winnerName)}</b> · ${new Date(c.caughtAt).toLocaleDateString()}</div>
        <div class="links">${c.transferSig ? txLink(c.transferSig, 'Transfer ↗') : '<span class="muted">Awaiting wallet</span>'} ${txLink(c.memoSig, 'Fair memo ↗')}</div>
      </article>`,
    )
    .join('');
}

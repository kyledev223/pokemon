import { BRAND } from '../shared/brand';
import { bonusForPosition } from '../shared/fair';
import type { Economy } from '../shared/protocol';
import { api, prefGet, type Status } from './api';
import { $, $$, accountLink, countdown, esc, setExplorerSuffix, shortSig, txLink, usd } from './ui';

// Static-ish landing sections: brand, CA, early tiles, stats, cards gallery.

export let status: Status | null = null;
let launchAt: number | null = null;

export function applyBrand(): void {
  $$('[data-brand]').forEach((el) => (el.textContent = BRAND.name));
  $$('[data-ticker]').forEach((el) => (el.textContent = BRAND.ticker));
  $$('[data-tagline]').forEach((el) => (el.textContent = BRAND.tagline));
  document.title = `${BRAND.name} · catch real cards on a shared island`;
  $<HTMLAnchorElement>('#social-x').href = BRAND.socials.x;
  $<HTMLAnchorElement>('#social-tg').href = BRAND.socials.telegram;
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
  $('#early-total').textContent = status.waitlistTotal.toLocaleString();
  $('#how-hits').textContent = `~${Math.round(status.odds.expectedHits)}`;
  $$('.js-threshold').forEach((el) => (el.textContent = usd(status!.economy.threshold).replace('.00', '')));
  applyEconomy(status.economy);
  applyToken(status.tokenMint);
  if (launchAt) $('#early-launch-note').textContent = new Date(launchAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return status;
}

export function applyEconomy(e: Economy): void {
  $('#how-caught').textContent = String(e.cardsCaught);
  $('#hero-status').textContent = e.launched ? 'Live now: the island is open' : 'Pre-launch lobby is open';
  if (e.launched) {
    $('#early-countdown').textContent = 'Live!';
    $('#early-launch-note').textContent = 'Bonuses are landing in bags';
  }
}

function applyToken(mint: string | null): void {
  const pill = $<HTMLButtonElement>('#ca-pill');
  const addr = $('#token-address');
  const copy = $<HTMLButtonElement>('#token-copy');
  const scan = $<HTMLAnchorElement>('#token-solscan');
  if (!mint) return;
  pill.textContent = `CA ${shortSig(mint)} ⧉`;
  pill.classList.add('live');
  pill.onclick = () => copyText(mint, pill);
  addr.textContent = mint;
  copy.disabled = false;
  copy.onclick = () => copyText(mint, copy);
  scan.href = accountLink(mint).replace('/account/', '/token/');
  scan.removeAttribute('aria-disabled');
  $<HTMLAnchorElement>('#buy-btn').href = `https://jup.ag/swap/SOL-${mint}`;
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
  $('#early-countdown').textContent = launchAt ? countdown(launchAt - Date.now()) : 'Soon';
}

export function setMySpot(position: number | null): void {
  if (!position) return;
  $('#early-spot').textContent = `#${position.toLocaleString()}`;
  $('#early-bonus').textContent = `${bonusForPosition(position)} bonus golden balls at launch`;
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
      (c) => `<article class="slab">
        <img src="${esc(c.image)}" alt="${esc(c.name)}" loading="lazy" />
        <h3>${esc(c.name)}</h3>
        <div class="meta"><span class="tag gold">${esc(c.grade)}</span><span class="tag">${usd(c.valueUsd)}</span><span class="tag pink">${c.throws} hits</span></div>
        <div class="meta">🏆 <b>${esc(c.winnerName)}</b> · ${new Date(c.caughtAt).toLocaleDateString()}</div>
        <div class="links">${c.transferSig ? txLink(c.transferSig, 'Transfer ↗') : '<span class="muted">Awaiting wallet</span>'} ${txLink(c.memoSig, 'Fair memo ↗')}</div>
      </article>`,
    )
    .join('');
}

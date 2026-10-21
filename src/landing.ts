import { BRAND } from '../shared/brand';
import { bonusForPosition } from '../shared/fair';
import { TIERS, type PublicPrize, type Tier } from '../shared/prizes';
import type { Economy, PublicCard } from '../shared/protocol';
import { api, prefGet, type Status } from './api';
import { $, $$, accountLink, countdown, esc, pct, pts, setExplorerSuffix, shortSig } from './ui';

// Landing sections around the hero: brand, CA, catalog, callouts, won gallery.

export let status: Status | null = null;
let launchAt: number | null = null;
let currentCard: PublicCard | null = null;
let economy: Economy | null = null;

export const TIER_TAG: Record<Tier, string> = { S: 'gold', A: 'pink', B: 'blue' };

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
  $('#how-hits').textContent = `~${Math.round(status.tiers.B.expectedHits)}`;
  renderTiers(status);
  setCard(status.card);
  applyEconomy(status.economy);
  applyToken(status.tokenMint);
  applyVault(status.vaultWallet);
  return status;
}

/** "in 5h 12m" until the next scheduled release, or a fallback when none is due. */
export function nextReleaseText(e: Economy | null, now = Date.now()): string {
  if (!e?.launched) return 'first card drops after launch';
  if (!e.nextRelease) return e.prizesLeft ? 'next card: surprise drop' : 'collection empty for now';
  const ms = e.nextRelease.at - now;
  return ms > 0 ? `next card in ${countdown(ms)}` : 'next card any moment';
}

export function setCard(card: PublicCard | null): void {
  currentCard = card;
  renderHeroStatus();
}

export function applyEconomy(e: Economy): void {
  economy = e;
  $('#how-caught').textContent = String(e.cardsCaught);
  $('#how-left').textContent = String(e.prizesLeft);
  $('#how-cap').textContent = String(e.goldPerHour);
  if (e.launched) $('#early-countdown').textContent = 'Live';
  renderHeroStatus();
}

function renderHeroStatus(): void {
  const e = economy;
  if (!e) return;
  const balls = `${e.balls} golden ball${e.balls === 1 ? '' : 's'} on the island`;
  $('#hero-status').textContent = !e.launched
    ? `Pre-launch · ${e.prizesLeft} real cards waiting in the collection`
    : currentCard
      ? `A real ${currentCard.name} card is loose! · ${balls}`
      : `${balls} · ${nextReleaseText(e)}`;
}

function renderTiers(s: Status): void {
  $('#tier-strip').innerHTML = TIERS.map((t) => {
    const info = s.tiers[t];
    const cadence = info.everyHours === null ? 'Surprise drops only' : info.everyHours % 24 === 0 ? `One every ${info.everyHours / 24 === 1 ? 'day' : `${info.everyHours / 24} days`}` : `One every ${info.everyHours}h`;
    return `<div class="tier-box">
      <div class="row"><span class="tag ${TIER_TAG[t]}">Tier ${t}</span><b>${info.available} left</b></div>
      <span>Odds ${pct(info.odds.base)} → ${pct(info.odds.cap)}, +${pts(info.odds.step)} pts per miss</span>
      <span>~${Math.round(info.expectedHits)} hits on average · ${cadence}</span>
    </div>`;
  }).join('');
}

function applyToken(mint: string | null): void {
  const pill = $<HTMLButtonElement>('#ca-pill');
  if (!mint) return;
  $('#ca-addr').textContent = shortSig(mint);
  pill.title = `Copy ${mint}`;
  pill.onclick = () => copyText(mint, $('#ca-addr'));
  $<HTMLAnchorElement>('#buy-btn').href = `https://jup.ag/swap/SOL-${mint}`;
}

/** The fee vault card only exists when VAULT_AUTO_BUY is on. */
function applyVault(addr: string | null): void {
  $('#vault-card').hidden = !addr;
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
  renderHeroStatus();
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

const date = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString() : '');

function slab(p: PublicPrize): string {
  const details = [p.set, p.grade].filter(Boolean).join(' · ');
  const state =
    p.status === 'in_play'
      ? '<span class="tag pink">Loose on the island!</span>'
      : p.status === 'available'
        ? '<span class="tag">In the collection</span>'
        : p.status === 'shipped'
          ? '<span class="tag green">📦 Shipped</span>'
          : '<span class="tag gold">🏆 Won</span>';
  const won = p.status === 'won' || p.status === 'shipped';
  return `<article class="card slab ${p.status === 'in_play' ? 'loose' : ''}">
      <img src="${esc(p.image)}" alt="${esc(p.name)} card" loading="lazy" />
      <h3>${esc(p.name)}</h3>
      <div class="meta"><span class="tag ${TIER_TAG[p.tier]}">Tier ${p.tier}</span>${state}</div>
      ${details ? `<div class="meta muted">${esc(details)}</div>` : ''}
      ${won ? `<div class="meta">🏆 <b>${esc(p.winnerName ?? '?')}</b> · ${date(p.wonAt)}${p.shippedAt ? ` · shipped ${date(p.shippedAt)}` : ''}</div>` : ''}
      ${won && p.releaseId ? `<div class="links"><a href="#verify" data-verify="${esc(p.releaseId)}">Verify throw log ↗</a></div>` : ''}
    </article>`;
}

/** Collection (still up for grabs) and the won gallery. Claim codes never leave the server here. */
export async function renderCards(): Promise<void> {
  let prizes: PublicPrize[];
  try {
    prizes = await api.prizes();
  } catch {
    return;
  }
  const shelf = prizes.filter((p) => p.status === 'available' || p.status === 'in_play');
  const won = prizes.filter((p) => p.status === 'won' || p.status === 'shipped').sort((a, b) => (b.wonAt ?? 0) - (a.wonAt ?? 0));
  $('#catalog-grid').innerHTML = shelf.length
    ? shelf.map(slab).join('')
    : '<div class="card empty"><span class="ico yellow">🃏</span><p>Every card has been won. More are coming.</p></div>';
  if (won.length) $('#cards-grid').innerHTML = won.map(slab).join('');
  $$('[data-verify]').forEach((a) => a.addEventListener('click', () => selectForVerify(a.dataset.verify!)));
}

function selectForVerify(releaseId: string): void {
  const select = $<HTMLSelectElement>('#verify-card');
  if ([...select.options].some((o) => o.value === releaseId)) select.value = releaseId;
  else $<HTMLInputElement>('#verify-id').value = releaseId;
}

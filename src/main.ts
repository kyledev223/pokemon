import './styles.css';
import { BASE_DEX_SIZE, speciesById } from '../shared/species';
import type { PublicCard } from '../shared/protocol';
import { api, saveName, savedName, prefGet, prefSet } from './api';
import { Game } from './game/game';
import { applyBrand, applyEconomy, loadMySpot, refreshStatus, renderCards, setMySpot, tickCountdown } from './landing';
import { openArena, openClaim, openDex, openMarket, openRanks, openWaitlistJoined } from './panels';
import { initVerifier } from './verify';
import { $, $$, esc, initModal, mmss, modalOpen, pct, toast, usd } from './ui';

applyBrand();
initModal();

const shell = $('#game-shell');
const startOverlay = $('#start-overlay');
const pauseOverlay = $('#pause-overlay');
const nameInput = $<HTMLInputElement>('#name-input');
nameInput.value = savedName();

let card: PublicCard | null = null;

const game = new Game(shell, $<HTMLCanvasElement>('#game-canvas'), {
  onEconomy(e) {
    applyEconomy(e);
    $('#hud-online').textContent = String(e.online);
    $('#hud-vault').textContent = usd(e.vaultUsd);
    $('#hud-threshold').textContent = usd(e.threshold).replace('.00', '');
    $('#hud-vault-bar').style.width = `${Math.min(100, (e.vaultUsd / e.threshold) * 100)}%`;
    syncStartCopy();
  },
  onCard(c) {
    card = c;
    renderHudCard();
  },
  onYou() {},
  onGold(n) {
    $('#hud-gold').textContent = String(n);
  },
  onDex(dex) {
    $('#hud-dex').textContent = `${dex.filter((id) => speciesById(id).region === 'base').length}/${BASE_DEX_SIZE}`;
  },
  onEvent(e) {
    const el = $('#hud-event');
    el.hidden = !e;
    eventInfo = e;
  },
  onToast: (text, tone) => toast(text, tone),
  onCardCaught(m, mine) {
    toast(mine ? `🎉 YOU caught the real ${m.name}!` : `🎉 ${m.by} caught the real ${m.name}!`, 'gold', 6000);
    setTimeout(() => void renderCards(), 2500);
    if (mine) openClaim(m.name, game.you, undefined, resumeIfPlaying);
  },
  onPause(paused) {
    if (modalOpen()) return;
    pauseOverlay.hidden = !paused;
  },
  onKey(code) {
    if (code === 'KeyC') void openDex(resumeIfPlaying);
    else if (code === 'KeyM') toggleSound();
    else if (code === 'market') void openMarket(resumeIfPlaying);
  },
  onNearBazaar(near) {
    const p = $('#hud-prompt');
    p.hidden = !near;
    p.textContent = game.input.isTouch ? '🏪 Tap to open the Critter Market' : '🏪 Press E to open the Critter Market';
  },
});

let eventInfo: { species: number; endsAt: number } | null = null;

if (game.input.isTouch) {
  document.documentElement.classList.add('is-touch');
  game.input.bindTouch({
    stickZone: $('#stick-zone'),
    stick: $('#stick'),
    look: $('#look-zone'),
    pink: $('#t-pink'),
    gold: $('#t-gold'),
    jump: $('#t-jump'),
  });
}

function resumeIfPlaying(): void {
  if (game.playing) {
    pauseOverlay.hidden = true;
    game.resume();
    setTimeout(() => {
      if (game.playing && !game.input.isTouch && !game.input.locked && !modalOpen()) pauseOverlay.hidden = false;
    }, 250);
  }
}

function syncStartCopy(): void {
  const launched = !!game.economy?.launched;
  $('#start-title').textContent = launched ? '🏝️ The island is live' : '🎟️ Join the pre-launch lobby';
  $('#start-sub').textContent = launched
    ? 'Grab golden balls, chase the real card and fill your dex with free pink orbs.'
    : 'Hang out in the glass lobby above the island and toss pink orbs off the edge while we get ready.';
  $('#enter-btn').textContent = launched ? 'Play now' : 'Enter the lobby';
}

function renderHudCard(): void {
  const box = $('#hud-card');
  if (!card) {
    box.innerHTML = `<span class="muted">${game.economy?.launched ? 'Waiting for the vault…' : 'First card drops after launch'}</span>`;
    return;
  }
  box.innerHTML = `<img src="${esc(card.image)}" alt="" /><div><b>${esc(card.name)}</b><small>${esc(card.grade)} · ${usd(card.valueUsd)}</small><small>${card.throws} hits · next ${pct(card.nextOdds)}</small></div>`;
}

function toggleSound(): void {
  const on = game.sfx.toggle();
  $('#hud-sound').textContent = on ? '🔊' : '🔇';
}
$('#hud-sound').textContent = game.sfx.enabled ? '🔊' : '🔇';
$('#hud-sound').addEventListener('click', toggleSound);

// ── Entering the game ───────────────────────────────────────────────

$<HTMLFormElement>('#start-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = nameInput.value.trim().slice(0, 16);
  if (name.length < 2) return nameInput.focus();
  saveName(name);
  game.sfx.unlock();
  const begin = () => {
    startOverlay.hidden = true;
    if (game.input.isTouch) {
      shell.scrollIntoView({ block: 'start', behavior: 'smooth' });
      void shell.requestFullscreen?.().catch(() => {});
    }
    game.join(name);
    game.play();
    resumeIfPlaying();
  };
  if (game.economy?.launched) return begin();
  try {
    const r = await api.waitlist(name);
    setMySpot(r.position);
    $('#early-total').textContent = r.total.toLocaleString();
    if (prefGet('cove.waitlisted') === String(r.position)) {
      toast(`Welcome back! You're still #${r.position} of ${r.total}.`, 'pink');
      begin();
    } else {
      prefSet('cove.waitlisted', String(r.position));
      openWaitlistJoined(r, begin);
    }
  } catch (err) {
    toast((err as Error).message, 'warn');
    begin();
  }
});

pauseOverlay.addEventListener('click', () => {
  pauseOverlay.hidden = true;
  game.resume();
});
document.addEventListener('pointerlockerror', () => {
  if (game.playing && !modalOpen()) pauseOverlay.hidden = false;
});

$('#fs-btn').addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void shell.requestFullscreen?.().catch(() => {});
});

$$('[data-open]').forEach((b) =>
  b.addEventListener('click', () => {
    const which = b.dataset.open;
    if (which === 'dex') void openDex(resumeIfPlaying);
    if (which === 'ranks') void openRanks(resumeIfPlaying);
    if (which === 'arena') void openArena(resumeIfPlaying);
    if (which === 'market') void openMarket(resumeIfPlaying);
  }),
);
$('#hud-prompt').addEventListener('click', () => void openMarket(resumeIfPlaying));
$$('.slot').forEach((s) => s.addEventListener('click', () => game.setSlot(Number(s.dataset.slot) as 1 | 2)));
$('#open-market').addEventListener('click', () => void openMarket());

// ── Timers ──────────────────────────────────────────────────────────

setInterval(() => {
  const e = game.economy;
  $('#hud-drop').textContent = e?.launched && e.nextClaimAt ? mmss(e.nextClaimAt - game.net.now()) : 'at launch';
  if (eventInfo) {
    const left = eventInfo.endsAt - game.net.now();
    $('#hud-event').textContent = `🌟 Legendary ${speciesById(eventInfo.species).name} spotted · ${mmss(left)} left`;
  }
  tickCountdown();
}, 250);

void refreshStatus().then((s) => {
  if (s) {
    card = s.card;
    renderHudCard();
  }
});
setInterval(() => void refreshStatus(), 30_000);
void loadMySpot();
void renderCards();
void initVerifier();

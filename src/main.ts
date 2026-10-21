import './styles.css';
import { BASE_DEX_SIZE, speciesById } from '../shared/species';
import type { PublicCard } from '../shared/protocol';
import { api, saveName, savedName, prefGet, prefSet } from './api';
import { Game, type Spot } from './game/game';
import { Minimap } from './game/minimap';
import { Chat } from './chat';
import { applyBrand, applyEconomy, loadMySpot, money, refreshStatus, renderCards, setMySpot, tickCountdown } from './landing';
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
let eventInfo: { species: number; endsAt: number } | null = null;

const chat = new Chat((text) => game.sendChat(text));
const minimap = new Minimap($<HTMLCanvasElement>('#minimap'));

const SPOT_PROMPT: Record<Spot, string> = {
  market: '🏪 Open the market',
  arena: '⚔️ Enter the arena',
  dex: '📖 Talk to the Dex Master',
};

const game = new Game(shell, $<HTMLCanvasElement>('#game-canvas'), {
  onEconomy(e) {
    applyEconomy(e);
    $('#hud-online').textContent = String(e.online);
    $('#hud-vault').textContent = usd(e.vaultUsd);
    $('#hud-vault-bar').style.width = `${Math.min(100, (e.vaultUsd / e.threshold) * 100)}%`;
    $('#hud-econ-note').textContent = `next card at ${money(e.threshold)} · ${e.balls} golden ball${e.balls === 1 ? '' : 's'} on the island`;
    renderMasters(e.dexMasters);
    renderHudCard();
    syncStartCopy();
  },
  onCard(c) {
    card = c;
    renderHudCard();
  },
  onYou(you) {
    chat.myName = you.name;
  },
  onGold(n) {
    $('#hud-gold').textContent = String(n);
    $('#t-gold-count').textContent = String(n);
  },
  onDex(dex) {
    $('#hud-dex').textContent = `${dex.filter((id) => speciesById(id).region === 'base').length}/${BASE_DEX_SIZE}`;
  },
  onEvent(e) {
    $('#hud-event').hidden = !e;
    eventInfo = e;
  },
  onToast: (text, tone) => toast(text, tone),
  onChat: (line) => chat.add(line),
  onChatReset: (lines) => chat.reset(lines),
  onCardCaught(m, mine) {
    toast(mine ? `🎉 YOU caught the real ${m.name}!` : `🎉 ${m.by} caught the real ${m.name}!`, 'gold', 6000);
    setTimeout(() => void renderCards(), 2500);
    if (mine) openClaim(m.name, game.you, undefined, resumeIfPlaying);
  },
  onPause(paused) {
    if (modalOpen() || !game.playing) return;
    pauseOverlay.hidden = !paused;
  },
  onKey(code) {
    if (code === 'KeyC') void openDex(resumeIfPlaying);
    else if (code === 'KeyM') toggleSound();
    else if (code === 'Enter') chat.open();
    else if (code === 'spot:market') void openMarket(resumeIfPlaying);
    else if (code === 'spot:arena') void openArena(resumeIfPlaying);
    else if (code === 'spot:dex') void openDex(resumeIfPlaying);
  },
  onSpot(spot) {
    const p = $('#hud-prompt');
    p.hidden = !spot;
    if (spot) p.innerHTML = game.input.isTouch ? `${SPOT_PROMPT[spot]} · tap` : `<span class="kbd">E</span> ${SPOT_PROMPT[spot]}`;
    p.dataset.spot = spot ?? '';
  },
});

if (game.input.isTouch) {
  document.documentElement.classList.add('is-touch');
  game.input.bindTouch({
    stickZone: $('#stick-zone'),
    stick: $('#stick'),
    look: $('#look-zone'),
    lookStick: $('#look-stick'),
    pink: $('#t-pink'),
    gold: $('#t-gold'),
    jump: $('#t-jump'),
  });
}

function resumeIfPlaying(): void {
  if (!game.playing) return;
  pauseOverlay.hidden = true;
  game.resume();
  setTimeout(() => {
    if (game.playing && !game.input.isTouch && !game.input.locked && !modalOpen()) pauseOverlay.hidden = false;
  }, 250);
}

function syncStartCopy(): void {
  const launched = !!game.economy?.launched;
  $('#enter-btn').textContent = game.playing || game.joined ? 'Resume' : 'Play';
  $('#start-note').textContent = launched
    ? 'Pink orbs are free and unlimited: use them to catch critters for your dex. Golden balls are limited: they drop on the island with creator fees, and every one that hits the real card is a roll to win it.'
    : 'Pre-launch: join the waitlist and hang out in the glass lobby above the island. Pink orbs are free and unlimited. Golden balls start dropping at launch, and earlier spots get bonus balls.';
}

function renderHudCard(): void {
  const e = game.economy;
  const thumb = $('#hud-card-thumb');
  const threshold = e ? money(e.threshold) : '$10';
  const vault = e ? usd(e.vaultUsd) : '$0.00';
  if (!card) {
    thumb.innerHTML = '<span>?</span>';
    $('#hud-card-title').textContent = 'NO CARD IN PLAY';
    $('#hud-card-line1').textContent = `Next card at ${threshold}`;
    $('#hud-card-line2').textContent = `Vault ${vault}`;
    $('#hud-note').textContent = e?.launched ? 'Next card spawns when the vault fills.' : 'Golden drops start at launch.';
    return;
  }
  thumb.innerHTML = `<img src="${esc(card.image)}" alt="" />`;
  $('#hud-card-title').textContent = card.name;
  $('#hud-card-line1').textContent = `${card.grade} · ${usd(card.valueUsd)}`;
  $('#hud-card-line2').textContent = `${card.throws} hits · next ${pct(card.nextOdds)}`;
  $('#hud-note').textContent = '🎯 Hit the golden card creature. Every hit is a roll.';
}

let mastersKey = '';
function renderMasters(names: string[]): void {
  const key = names.join('|');
  if (key === mastersKey) return;
  mastersKey = key;
  const ticker = $('#hud-ticker');
  const el = $('#hud-masters');
  const text = names.length ? names.join(' · ') : 'Be the first to complete the dex';
  el.textContent = text;
  ticker.classList.remove('scrolling');
  // Scroll only when the names overflow; duplicate the text so the loop is seamless.
  requestAnimationFrame(() => {
    const track = el.parentElement!;
    if (el.scrollWidth > track.clientWidth) {
      el.textContent = `${text} · ${text} · `;
      ticker.classList.add('scrolling');
    }
  });
}

function toggleSound(): void {
  const on = game.sfx.toggle();
  $('#hud-sound').textContent = on ? '🔊 Sound' : '🔇 Muted';
}
$('#hud-sound').textContent = game.sfx.enabled ? '🔊 Sound' : '🔇 Muted';
$('#hud-sound').addEventListener('click', toggleSound);

// ── Entering and leaving the game ───────────────────────────────────

function enterGame(name: string): void {
  startOverlay.hidden = true;
  document.body.classList.add('in-game');
  if (game.input.isTouch) void shell.requestFullscreen?.().catch(() => {});
  if (!game.joined || name !== savedName()) game.join(name);
  saveName(name);
  game.play();
  syncStartCopy();
  resumeIfPlaying();
}

function leaveGame(): void {
  game.leave();
  pauseOverlay.hidden = true;
  startOverlay.hidden = false;
  document.body.classList.remove('in-game');
  if (document.fullscreenElement) void document.exitFullscreen();
  syncStartCopy();
}

$<HTMLFormElement>('#start-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = nameInput.value.trim().slice(0, 16);
  if (name.length < 2) return nameInput.focus();
  game.sfx.unlock();
  if (game.economy?.launched || game.joined) return enterGame(name);
  try {
    const r = await api.waitlist(name);
    setMySpot(r.position);
    $('#how-waitlist').textContent = r.total.toLocaleString();
    if (prefGet('cove.waitlisted') === String(r.position)) {
      toast(`Welcome back! You're still #${r.position} of ${r.total}.`, 'pink');
      enterGame(name);
    } else {
      prefSet('cove.waitlisted', String(r.position));
      openWaitlistJoined(r, () => enterGame(name));
    }
  } catch (err) {
    toast((err as Error).message, 'warn');
    enterGame(name);
  }
});

$('#resume-btn').addEventListener('click', () => {
  pauseOverlay.hidden = true;
  game.resume();
});
$('#leave-btn').addEventListener('click', leaveGame);
document.addEventListener('pointerlockerror', () => {
  if (game.playing && !modalOpen()) pauseOverlay.hidden = false;
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
$('#hud-prompt').addEventListener('click', (e) => {
  const spot = (e.currentTarget as HTMLElement).dataset.spot;
  if (spot) game.input.onKey('KeyE');
});
$$('.slot').forEach((s) => s.addEventListener('click', () => game.setSlot(Number(s.dataset.slot) as 1 | 2)));
$('#open-market').addEventListener('click', () => void openMarket());

// ── Timers ──────────────────────────────────────────────────────────

setInterval(() => {
  const e = game.economy;
  $('#hud-drop').textContent = e?.launched && e.nextClaimAt ? mmss(e.nextClaimAt - game.net.now()) : 'launch';
  if (eventInfo) {
    const left = eventInfo.endsAt - game.net.now();
    $('#hud-event').textContent = `🌟 Legendary ${speciesById(eventInfo.species).name} spotted · ${mmss(left)} left`;
  }
  tickCountdown();
}, 250);

setInterval(() => {
  if (game.playing) minimap.draw(game.mapMe(), game.mapBalls(), game.mapOthers(), game.mapCard());
}, 100);

/** Stadium screen shows the arena board, or the dex race until someone has fought. */
async function refreshLeaderboard(): Promise<void> {
  try {
    const r = await api.ranks();
    game.island.setLeaderboard(r.arena.length ? r.arena : r.dex);
  } catch {
    /* offline; keep the last board */
  }
}

void refreshStatus().then((s) => {
  if (s) {
    card = s.card;
    renderHudCard();
  }
});
setInterval(() => void refreshStatus(), 30_000);
void refreshLeaderboard();
setInterval(() => void refreshLeaderboard(), 60_000);
void loadMySpot();
void renderCards();
void initVerifier();

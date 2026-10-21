import { BRAND } from '../shared/brand';
import {
  REGIONS,
  REGION_LABEL,
  SPECIES,
  STAT_MAX,
  levelFor,
  movesFor,
  speciesById,
  statsAtLevel,
  weaknessesOf,
  type Element,
  type Rarity,
  type Region,
} from '../shared/species';
import type { MyClaim } from '../shared/prizes';
import { api, type BattleState, type CollectionItem, type FighterView, type Me, type Offer } from './api';
import { thumb } from './thumbs';
import './panels-dex.css';
import { $, $$, accountLink, closeModal, esc, openModal } from './ui';

// All the modal panels: dex, ranks, arena, market, waitlist + card claim.

type AfterClose = () => void;

async function loadMe(): Promise<Me | null> {
  try {
    return await api.me();
  } catch {
    return null;
  }
}

function errorBox(root: HTMLElement, msg: string): void {
  const box = $('.err', root);
  if (box) box.textContent = msg;
}

// ── Dex ──────────────────────────────────────────────────────────────

const ELEMENT_ICON: Record<Element | 'neutral', string> = {
  leaf: '🍃',
  ember: '🔥',
  tide: '💧',
  spark: '⚡',
  stone: '🪨',
  breeze: '🌬️',
  neutral: '✦',
};

const rarityLabel = (r: Rarity) => r[0].toUpperCase() + r.slice(1);
const dexNo = (id: number) => `#${String(id).padStart(3, '0')}`;

function elementChip(e: Element | 'neutral'): string {
  return `<span class="el-chip el-${e}">${ELEMENT_ICON[e]} ${e}</span>`;
}

function statBar(label: string, value: number, max: number, cls: string): string {
  const w = Math.max(4, Math.min(100, (value / max) * 100));
  return `<div class="stat-row"><span>${label}</span><div class="stat-bar ${cls}"><i style="width:${w}%"></i></div><b>${value}</b></div>`;
}

export async function openDex(onClose?: AfterClose): Promise<void> {
  const body = openModal('<h2>📖 My dex</h2><p>Loading…</p>', onClose, { wide: true });
  const me = await loadMe();
  const owned = new Map<number, number>();
  for (const c of me?.collection ?? []) owned.set(c.species, (owned.get(c.species) ?? 0) + 1);
  let region: Region = 'base';
  const firstIn = (r: Region) => SPECIES.find((s) => s.region === r && owned.has(s.id))?.id ?? SPECIES.find((s) => s.region === r)!.id;
  let selected = firstIn(region);

  const caughtIn = (r: Region) => SPECIES.filter((s) => s.region === r && owned.has(s.id)).length;
  const totalIn = (r: Region) => SPECIES.filter((s) => s.region === r).length;
  const speciesCaught = SPECIES.filter((s) => owned.has(s.id)).length;
  const copies = [...owned.values()].reduce((a, n) => a + n, 0);
  const baseCaught = caughtIn('base');
  const baseTotal = totalIn('base');

  const detail = (id: number) => {
    const s = speciesById(id);
    const n = owned.get(id) ?? 0;
    const legend = s.rarity === 'legendary' ? '<p class="tiny dx-legend-note">🌟 Only appears during legendary events</p>' : '';
    if (!n) {
      return `<div class="dx-portrait unknown"><img src="${thumb(id, { silhouette: true })}" alt="" /></div>
        <div class="dx-name"><h3>???</h3><span class="muted">${dexNo(id)}</span></div>
        <div class="dx-tags"><span class="tag ${rarityClass(s.rarity)}">${rarityLabel(s.rarity)}</span><span class="tag">${REGION_LABEL[s.region]}</span></div>
        <p class="muted">Not caught yet. ${regionBlurb(s.region)}.</p>${legend}`;
    }
    const level = levelFor(n);
    const st = statsAtLevel(s, level);
    return `<div class="dx-portrait"><img src="${thumb(id)}" alt="" /></div>
      <div class="dx-name"><h3>${esc(s.name)}</h3><span class="muted">${dexNo(id)}</span><span class="tag pink">Lv ${level}</span></div>
      <div class="dx-tags"><span class="tag ${rarityClass(s.rarity)}">${rarityLabel(s.rarity)}</span><span class="tag">${REGION_LABEL[s.region]}</span>${elementChip(s.element)}${n > 1 ? `<span class="tag">×${n} owned</span>` : ''}</div>
      <div class="dx-stats">
        ${statBar('HP', st.hp, STAT_MAX.hp * 1.4, 'hp')}
        ${statBar('ATK', st.atk, STAT_MAX.atk * 1.4, 'atk')}
        ${statBar('DEF', st.def, STAT_MAX.def * 1.4, 'def')}
        ${statBar('SPD', st.spd, STAT_MAX.spd * 1.4, 'spd')}
      </div>
      <div class="dx-sub">Weak to</div>
      <div class="dx-chips">${weaknessesOf(s).map((e) => elementChip(e)).join('') || '<span class="muted">Nothing!</span>'}</div>
      <div class="dx-sub">Moves</div>
      <div class="dx-moves">${movesFor(s)
        .map((m) => `<span class="move-chip el-${m.element}">${ELEMENT_ICON[m.element]} ${esc(m.name)} <small>${m.power}</small></span>`)
        .join('')}</div>${legend}`;
  };

  const render = () => {
    const list = SPECIES.filter((s) => s.region === region);
    body.innerHTML = `
      <div class="dex">
        <h2>📖 My dex</h2>
        ${me ? '' : '<p class="muted">Enter the game and catch critters with pink orbs to start your dex.</p>'}
        <div class="dx-top">
          <section class="dx-card dx-master">
            <div class="dx-master-head"><span class="dx-icon">💎</span><div><b>Master card</b><small>First trainer to fill every page wins it</small></div><span class="tag gold">🔒 Secret</span></div>
            <div class="dx-master-count"><b>${speciesCaught}</b>/${SPECIES.length}</div>
            <div class="bar dx-bar"><i style="width:${(speciesCaught / SPECIES.length) * 100}%"></i></div>
            <div class="dx-regions">${REGIONS.map((r) => `<span class="tag">${REGION_LABEL[r]} <b>${caughtIn(r)}/${totalIn(r)}</b></span>`).join('')}</div>
          </section>
          <section class="dx-card dx-progress">
            <div class="dx-progress-head"><b>${baseCaught}/${baseTotal}</b> species caught</div>
            <div class="bar dx-bar"><i style="width:${(baseCaught / baseTotal) * 100}%"></i></div>
            <p class="tiny muted">Island dex. Ocean, Sky and Cave are bonus pages.</p>
          </section>
          <section class="dx-card dx-count"><b>${copies}</b><span>critters caught</span></section>
        </div>
        <div class="dx-main">
          <section class="dx-card dx-detail" id="dx-detail">${detail(selected)}</section>
          <section class="dx-browse">
            <div class="dx-tabs">${REGIONS.map(
              (r) => `<button type="button" data-region="${r}" class="${r === region ? 'active' : ''}">${REGION_LABEL[r]} <small>${caughtIn(r)}/${totalIn(r)}</small></button>`,
            ).join('')}</div>
            <p class="tiny muted">${regionBlurb(region)}</p>
            <div class="dx-grid">${list
              .map((s) => {
                const n = owned.get(s.id) ?? 0;
                const legend = s.rarity === 'legendary';
                return `<button type="button" class="dx-slot ${n ? 'caught' : 'missing'} ${legend ? 'legendary' : ''} ${s.id === selected ? 'selected' : ''}" data-species="${s.id}">
                  <span class="dx-no">${dexNo(s.id)}</span>
                  <img src="${thumb(s.id, { silhouette: !n })}" alt="" loading="lazy" />
                  <span class="dx-slot-name">${n ? esc(s.name) : '???'}</span>
                  <span class="tag ${rarityClass(s.rarity)}">${rarityLabel(s.rarity)}</span>
                  ${legend ? '<small class="dx-legend">only during legendary events</small>' : ''}
                </button>`;
              })
              .join('')}</div>
          </section>
        </div>
      </div>`;
    $$('[data-region]', body).forEach((b) =>
      b.addEventListener('click', () => {
        region = b.dataset.region as Region;
        selected = firstIn(region);
        render();
      }),
    );
    $$('[data-species]', body).forEach((b) =>
      b.addEventListener('click', () => {
        selected = Number(b.dataset.species);
        $$('.dx-slot', body).forEach((el) => el.classList.toggle('selected', el === b));
        $('#dx-detail', body).innerHTML = detail(selected);
      }),
    );
  };
  render();
}

function rarityClass(r: Rarity): string {
  return { common: '', uncommon: 'green', rare: 'blue', epic: 'purple', legendary: 'gold' }[r];
}

function regionBlurb(r: Region): string {
  return {
    base: 'Roaming the meadows, hills and beaches',
    ocean: 'Swimming offshore: throw from the beach',
    sky: 'Circling overhead, they land for a few seconds',
    cave: 'Deep inside the crystal mountain (north-east)',
  }[r];
}

// ── Ranks ────────────────────────────────────────────────────────────

export async function openRanks(onClose?: AfterClose): Promise<void> {
  const body = openModal('<h2>🏆 Ranks</h2><p>Loading…</p>', onClose);
  const r = await api.ranks();
  const box = (title: string, rows: { name: string; score: number }[], unit: string) => `
    <div class="rank-box"><h3>${title}</h3>${
      rows.length
        ? `<ol>${rows.map((x) => `<li><span>${esc(x.name)}</span><b>${x.score} ${unit}</b></li>`).join('')}</ol>`
        : '<p class="tiny">No one yet. Be first!</p>'
    }</div>`;
  body.innerHTML = `<h2>🏆 Ranks</h2>
    <div class="ranks-grid">
      ${box('📖 Dex progress', r.dex, `/ ${SPECIES.length}`)}
      ${box('🃏 Real cards caught', r.cards, '')}
      ${box('🎯 Golden hits', r.hits, '')}
      ${box('⚔️ Arena points', r.arena, 'pts')}
    </div>`;
}

// ── Arena ────────────────────────────────────────────────────────────

export async function openArena(onClose?: AfterClose): Promise<void> {
  const body = openModal('<h2>⚔️ Arena</h2><p>Loading…</p>', onClose, { wide: true });
  const me = await loadMe();
  if (!me || !me.collection.length) {
    body.innerHTML = `<div class="arena"><h2>⚔️ Arena</h2>
      <div class="dx-card arena-empty"><span class="dx-icon">🎯</span><p>Catch a few critters with free pink orbs first, then bring up to three of them here for turn-based battles against wandering trainers. Wins climb the Ranks board.</p></div></div>`;
    return;
  }
  const copies = new Map<number, number>();
  for (const c of me.collection) copies.set(c.species, (copies.get(c.species) ?? 0) + 1);
  const team = dedupeBySpecies(me.collection);
  const picked: number[] = [];

  const picker = (err = '') => {
    body.innerHTML = `<div class="arena">
      <h2>⚔️ Arena</h2>
      <p class="muted">Pick up to 3 critters, then choose a move each turn. Elements matter: leaf › tide › ember › leaf, spark › breeze › stone › spark.</p>
      <div class="ar-pick">${team
        .map((c) => {
          const s = speciesById(c.species);
          const order = picked.indexOf(c.id);
          return `<button type="button" class="ar-pick-cell ${order >= 0 ? 'picked' : ''}" data-id="${c.id}">
            ${order >= 0 ? `<span class="ar-order">${order + 1}</span>` : ''}
            <img src="${thumb(s.id)}" alt="" /><b>${esc(s.name)}</b>
            <span class="ar-pick-meta">Lv ${levelFor(copies.get(s.id) ?? 1)} ${elementChip(s.element)}</span></button>`;
        })
        .join('')}</div>
      <div class="row ar-go-row"><button class="btn btn-primary btn-lg" id="ar-go" type="button" ${picked.length ? '' : 'disabled'}>⚔️ Battle!</button>
        <span class="tiny muted">${picked.length}/3 picked</span><span class="err">${esc(err)}</span></div>
    </div>`;
    $$('[data-id]', body).forEach((b) =>
      b.addEventListener('click', () => {
        const id = Number(b.dataset.id);
        const i = picked.indexOf(id);
        if (i >= 0) picked.splice(i, 1);
        else if (picked.length < 3) picked.push(id);
        picker();
      }),
    );
    $('#ar-go', body).addEventListener('click', async (e) => {
      (e.currentTarget as HTMLButtonElement).disabled = true;
      try {
        const r = await api.arenaStart(picked);
        battle(r.battleId, r.foeName, r.state);
      } catch (err) {
        picker((err as Error).message);
      }
    });
  };

  const fighterCard = (side: 'you' | 'foe', f: FighterView | null, teamList: BattleState['yourTeam'], trainer: string) => {
    if (!f) return `<div class="ar-fighter ${side}"></div>`;
    const pct = (f.hp / f.maxHp) * 100;
    return `<div class="ar-fighter ${side}" data-species="${f.species}">
      <img class="ar-portrait" src="${thumb(f.species)}" alt="" />
      <div class="ar-info">
        <div class="ar-name"><b>${esc(f.name)}</b><span class="tag pink">Lv ${f.level}</span></div>
        <small class="muted">${esc(trainer)}</small>
        <div class="ar-hp"><i class="${hpClass(pct)}" style="width:${pct}%"></i></div>
        <div class="ar-hp-text"><span>HP</span><b>${f.hp}/${f.maxHp}</b></div>
        <div class="ar-team">${teamList.map((t) => `<span class="ar-pip ${t.hp > 0 ? '' : 'out'}" title="${esc(speciesById(t.species).name)}"></span>`).join('')}</div>
      </div>
    </div>`;
  };

  const battle = (battleId: string, foeName: string, state: BattleState) => {
    body.innerHTML = `<div class="arena">
      <h2>⚔️ Arena <span class="tag">vs ${esc(foeName)}</span></h2>
      <div class="ar-field">
        <div id="ar-foe">${fighterCard('foe', state.foe, state.foeTeam, foeName)}</div>
        <div class="ar-vs">VS</div>
        <div id="ar-you">${fighterCard('you', state.you, state.yourTeam, 'You')}</div>
      </div>
      <div class="ar-bottom">
        <div class="ar-moves" id="ar-moves"></div>
        <div class="ar-log" id="ar-log"><p class="muted">${esc(foeName)} wants to battle! Pick a move.</p></div>
      </div>
      <div class="err" id="ar-err"></div>
      <div id="ar-result"></div>
    </div>`;
    const log = $('#ar-log', body);
    const movesBox = $('#ar-moves', body);
    let busy = false;

    const renderMoves = (s: BattleState) => {
      movesBox.innerHTML = (s.you?.moves ?? [])
        .map(
          (m, i) =>
            `<button type="button" class="move-chip big el-${m.element}" data-move="${i}"><span>${ELEMENT_ICON[m.element]} ${esc(m.name)}</span><small>PWR ${m.power} · ${Math.round(m.accuracy * 100)}%</small></button>`,
        )
        .join('');
      $$('[data-move]', movesBox).forEach((b) => b.addEventListener('click', () => void play(Number(b.dataset.move))));
    };

    const update = (s: BattleState) => {
      const sides = [
        ['#ar-foe', s.foe, s.foeTeam, foeName, 'foe'],
        ['#ar-you', s.you, s.yourTeam, 'You', 'you'],
      ] as const;
      for (const [slot, f, teamList, trainer, side] of sides) {
        const box = $(slot, body);
        const card = $('.ar-fighter', box);
        if (!f || card?.dataset.species !== String(f.species)) {
          box.innerHTML = fighterCard(side, f, teamList, trainer);
          continue;
        }
        const pct = (f.hp / f.maxHp) * 100;
        const bar = $('.ar-hp i', card);
        bar.style.width = `${pct}%`;
        bar.className = hpClass(pct);
        $('.ar-hp-text b', card).textContent = `${f.hp}/${f.maxHp}`;
        $$('.ar-pip', card).forEach((p, i) => p.classList.toggle('out', teamList[i].hp <= 0));
      }
    };

    const addLine = (text: string, cls = '') => {
      const p = document.createElement('p');
      p.textContent = text;
      if (cls) p.className = cls;
      log.append(p);
      log.scrollTop = log.scrollHeight;
    };

    const play = async (move: number) => {
      if (busy) return;
      busy = true;
      movesBox.classList.add('busy');
      $('#ar-err', body).textContent = '';
      try {
        const r = await api.arenaMove(battleId, move);
        addLine(`Turn ${r.state.turn}`, 'turn');
        for (const line of r.log) {
          addLine(line, /fainted|missed/.test(line) ? 'warn' : /Super effective|Critical/.test(line) ? 'hot' : '');
          await new Promise((res) => setTimeout(res, 320));
        }
        update(r.state);
        if (r.done) {
          movesBox.innerHTML = '';
          $('#ar-result', body).innerHTML = `<div class="ar-result ${r.won ? 'won' : 'lost'}">
            <span class="dx-icon">${r.won ? '🏆' : '💫'}</span>
            <div><h3>${r.won ? 'Victory!' : 'Defeated'}</h3><p>+${r.points ?? 0} arena points${r.won ? '. Nice battling!' : '. Train up and try again.'}</p></div>
            <button class="btn btn-primary" type="button" id="ar-again">Battle again</button></div>`;
          $('#ar-again', body).addEventListener('click', () => picker());
        } else renderMoves(r.state);
      } catch (err) {
        $('#ar-err', body).textContent = (err as Error).message;
      } finally {
        busy = false;
        movesBox.classList.remove('busy');
      }
    };

    renderMoves(state);
  };

  picker();
}

function hpClass(pct: number): string {
  return pct > 50 ? 'hi' : pct > 20 ? 'mid' : 'lo';
}

function dedupeBySpecies(items: CollectionItem[]): CollectionItem[] {
  const seen = new Set<number>();
  return items.filter((c) => (seen.has(c.species) ? false : (seen.add(c.species), true)));
}

// ── Market ───────────────────────────────────────────────────────────

export async function openMarket(onClose?: AfterClose): Promise<void> {
  const body = openModal('<h2>🏪 Critter Market</h2><p>Loading…</p>', onClose);
  const [offers, me] = await Promise.all([api.offers(), loadMe()]);
  renderMarket(body, offers, me);
}

function renderMarket(body: HTMLElement, offers: Offer[], me: Me | null): void {
  const myId = me?.you.id;
  const tradable = (me?.collection ?? []).filter((c) => !c.locked && !c.listed);
  const canSwap = (species: number | null) => tradable.find((c) => c.species === species);
  body.innerHTML = `
    <h2>🏪 Critter Market</h2>
    <p>Swap duplicates instantly, or sell them for ${esc(BRAND.ticker)}. The first catch of each species stays locked in your dex.</p>
    <div class="offer-list">${
      offers.length
        ? offers
            .map((o) => {
              const s = speciesById(o.species);
              const want =
                o.kind === 'swap'
                  ? `wants <span class="want"><img src="${thumb(o.wantSpecies!)}" alt="" />${esc(speciesById(o.wantSpecies!).name)}</span>`
                  : `for <b>${o.price} ${esc(BRAND.ticker)}</b>`;
              let action = '';
              if (o.sellerId === myId) action = `<button class="btn btn-ghost btn-sm" data-cancel="${o.id}" type="button">Cancel</button>`;
              else if (!me) action = '<span class="tiny">Join to trade</span>';
              else if (o.kind === 'swap')
                action = canSwap(o.wantSpecies)
                  ? `<button class="btn btn-primary btn-sm" data-swap="${o.id}" type="button">Swap</button>`
                  : `<span class="tiny">Need a spare ${esc(speciesById(o.wantSpecies!).name)}</span>`;
              else action = `<button class="btn btn-gold btn-sm" data-buy="${o.id}" type="button">Buy</button>`;
              return `<div class="offer"><img src="${thumb(s.id)}" alt="" />
                <div><b>${esc(s.name)}</b> <span class="tag">${s.rarity}</span><br/><small>by ${esc(o.sellerName)} · ${want}</small></div>
                ${action}</div>`;
            })
            .join('')
        : '<div class="empty"><span>🏪</span><p>No offers yet. Post the first one!</p></div>'
    }</div>
    ${
      me
        ? tradable.length
          ? `<form class="form-grid" id="offer-form">
              <b>Post an offer</b>
              <label>Your critter
                <select name="critter">${tradable.map((c) => `<option value="${c.id}">${esc(speciesById(c.species).name)} (#${c.id})</option>`).join('')}</select>
              </label>
              <div class="row">
                <label class="row"><input type="radio" name="kind" value="swap" checked style="width:auto" /> Swap</label>
                <label class="row"><input type="radio" name="kind" value="sale" style="width:auto" /> Sell for ${esc(BRAND.ticker)}</label>
              </div>
              <label data-for="swap">Species you want
                <select name="want">${SPECIES.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>
              </label>
              <label data-for="sale" hidden>Price in ${esc(BRAND.ticker)} <input name="price" type="number" min="1" step="any" placeholder="1000" /></label>
              <label data-for="sale" hidden>Your Solana wallet (receives payment) <input name="wallet" placeholder="Paste address"  /></label>
              <div class="row"><button class="btn btn-primary" type="submit">Post offer</button><span class="err"></span></div>
            </form>`
          : '<p class="tiny">Catch a duplicate of any species to post an offer. Your first of each species stays locked.</p>'
        : '<p class="tiny">Enter the game to post or take offers.</p>'
    }`;

  const refresh = async () => renderMarket(body, await api.offers(), await loadMe());

  $$('[data-cancel]', body).forEach((b) =>
    b.addEventListener('click', async () => {
      await api.cancelOffer(Number(b.dataset.cancel)).catch(() => {});
      void refresh();
    }),
  );
  $$('[data-swap]', body).forEach((b) =>
    b.addEventListener('click', async () => {
      const o = offers.find((x) => x.id === Number(b.dataset.swap))!;
      try {
        await api.acceptOffer(o.id, { critterId: canSwap(o.wantSpecies)!.id });
        void refresh();
      } catch (e) {
        alert((e as Error).message);
      }
    }),
  );
  $$('[data-buy]', body).forEach((b) =>
    b.addEventListener('click', () => {
      const o = offers.find((x) => x.id === Number(b.dataset.buy))!;
      openBuy(body, o, refresh);
    }),
  );

  const form = $<HTMLFormElement>('#offer-form', body);
  if (form) {
    const sync = () => {
      const kind = (form.elements.namedItem('kind') as RadioNodeList).value;
      $$('[data-for]', form).forEach((el) => (el.hidden = el.dataset.for !== kind));
    };
    form.addEventListener('change', sync);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const kind = fd.get('kind') as 'swap' | 'sale';
      try {
        await api.postOffer({
          critterId: Number(fd.get('critter')),
          kind,
          wantSpecies: kind === 'swap' ? Number(fd.get('want')) : undefined,
          price: kind === 'sale' ? Number(fd.get('price')) : undefined,
          wallet: kind === 'sale' ? String(fd.get('wallet')) : undefined,
        });
        void refresh();
      } catch (err) {
        errorBox(form, (err as Error).message);
      }
    });
  }
}

function openBuy(body: HTMLElement, o: Offer, refresh: () => Promise<void>): void {
  const s = speciesById(o.species);
  body.innerHTML = `<h2>Buy ${esc(s.name)}</h2>
    <div class="modal-hero"><img src="${thumb(s.id)}" width="120" alt="" /></div>
    <ol class="steps">
      <li>Send <b>${o.price} ${esc(BRAND.ticker)}</b> from any wallet to the seller:<br/><code>${esc(o.sellerWallet ?? '')}</code>
        ${o.sellerWallet ? `<a href="${accountLink(o.sellerWallet)}" target="_blank" rel="noopener">Solscan ↗</a>` : ''}</li>
      <li>Paste the transaction signature below. We check it on-chain and hand over the critter.</li>
    </ol>
    <form class="form-grid" id="buy-form">
      <label>Transaction signature <input name="sig" required placeholder="5h3…" /></label>
      <div class="row"><button class="btn btn-gold" type="submit">Confirm purchase</button><button class="btn btn-ghost" type="button" id="buy-back">Back</button><span class="err"></span></div>
    </form>`;
  $('#buy-back', body).addEventListener('click', () => void refresh());
  $<HTMLFormElement>('#buy-form', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    const sig = String(new FormData(e.target as HTMLFormElement).get('sig'));
    try {
      await api.acceptOffer(o.id, { txSig: sig });
      void refresh();
    } catch (err) {
      errorBox(body, (err as Error).message);
    }
  });
}

// ── Waitlist + claim ─────────────────────────────────────────────────

export function openWaitlistJoined(r: { position: number; total: number; bonus: number; sameNetwork: boolean }, onClose?: AfterClose): void {
  const body = openModal(
    `<div class="modal-hero">
      <span style="font-size:3rem">🎟️</span>
      <h2>Waitlist joined</h2>
      <div class="big">#${r.position}</div>
      <p>of <b>${r.total}</b> trainers · <span class="tag pink">Launching soon</span></p>
      <p>Your early bonus: <b>${r.bonus} golden balls</b> land in your bag the first time you play after launch.</p>
      <p class="tiny">${r.sameNetwork ? 'This network already holds a spot, so you share it. ' : ''}Your spot is saved for this network + browser. Coming back never moves you down.</p>
      <button class="btn btn-primary btn-lg" type="button" id="wl-go">Jump into the lobby</button>
    </div>`,
    onClose,
  );
  $('#wl-go', body).addEventListener('click', () => closeModal());
}

/** Message prefilled in the X DM so the winner only has to add their address. */
function dmText(claim: MyClaim): string {
  return `Hi ${BRAND.claimContactX}! I won the real ${claim.prize.name} card on ${BRAND.name}. My claim code is ${claim.code}. Shipping details: `;
}

function claimBlock(claim: MyClaim): string {
  const p = claim.prize;
  const status =
    p.status === 'shipped' ? '<span class="tag green">📦 Shipped</span>' : claim.verified ? '<span class="tag blue">✓ Verified, shipping soon</span>' : '<span class="tag gold">Waiting for your DM</span>';
  return `<div class="claim-card">
      <img src="${esc(p.image)}" alt="${esc(p.name)}" />
      <div class="claim-info">
        <div class="row"><b>${esc(p.name)}</b><span class="tag ${p.tier === 'S' ? 'gold' : p.tier === 'A' ? 'pink' : 'blue'}">Tier ${p.tier}</span>${status}</div>
        <span class="tiny">${esc([p.set, p.grade].filter(Boolean).join(' · ') || 'Real card')}</span>
        <code class="claim-code">${esc(claim.code)}</code>
        <div class="row">
          <button class="btn btn-sm" type="button" data-copy="${esc(claim.code)}">Copy code</button>
          <a class="btn btn-sm btn-primary" href="https://x.com/messages/compose?text=${encodeURIComponent(dmText(claim))}" target="_blank" rel="noopener">Open X DM</a>
        </div>
      </div>
    </div>`;
}

function bindCopy(root: HTMLElement): void {
  $$('[data-copy]', root).forEach((b) =>
    b.addEventListener('click', () => {
      void navigator.clipboard?.writeText(b.dataset.copy!).then(() => {
        b.textContent = 'Copied!';
        setTimeout(() => (b.textContent = 'Copy code'), 1400);
      });
    }),
  );
}

/** Shown to the winner the moment their golden ball wins. */
export function openPrizeWon(claim: MyClaim, onClose?: AfterClose): void {
  const body = openModal(
    `<div class="modal-hero">
      <span class="ico yellow" style="width:64px;height:64px;font-size:2rem">🎉</span>
      <h2>You won a real card!</h2>
      <p>Your golden ball caught the real <b>${esc(claim.prize.name)}</b>. This is a one-time claim code, so keep it private.</p>
    </div>
    ${claimBlock(claim)}
    <ol class="claim-steps">
      <li>DM <b>${esc(BRAND.claimContactX)}</b> on X with this code and your shipping details (name, address, country).</li>
      <li>We check the code against the winning throw and mark it verified.</li>
      <li>We mail the card and send you the tracking number.</li>
    </ol>
    <p class="tiny">Lost this window? Open <b>🎁 My cards</b> in the game any time from this browser.</p>`,
    onClose,
  );
  bindCopy(body);
}

/** Every card this browser's trainer has won, with codes and shipping status. */
export async function openMyClaims(onClose?: AfterClose): Promise<void> {
  const body = openModal('<h2>🎁 My cards</h2><p>Loading…</p>', onClose);
  const me = await loadMe();
  const claims = me?.you.claims ?? [];
  body.innerHTML = `<h2>🎁 My cards</h2>
    ${
      claims.length
        ? `<p>DM <b>${esc(BRAND.claimContactX)}</b> on X with a claim code and your shipping details. Each code can be redeemed once.</p>${claims.map(claimBlock).join('')}`
        : '<p>No real cards yet. Golden balls that hit the roaming card slab are rolls to win it.</p>'
    }`;
  bindCopy(body);
}

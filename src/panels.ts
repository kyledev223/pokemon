import { BRAND } from '../shared/brand';
import { REGIONS, REGION_LABEL, SPECIES, speciesById, type Region } from '../shared/species';
import type { YouInfo } from '../shared/protocol';
import { api, type CollectionItem, type Me, type Offer } from './api';
import { thumb } from './thumbs';
import { $, $$, accountLink, closeModal, esc, openModal, shortSig } from './ui';

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

export async function openDex(onClose?: AfterClose): Promise<void> {
  const body = openModal('<h2>📖 Dex</h2><p>Loading…</p>', onClose);
  const me = await loadMe();
  const owned = new Map<number, number>();
  for (const c of me?.collection ?? []) owned.set(c.species, (owned.get(c.species) ?? 0) + 1);
  let region: Region = 'base';
  const render = () => {
    const list = SPECIES.filter((s) => s.region === region);
    const got = list.filter((s) => owned.has(s.id)).length;
    const total = SPECIES.filter((s) => owned.has(s.id)).length;
    body.innerHTML = `
      <h2>📖 Dex</h2>
      <p>${me ? `You've caught <b>${total}/${SPECIES.length}</b> species. Complete every page first to win the mystery Master card.` : 'Enter the game to start your dex.'}</p>
      <div class="tabs">${REGIONS.map((r) => {
        const n = SPECIES.filter((s) => s.region === r);
        return `<button type="button" data-region="${r}" class="${r === region ? 'active' : ''}">${REGION_LABEL[r]} ${n.filter((s) => owned.has(s.id)).length}/${n.length}</button>`;
      }).join('')}</div>
      <p class="tiny">${regionBlurb(region)} · ${got}/${list.length} caught</p>
      <div class="dex-grid">${list
        .map((s) => {
          const n = owned.get(s.id) ?? 0;
          return `<div class="dex-cell ${n ? '' : 'missing'} ${s.rarity === 'legendary' ? 'legendary' : ''}">
            <img src="${thumb(s.id)}" alt="" loading="lazy" />
            <span>${n ? esc(s.name) : '???'}</span>
            <small>#${String(s.id).padStart(3, '0')} · ${s.rarity}${n > 1 ? ` · ×${n}` : ''}</small>
          </div>`;
        })
        .join('')}</div>`;
    $$('[data-region]', body).forEach((b) =>
      b.addEventListener('click', () => {
        region = b.dataset.region as Region;
        render();
      }),
    );
  };
  render();
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
  const body = openModal('<h2>⚔️ Arena</h2><p>Loading…</p>', onClose);
  const me = await loadMe();
  if (!me || !me.collection.length) {
    body.innerHTML = `<h2>⚔️ Arena</h2><p>Catch a few critters with pink orbs first, then bring up to three of them here for quick duels against wandering trainers. Wins climb the Ranks board.</p>`;
    return;
  }
  const picked = new Set<number>();
  const unique = dedupeBySpecies(me.collection);
  const render = () => {
    body.innerHTML = `<h2>⚔️ Arena</h2>
      <p>Pick up to 3 critters. Elements matter: leaf › tide › ember › leaf, spark › breeze › stone › spark.</p>
      <div class="dex-grid">${unique
        .map((c) => {
          const s = speciesById(c.species);
          return `<button type="button" class="dex-cell ${picked.has(c.id) ? 'picked' : ''}" data-id="${c.id}">
            <img src="${thumb(s.id)}" alt="" /><span>${esc(s.name)}</span><small>${s.element}</small></button>`;
        })
        .join('')}</div>
      <div class="row" style="margin-top:14px"><button class="btn btn-primary" id="duel-go" type="button" ${picked.size ? '' : 'disabled'}>⚔️ Find a duel</button><span class="err"></span></div>
      <div id="duel-out"></div>`;
    $$('[data-id]', body).forEach((b) =>
      b.addEventListener('click', () => {
        const id = Number(b.dataset.id);
        if (picked.has(id)) picked.delete(id);
        else if (picked.size < 3) picked.add(id);
        render();
      }),
    );
    $('#duel-go', body).addEventListener('click', async () => {
      try {
        const r = await api.duel([...picked]);
        const out = $('#duel-out', body);
        out.innerHTML = `<div class="row" style="margin-top:12px">
            <span>${r.you.map((id) => `<img src="${thumb(id)}" width="44" alt="${esc(speciesById(id).name)}" />`).join('')}</span>
            <b>vs</b>
            <span>${r.foe.map((id) => `<img src="${thumb(id)}" width="44" alt="${esc(speciesById(id).name)}" />`).join('')}</span>
            <span class="tag">${esc(r.foeName)}</span>
          </div><div class="duel-log" id="duel-log"></div>`;
        const log = $('#duel-log', out);
        r.log.forEach((line, i) =>
          setTimeout(() => {
            const p = document.createElement('p');
            p.textContent = line;
            if (i === r.log.length - 1) p.innerHTML = `<b class="${r.won ? 'ok' : ''}">${esc(line)}</b>`;
            log.append(p);
            log.scrollTop = log.scrollHeight;
          }, i * 140),
        );
      } catch (e) {
        errorBox(body, (e as Error).message);
      }
    });
  };
  render();
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
              <label data-for="sale" hidden>Your Solana wallet (receives payment) <input name="wallet" placeholder="Paste address" value="${esc(me.you.wallet ?? '')}" /></label>
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

export function openClaim(cardName: string, you: YouInfo | null, onDone?: (you: YouInfo) => void, onClose?: AfterClose): void {
  const body = openModal(
    `<div class="modal-hero">
      <span style="font-size:3rem">🎉</span>
      <h2>You caught ${esc(cardName)}!</h2>
      <p>${
        you?.wallet
          ? `It's on its way to <code>${esc(shortSig(you.wallet))}</code>. You can change the address below if needed.`
          : 'Paste any Solana wallet address to receive the real card. Read-only: we never ask you to connect or sign anything.'
      }</p>
      <form class="form-grid" id="claim-form" style="width:100%">
        <label>Solana wallet address <input name="wallet" required placeholder="Paste address" value="${esc(you?.wallet ?? '')}" /></label>
        <div class="row"><button class="btn btn-gold" type="submit">Send my card</button><span class="err"></span></div>
      </form>
    </div>`,
    onClose,
  );
  $<HTMLFormElement>('#claim-form', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    const wallet = String(new FormData(e.target as HTMLFormElement).get('wallet')).trim();
    try {
      const r = await api.setWallet(wallet);
      onDone?.(r.you);
      body.innerHTML = `<div class="modal-hero"><span style="font-size:3rem">🃏</span><h2>On its way!</h2><p>The card is being sent to <code>${esc(wallet)}</code>. It'll appear in the Real cards gallery with the transfer receipt.</p></div>`;
    } catch (err) {
      errorBox(body, (err as Error).message);
    }
  });
}


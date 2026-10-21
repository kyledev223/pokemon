import './styles.css';
import './admin.css';
import { $, $$, countdown, esc, pct, txLink, usd } from './ui';
import { TIERS, type Settings, type Tier } from '../shared/prizes';

// Operator console. Every action is a call to /api/admin/*, authenticated with the
// admin password in the x-admin-token header (kept in sessionStorage for this tab).

const KEY = 'cove.admin';
let tokenValue = sessionStorage.getItem(KEY) ?? '';

class AuthError extends Error {}

async function call<T = any>(method: string, path: string, body?: unknown, raw?: { data: Blob; type: string }): Promise<T> {
  const headers: Record<string, string> = { 'x-admin-token': tokenValue };
  if (raw) headers['content-type'] = raw.type;
  else if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`/api/admin/${path}`, { method, headers, body: raw ? raw.data : body !== undefined ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) throw new AuthError(json.error ?? 'Wrong admin password.');
  if (res.status === 429) throw new Error(json.error ?? 'Too many attempts. Wait a minute.');
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json as T;
}

// ── Small render helpers ─────────────────────────────────────────────

type Col = [key: string, label: string, fmt: (v: any, row: any) => string];

const table = (rows: any[], cols: Col[], rowClass: (r: any) => string = () => '') =>
  rows.length
    ? `<table><thead><tr>${cols.map((c) => `<th>${esc(c[1])}</th>`).join('')}</tr></thead><tbody>${rows
        .map((r) => `<tr class="${rowClass(r)}">${cols.map(([k, , f]) => `<td>${f(r[k], r)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`
    : '<p class="tiny admin-empty">Nothing yet.</p>';

const when = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '–');
const time = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleTimeString() : '–');
const STATUS_TAG: Record<string, string> = { available: 'green', in_play: 'pink', won: 'gold', shipped: 'blue' };
const TIER_TAG: Record<Tier, string> = { S: 'gold', A: 'pink', B: 'blue' };
const tierTag = (t: Tier) => `<span class="tag ${TIER_TAG[t]}">Tier ${esc(t)}</span>`;
const statusTag = (s: string) => `<span class="tag ${STATUS_TAG[s] ?? ''}">${esc(s.replace('_', ' '))}</span>`;
const resultTag = (r: string) => {
  const tone = r === 'hit' ? 'green' : r.startsWith('rejected') ? 'orange' : r === 'pending' ? 'purple' : '';
  return `<span class="tag ${tone}">${esc(r)}</span>`;
};
const thumb = (src: string, cls = 'admin-thumb') => `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" />`;

function flash(text: string, ok = false): void {
  const el = $('#admin-msg');
  el.textContent = text;
  el.classList.toggle('ok', ok);
  el.classList.toggle('err', !ok);
  clearTimeout(Number(el.dataset.t));
  el.dataset.t = String(setTimeout(() => (el.textContent = ''), ok ? 3000 : 8000));
}

/** Runs an admin action, reports errors, then refreshes whatever it touched. */
async function act(fn: () => Promise<unknown>, after: () => Promise<void> = refreshState, okText?: string): Promise<boolean> {
  try {
    await fn();
    if (okText) flash(okText, true);
    await after();
    return true;
  } catch (e) {
    if (e instanceof AuthError) return showLogin(e.message), false;
    flash((e as Error).message);
    return false;
  }
}

// ── Login / tabs ─────────────────────────────────────────────────────

function showLogin(msg = ''): void {
  $('#admin-ui').hidden = true;
  $('#login').hidden = false;
  $('#admin-err').textContent = msg;
  sessionStorage.removeItem(KEY);
}

$<HTMLFormElement>('#login').addEventListener('submit', async (e) => {
  e.preventDefault();
  tokenValue = $<HTMLInputElement>('#admin-token').value;
  try {
    await refreshState();
    sessionStorage.setItem(KEY, tokenValue);
    $('#admin-ui').hidden = false;
    $('#login').hidden = true;
    $('#admin-err').textContent = '';
    void loadTab(currentTab);
  } catch (err) {
    $('#admin-err').textContent = (err as Error).message;
  }
});

$('#logout').addEventListener('click', () => {
  tokenValue = '';
  showLogin();
});

type Tab = 'overview' | 'catalog' | 'schedule' | 'claims' | 'abuse';
let currentTab: Tab = 'overview';

$$('[data-tab]').forEach((b) =>
  b.addEventListener('click', () => {
    currentTab = b.dataset.tab as Tab;
    $$('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
    $$('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== currentTab));
    void loadTab(currentTab);
  }),
);

async function loadTab(tab: Tab): Promise<void> {
  try {
    if (tab === 'overview') await refreshState();
    if (tab === 'catalog') await loadCatalog();
    if (tab === 'schedule') await loadSettings();
    if (tab === 'claims') await loadClaims();
    if (tab === 'abuse') await Promise.all([refreshState(), loadThrows()]);
  } catch (e) {
    if (e instanceof AuthError) showLogin(e.message);
    else flash((e as Error).message);
  }
}

// ── Overview + card in play + fee claims + abuse lists (from /state) ──

let state: any = null;

async function refreshState(): Promise<void> {
  state = await call('GET', 'state');
  const e = state.economy;
  const next = state.nextRelease as { at: number; tier: Tier } | null;
  $('#admin-tiles').innerHTML = [
    ['Status', e.launched ? 'Live' : 'Pre-launch'],
    ['Online', e.online],
    ['Players', state.players],
    ['Waitlist', state.waitlist],
    ['Balls on island', state.balls],
    ['Cards won', e.cardsCaught],
    ['Prizes left', e.prizesLeft],
    ['Next release', next ? `${next.tier} · ${next.at <= Date.now() ? 'due now' : countdown(next.at - Date.now())}` : 'manual only'],
    ['Gold / player / h', e.goldPerHour],
    ['Providers', `${state.providers.chain} / ${state.providers.cards}`],
    ...(state.vaultAutoBuy ? [['Vault', usd(state.vaultUsd)]] : []),
    ['Master card', state.masterWinner?.name ?? 'unclaimed'],
  ]
    .map(([k, v]) => `<div class="tile"><span class="tile-label">${esc(k)}</span><b class="tile-value admin-tile-value">${esc(v)}</b></div>`)
    .join('');
  $('#vault-btn').hidden = !state.vaultAutoBuy;
  renderCard();
  $('#admin-fees').innerHTML = table(state.feeClaims, [
    ['created_at', 'When', time],
    ['usd', 'USD', (v) => usd(v)],
    ['balls', 'Balls', (v) => esc(v)],
    ['signature', 'Tx', (v) => txLink(v)],
  ]);
  renderFlags(state.flags);
  if (!throwFilterActive) renderThrows(state.recentThrows);
}

function renderCard(): void {
  const c = state.card;
  const box = $('#admin-card');
  if (!c) {
    box.innerHTML = '<p class="muted">No card on the island.</p>';
    return;
  }
  const m = state.cardMotion;
  box.innerHTML = `<div class="admin-card-row">
      ${thumb(c.image, 'admin-photo')}
      <div class="admin-kv">
        <div><b class="admin-card-name">${esc(c.name)}</b> ${tierTag(c.tier)}</div>
        <div class="tiny">${esc(c.set || 'no set')} · ${esc(c.grade || 'no grade')}</div>
        <div>Hits <b>${esc(c.throws)}</b> · next odds <b>${pct(c.nextOdds)}</b> · cap ${pct(c.odds.cap)}</div>
        <div>Release <code>${esc(c.id)}</code> · out since ${when(c.releasedAt)}</div>
        <div class="tiny">Commitment <code>${esc(c.commitment)}</code></div>
        ${m ? `<div>Motion ${m.fleeing ? '<span class="tag orange">fleeing</span>' : '<span class="tag">wandering</span>'} at (${m.x.toFixed(0)}, ${m.z.toFixed(0)}) · teleports in ${countdown(m.nextTeleportAt - Date.now())}</div>` : ''}
        <div class="row">
          <button class="btn btn-sm" type="button" id="card-teleport">🌀 Teleport now</button>
          <button class="btn btn-sm admin-danger" type="button" id="card-recall">↩️ Recall</button>
        </div>
      </div>
    </div>`;
  $('#card-teleport').addEventListener('click', () => void act(() => call('POST', 'teleport'), refreshState, 'Card teleported.'));
  $('#card-recall').addEventListener('click', () => {
    if (!confirm(`Recall ${c.name}? Its secret is revealed on the Verify page and the card goes back on the shelf (a later release gets a new commitment).`)) return;
    void act(() => call('POST', 'recall'), refreshAll, 'Card recalled.');
  });
}

const actions: Record<string, () => Promise<unknown>> = {
  launch: () => call('POST', 'launch', { launched: true }),
  unlaunch: () => call('POST', 'launch', { launched: false }),
  claim: () => call('POST', 'claim'),
  vault: () => call('POST', 'vault', { addUsd: 10 }),
  balls: () => call('POST', 'balls', { n: 20 }),
  event: () => call('POST', 'event', {}),
};
$$('[data-act]').forEach((b) =>
  b.addEventListener('click', () => {
    if (b.dataset.act === 'unlaunch' && !confirm('Put the island back into pre-launch?')) return;
    void act(actions[b.dataset.act!], refreshState, 'Done.');
  }),
);

async function refreshAll(): Promise<void> {
  await refreshState();
  if (currentTab === 'catalog') await loadCatalog();
}

// ── Catalog ──────────────────────────────────────────────────────────

let prizes: any[] = [];
let editing: string | null = null;

async function loadCatalog(): Promise<void> {
  prizes = await call('GET', 'prizes');
  renderCatalog();
}

function renderCatalog(): void {
  const box = $('#admin-catalog');
  box.innerHTML = TIERS.map((tier) => {
    const rows = prizes.filter((p) => p.tier === tier);
    return `<table class="admin-catalog">
      <thead><tr><th colspan="9">${tierTag(tier)} <span class="tiny">${rows.filter((r) => r.status === 'available').length} available of ${rows.length}</span></th></tr>
      <tr><th>Photo</th><th>Card</th><th>Tier</th><th>Status</th><th>Winner</th><th>Released</th><th>Won</th><th>Releases</th><th></th></tr></thead>
      <tbody>${rows.length ? rows.map(prizeRow).join('') : '<tr><td colspan="9" class="tiny">No cards in this tier.</td></tr>'}</tbody>
    </table>`;
  }).join('');

  $$('[data-edit]', box).forEach((b) =>
    b.addEventListener('click', () => {
      editing = editing === b.dataset.edit ? null : b.dataset.edit!;
      renderCatalog();
    }),
  );
  $$<HTMLFormElement>('form[data-save]', box).forEach((f) =>
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      const body = { name: fd.get('name'), set: fd.get('set'), grade: fd.get('grade'), tier: fd.get('tier') };
      void act(
        () => call('POST', `prizes/${encodeURIComponent(f.dataset.save!)}`, body),
        async () => {
          editing = null;
          await loadCatalog();
        },
        'Card saved.',
      );
    }),
  );
  $$<HTMLInputElement>('input[data-photo]', box).forEach((input) =>
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return flash('Upload a JPEG, PNG or WebP photo.');
      if (file.size > 6 * 1024 * 1024) return flash('Photo must be under 6 MB.');
      void act(() => call('PUT', `prizes/${encodeURIComponent(input.dataset.photo!)}/photo`, undefined, { data: file, type: file.type }), loadCatalog, 'Photo uploaded.');
    }),
  );
  $$('[data-release]', box).forEach((b) =>
    b.addEventListener('click', () => {
      const p = prizes.find((x) => x.id === b.dataset.release);
      if (!p) return;
      const msg = p.tier === 'S' ? `Release the Tier S ${p.name} now? This is one of your rarest cards.` : `Release ${p.name} onto the island now?`;
      if (!confirm(msg)) return;
      void act(() => call('POST', `prizes/${encodeURIComponent(p.id)}/release`), refreshAll, `${p.name} released.`);
    }),
  );
  $$('[data-delete]', box).forEach((b) =>
    b.addEventListener('click', () => {
      const p = prizes.find((x) => x.id === b.dataset.delete);
      if (!p || !confirm(`Delete ${p.name} from the catalog? This can't be undone.`)) return;
      void act(() => call('POST', `prizes/${encodeURIComponent(p.id)}/delete`), loadCatalog, 'Card deleted.');
    }),
  );
}

function prizeRow(p: any): string {
  const tierOpts = TIERS.map((t) => `<option ${t === p.tier ? 'selected' : ''}>${t}</option>`).join('');
  const editRow =
    editing === p.id
      ? `<tr class="admin-edit-row"><td colspan="9">
          <form class="row admin-edit" data-save="${esc(p.id)}">
            <label>Name <input name="name" value="${esc(p.name)}" required maxlength="60" /></label>
            <label>Set <input name="set" value="${esc(p.set_name)}" maxlength="60" /></label>
            <label>Grade <input name="grade" value="${esc(p.grade)}" maxlength="40" /></label>
            <label>Tier <select name="tier" ${p.status === 'in_play' ? 'disabled' : ''}>${tierOpts}</select></label>
            <button class="btn btn-primary btn-sm" type="submit">Save</button>
          </form>
        </td></tr>`
      : '';
  const canDelete = p.status === 'available' && !p.releases;
  return `<tr>
      <td>${thumb(p.image)}</td>
      <td><b>${esc(p.name)}</b><div class="tiny">${esc(p.set_name || '—')} · ${esc(p.grade || '—')}</div></td>
      <td>${tierTag(p.tier)}</td>
      <td>${statusTag(p.status)}</td>
      <td>${p.winner_name ? esc(p.winner_name) : '<span class="muted">–</span>'}</td>
      <td>${when(p.released_at)}</td>
      <td>${when(p.won_at)}</td>
      <td>${esc(p.releases)}</td>
      <td><div class="admin-actions">
        <button class="btn btn-sm" type="button" data-edit="${esc(p.id)}">${editing === p.id ? 'Close' : 'Edit'}</button>
        <label class="btn btn-sm admin-file">📷 Photo<input type="file" accept="image/jpeg,image/png,image/webp" data-photo="${esc(p.id)}" /></label>
        ${p.status === 'available' ? `<button class="btn btn-gold btn-sm" type="button" data-release="${esc(p.id)}">Release now</button>` : ''}
        ${canDelete ? `<button class="btn btn-sm admin-danger" type="button" data-delete="${esc(p.id)}">Delete</button>` : ''}
      </div></td>
    </tr>${editRow}`;
}

$<HTMLFormElement>('#add-prize').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.target as HTMLFormElement;
  const fd = new FormData(f);
  void act(
    () => call('POST', 'prizes', { name: fd.get('name'), set: fd.get('set'), grade: fd.get('grade'), tier: fd.get('tier') }),
    async () => {
      f.reset();
      await loadCatalog();
    },
    'Card added.',
  );
});

// ── Schedule + odds ──────────────────────────────────────────────────

/** Fractions ↔ percent strings without float noise (0.00005 → "0.005"). */
const toPct = (v: number) => String(Number((v * 100).toPrecision(10)));
const fromPct = (s: FormDataEntryValue | null) => Number(s) / 100;

async function loadSettings(): Promise<void> {
  const [s, st] = await Promise.all([call<Settings>('GET', 'settings'), call('GET', 'state')]);
  state = st;
  const form = $<HTMLFormElement>('#settings-form');
  form.innerHTML = `
    <b>Per-tier odds and release schedule</b>
    <p class="tiny">Odds per golden-ball hit: start %, plus "pts" (percentage points) after every miss, never above the cap. A release snapshots these odds, so changes apply to the next card.</p>
    <div class="table-wrap"><table class="admin-settings">
      <thead><tr><th>Tier</th><th>Start %</th><th>+ pts per miss</th><th>Cap %</th><th>Auto-release every (h)</th><th>Manual only</th><th>≈ hits to catch</th><th>On shelf</th></tr></thead>
      <tbody>${TIERS.map((t) => {
        const o = s.odds[t];
        const h = s.everyHours[t];
        const info = st.tiers?.[t];
        return `<tr>
          <td>${tierTag(t)}</td>
          <td><input name="${t}-base" type="number" step="any" min="0" value="${toPct(o.base)}" required /></td>
          <td><input name="${t}-step" type="number" step="any" min="0" value="${toPct(o.step)}" required /></td>
          <td><input name="${t}-cap" type="number" step="any" min="0" max="100" value="${toPct(o.cap)}" required /></td>
          <td><input name="${t}-hours" type="number" step="any" min="0" value="${h ?? ''}" ${h === null ? 'disabled' : ''} /></td>
          <td><input name="${t}-manual" type="checkbox" ${h === null ? 'checked' : ''} /></td>
          <td>${info ? `~${Math.round(info.expectedHits)}` : '–'}</td>
          <td>${info ? esc(info.available) : '–'}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
    <div class="row">
      <label>Golden balls per player per hour <input name="goldPerHour" type="number" min="1" max="1000" step="1" value="${s.goldPerHour}" required /></label>
      <label>Card teleports every (minutes) <input name="teleportMinutes" type="number" min="0.5" max="120" step="any" value="${s.teleportMinutes}" required /></label>
    </div>
    <div class="row"><button class="btn btn-primary" type="submit">Save settings</button><span class="err" id="settings-err"></span></div>`;
  TIERS.forEach((t) => {
    const box = form.elements.namedItem(`${t}-manual`) as HTMLInputElement;
    const hours = form.elements.namedItem(`${t}-hours`) as HTMLInputElement;
    box.addEventListener('change', () => {
      hours.disabled = box.checked;
      if (!box.checked && !hours.value) hours.value = t === 'A' ? '168' : '24';
    });
  });
}

$<HTMLFormElement>('#settings-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target as HTMLFormElement;
  const fd = new FormData(form);
  const odds = {} as Settings['odds'];
  const everyHours = {} as Settings['everyHours'];
  for (const t of TIERS) {
    odds[t] = { base: fromPct(fd.get(`${t}-base`)), step: fromPct(fd.get(`${t}-step`)), cap: fromPct(fd.get(`${t}-cap`)) };
    everyHours[t] = fd.get(`${t}-manual`) ? null : Number(fd.get(`${t}-hours`));
  }
  const body: Settings = { odds, everyHours, goldPerHour: Number(fd.get('goldPerHour')), teleportMinutes: Number(fd.get('teleportMinutes')) };
  $('#settings-err').textContent = '';
  void act(
    () => call('POST', 'settings', body),
    loadSettings,
    'Settings saved.',
  ).then((ok) => {
    if (!ok) $('#settings-err').textContent = $('#admin-msg').textContent ?? '';
  });
});

// ── Claims ───────────────────────────────────────────────────────────

const codeInput = $<HTMLInputElement>('#claim-lookup input[name="code"]');
codeInput.addEventListener('input', () => {
  const pos = codeInput.selectionStart;
  codeInput.value = codeInput.value.toUpperCase();
  codeInput.setSelectionRange(pos, pos);
});

$<HTMLFormElement>('#claim-lookup').addEventListener('submit', (e) => {
  e.preventDefault();
  void lookupClaim(codeInput.value.trim());
});

async function loadClaims(): Promise<void> {
  const rows = await call<any[]>('GET', 'claims');
  $('#claims-list').innerHTML = table(
    rows,
    [
      ['code', 'Code', (v) => `<button class="admin-link" type="button" data-code="${esc(v)}"><code>${esc(v)}</code></button>`],
      ['name', 'Card', (v, r) => `${esc(v)} ${tierTag(r.tier)}`],
      ['winnerName', 'Winner', (v) => esc(v ?? '?')],
      ['wonAt', 'Won', when],
      ['status', 'Status', (_v, r) => claimStatus(r)],
      ['tracking', 'Tracking', (v) => (v ? `<code>${esc(v)}</code>` : '–')],
    ],
  );
  $$('[data-code]', $('#claims-list')).forEach((b) =>
    b.addEventListener('click', () => {
      codeInput.value = b.dataset.code!;
      void lookupClaim(b.dataset.code!);
    }),
  );
}

function claimStatus(r: { status: string; verifiedAt: number | null }): string {
  if (r.status === 'shipped') return '<span class="tag blue">Shipped</span>';
  if (r.verifiedAt) return '<span class="tag green">Verified</span>';
  return '<span class="tag gold">Won · unredeemed</span>';
}

async function lookupClaim(code: string): Promise<void> {
  const box = $('#claim-detail');
  box.innerHTML = '<p class="tiny">Looking up…</p>';
  let c: any;
  try {
    c = await call('GET', `claims/${encodeURIComponent(code)}`);
  } catch (e) {
    if (e instanceof AuthError) return showLogin(e.message);
    box.innerHTML = `<div class="card admin-card admin-alert"><b>${esc((e as Error).message)}</b></div>`;
    return;
  }
  const p = c.prize;
  const w = c.winner;
  const r = c.release;
  const status = p.status === 'shipped' ? 'shipped' : c.redeemed ? 'verified' : 'won';
  box.innerHTML = `<div class="card admin-card">
    <div class="admin-card-row">
      ${thumb(p.image, 'admin-photo')}
      <div class="admin-kv">
        <div><code class="admin-code">${esc(c.code)}</code> ${claimStatus({ status: p.status, verifiedAt: p.claim_verified_at })}</div>
        <div><b class="admin-card-name">${esc(p.name)}</b> ${tierTag(p.tier)} <span class="tiny">${esc(p.set_name || '—')} · ${esc(p.grade || '—')}</span></div>
        <div>Won ${when(c.wonAt)} on hit <b>#${c.winningThrow !== null ? c.winningThrow + 1 : '?'}</b>${p.claim_verified_at ? ` · redeemed ${when(p.claim_verified_at)}` : ''}${p.shipped_at ? ` · shipped ${when(p.shipped_at)}` : ''}</div>
        ${p.tracking ? `<div>Tracking <code>${esc(p.tracking)}</code></div>` : ''}
        ${
          w
            ? `<div>Winner <b>${esc(w.name)}</b> <code>${esc(w.id)}</code> · joined ${when(w.joinedAt)} · ${esc(w.goldHits)} golden hits ${w.banned ? '<span class="tag orange">banned</span>' : ''} ${w.flags.length ? `<span class="tag orange">${w.flags.length} flag${w.flags.length === 1 ? '' : 's'}</span>` : '<span class="tag green">no flags</span>'}</div>`
            : '<div class="muted">Winner account not found.</div>'
        }
        <div class="row admin-claim-actions">
          ${status === 'won' ? '<button class="btn btn-primary btn-sm" type="button" id="claim-verify">✅ Mark verified (redeem)</button>' : ''}
          ${
            status === 'verified'
              ? `<form class="row" id="claim-ship"><label>Tracking number <input name="tracking" required maxlength="120" /></label><button class="btn btn-gold btn-sm" type="submit">📦 Mark shipped</button></form>`
              : ''
          }
        </div>
        <div class="err admin-claim-err" id="claim-err"></div>
      </div>
    </div>
    ${w?.flags.length ? `<h4>Winner flags</h4><div class="table-wrap">${flagTable(w.flags, false)}</div>` : ''}
    ${
      r
        ? `<h4>Release</h4>
          <div class="admin-kv tiny">
            <div>Release id <code>${esc(r.id)}</code> · out ${when(r.releasedAt)} → ${when(r.endedAt)}</div>
            <div>Odds start ${pct(r.odds.base)} · +${pct(r.odds.step)} per miss · cap ${pct(r.odds.cap)}</div>
            <div>Commitment <code>${esc(r.commitment)}</code> ${r.memoSig ? txLink(r.memoSig, 'memo ↗') : ''}</div>
            <div>Secret <code>${esc(r.secret)}</code></div>
          </div>`
        : ''
    }
    <h4>Rolled hits (${c.throws.length})</h4>
    <div class="table-wrap">${table(
      c.throws,
      [
        ['idx', '#', (v) => String(v + 1)],
        ['player_name', 'Trainer', (v, row) => `${esc(v)}${row.idx === c.winningThrow ? ' <span class="tag pink">winning hit</span>' : ''}`],
        ['odds', 'Odds', pct],
        ['won', 'Won', (v) => (v ? '🎉' : '')],
        ['created_at', 'At', time],
      ],
      (row) => (row.idx === c.winningThrow ? 'win' : ''),
    )}</div>
    <h4>Winner's raw throw log for this release (${c.winnerThrowLog.length})</h4>
    <div class="table-wrap">${table(c.winnerThrowLog, [
      ['created_at', 'Server time', time],
      ['kind', 'Kind', esc],
      ['result', 'Result', resultTag],
      ['origin', 'Origin', (v) => `<code>${esc(v)}</code>`],
      ['dir', 'Direction', (v) => `<code>${esc(v)}</code>`],
      ['client_at', 'Client time', time],
    ])}</div>
  </div>`;

  const showErr = (e: unknown) => {
    if (e instanceof AuthError) return showLogin(e.message);
    $('#claim-err').textContent = (e as Error).message;
  };
  $('#claim-verify')?.addEventListener('click', async () => {
    if (!confirm(`Redeem ${c.code}? A code can only be redeemed once.`)) return;
    try {
      await call('POST', `claims/${encodeURIComponent(c.code)}/verify`);
      flash('Claim verified.', true);
      await Promise.all([lookupClaim(c.code), loadClaims()]);
    } catch (e) {
      showErr(e);
    }
  });
  $<HTMLFormElement>('#claim-ship')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const tracking = String(new FormData(e.target as HTMLFormElement).get('tracking') ?? '').trim();
    try {
      await call('POST', `claims/${encodeURIComponent(c.code)}/ship`, { tracking });
      flash('Marked shipped.', true);
      await Promise.all([lookupClaim(c.code), loadClaims()]);
    } catch (err) {
      showErr(err);
    }
  });
}

// ── Anti-abuse ───────────────────────────────────────────────────────

function flagTable(rows: any[], actions: boolean): string {
  return table(rows, [
    ['created_at', 'When', when],
    ...(actions ? ([['player_name', 'Player', (v: any, r: any) => `${esc(v ?? '?')} <code class="tiny">${esc(r.player_id)}</code>`]] as Col[]) : []),
    ['reason', 'Reason', (v) => `<span class="tag orange">${esc(v)}</span>`],
    ['detail', 'Detail', esc],
    ...(actions
      ? ([
          [
            'banned',
            'Account',
            (v: any, r: any) =>
              `${v ? '<span class="tag dark">banned</span> ' : ''}<button class="btn btn-sm" type="button" data-ban="${esc(r.player_id)}" data-banned="${v ? 0 : 1}">${v ? 'Unban' : 'Ban'}</button>
               <button class="btn btn-sm" type="button" data-throws="${esc(r.player_id)}">Throws</button>`,
          ],
        ] as Col[])
      : []),
  ]);
}

function renderFlags(rows: any[]): void {
  const box = $('#flags-list');
  box.innerHTML = flagTable(rows, true);
  $$('[data-ban]', box).forEach((b) =>
    b.addEventListener('click', () => {
      const banned = b.dataset.banned === '1';
      if (banned && !confirm('Ban this account? It can no longer pick up or throw golden balls.')) return;
      void act(() => call('POST', `players/${encodeURIComponent(b.dataset.ban!)}/ban`, { banned }), refreshState, banned ? 'Account banned.' : 'Account unbanned.');
    }),
  );
  $$('[data-throws]', box).forEach((b) =>
    b.addEventListener('click', () => {
      const f = $<HTMLFormElement>('#throw-filter');
      (f.elements.namedItem('player') as HTMLInputElement).value = b.dataset.throws!;
      (f.elements.namedItem('release') as HTMLInputElement).value = '';
      void loadThrows();
    }),
  );
}

let throwFilterActive = false;

function renderThrows(rows: any[]): void {
  $('#throws-list').innerHTML = table(rows, [
    ['created_at', 'When', time],
    ['player_name', 'Player', (v, r) => `${esc(v ?? '?')} <button class="admin-link tiny" type="button" data-pf="${esc(r.player_id)}">filter</button>`],
    ['kind', 'Kind', (v) => `<span class="tag ${v === 'gold' ? 'gold' : 'pink'}">${esc(v)}</span>`],
    ['result', 'Result', (v) => resultTag(String(v))],
    ['release_id', 'Release', (v) => (v ? `<code class="tiny">${esc(v)}</code>` : '–')],
  ]);
  $$('[data-pf]', $('#throws-list')).forEach((b) =>
    b.addEventListener('click', () => {
      const f = $<HTMLFormElement>('#throw-filter');
      (f.elements.namedItem('player') as HTMLInputElement).value = b.dataset.pf!;
      void loadThrows();
    }),
  );
}

async function loadThrows(): Promise<void> {
  const f = $<HTMLFormElement>('#throw-filter');
  const player = (f.elements.namedItem('player') as HTMLInputElement).value.trim();
  const release = (f.elements.namedItem('release') as HTMLInputElement).value.trim();
  throwFilterActive = !!(player || release);
  if (!throwFilterActive) {
    if (state) renderThrows(state.recentThrows);
    return;
  }
  const q = new URLSearchParams();
  if (player) q.set('player', player);
  if (release) q.set('release', release);
  renderThrows(await call('GET', `throws?${q}`));
}

$<HTMLFormElement>('#throw-filter').addEventListener('submit', (e) => {
  e.preventDefault();
  void loadThrows().catch((err) => flash((err as Error).message));
});
$('#throw-clear').addEventListener('click', () => {
  $<HTMLFormElement>('#throw-filter').reset();
  void loadThrows();
});

// ── Boot + auto-refresh ──────────────────────────────────────────────

/** Skip background refreshes while the admin is typing so forms are never clobbered. */
const typing = () => {
  const a = document.activeElement;
  return a instanceof HTMLInputElement || a instanceof HTMLSelectElement || a instanceof HTMLTextAreaElement;
};

if (tokenValue) {
  refreshState()
    .then(() => {
      $('#admin-ui').hidden = false;
      $('#login').hidden = true;
    })
    .catch((e) => showLogin(e instanceof AuthError ? '' : (e as Error).message));
}

setInterval(() => {
  if ($('#admin-ui').hidden || document.hidden || typing()) return;
  if (currentTab === 'overview' || currentTab === 'abuse') {
    refreshState().catch((e) => (e instanceof AuthError ? showLogin(e.message) : undefined));
  }
}, 5000);

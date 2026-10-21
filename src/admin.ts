import './styles.css';
import { $, $$, esc, pct, txLink, usd } from './ui';

const KEY = 'cove.admin';
let tokenValue = sessionStorage.getItem(KEY) ?? '';

async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/admin/${path}`, {
    method,
    headers: { 'x-admin-token': tokenValue, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
}

const table = (rows: Record<string, unknown>[], cols: [string, string, (v: any) => string][]) =>
  rows.length
    ? `<table><thead><tr>${cols.map((c) => `<th>${c[1]}</th>`).join('')}</tr></thead><tbody>${rows
        .map((r) => `<tr>${cols.map(([k, , f]) => `<td>${f(r[k])}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`
    : '<p class="tiny">Nothing yet.</p>';

async function refresh(): Promise<void> {
  const s = await call('GET', 'state');
  $('#admin-ui').hidden = false;
  $('#login').hidden = true;
  $('#admin-tiles').innerHTML = [
    ['Status', s.economy.launched ? 'Live' : 'Pre-launch'],
    ['Vault', usd(s.economy.vaultUsd)],
    ['Online', s.economy.online],
    ['Waitlist', s.waitlist],
    ['Players', s.players],
    ['Balls on island', s.balls],
    ['Cards caught', s.economy.cardsCaught],
    ['Providers', `${s.providers.chain} / ${s.providers.cards}`],
    ['Master card', s.masterWinner?.name ?? 'unclaimed'],
  ]
    .map(([k, v]) => `<div class="tile"><span class="tile-label">${k}</span><b class="tile-value" style="font-size:1.6rem">${esc(v)}</b></div>`)
    .join('');
  $('#admin-cards').innerHTML =
    (s.card ? `<p><b>${esc(s.card.name)}</b> · ${s.card.throws} hits · next ${pct(s.card.nextOdds)}<br/><code>${esc(s.card.commitment)}</code></p>` : '<p class="tiny">No card in play.</p>') +
    table(s.queued, [
      ['name', 'Queued', esc],
      ['grade', 'Grade', esc],
      ['price_usd', 'Paid', (v) => usd(v)],
    ]);
  $('#admin-pending').innerHTML =
    table(s.pendingDeliveries, [
      ['name', 'Card', esc],
      ['winner_name', 'Winner', esc],
      ['winner_wallet', 'Wallet', (v) => (v ? esc(v) : '<i>waiting</i>')],
      ['id', '', (v) => `<button class="btn btn-ghost btn-sm" data-redeliver="${esc(v)}">Retry</button>`],
    ]);
  $('#admin-claims').innerHTML = table(s.claims, [
    ['created_at', 'When', (v) => new Date(v).toLocaleTimeString()],
    ['usd', 'USD', (v) => usd(v)],
    ['balls', 'Balls', String],
    ['signature', 'Tx', (v) => txLink(v)],
  ]);
  $('#admin-throws').innerHTML = table(s.recentThrows, [
    ['idx', '#', (v) => String(v + 1)],
    ['player_name', 'Trainer', esc],
    ['odds', 'Odds', pct],
    ['won', 'Won', (v) => (v ? '🎉' : '')],
  ]);
  $$('[data-redeliver]').forEach((b) => b.addEventListener('click', () => act(() => call('POST', 'redeliver', { cardId: b.dataset.redeliver }))));
}

async function act(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    alert((e as Error).message);
  }
  await refresh();
}

$<HTMLFormElement>('#login').addEventListener('submit', async (e) => {
  e.preventDefault();
  tokenValue = $<HTMLInputElement>('#admin-token').value;
  try {
    await refresh();
    sessionStorage.setItem(KEY, tokenValue);
  } catch (err) {
    $('#admin-err').textContent = (err as Error).message;
  }
});

const actions: Record<string, () => Promise<unknown>> = {
  launch: () => call('POST', 'launch', { launched: true }),
  unlaunch: () => call('POST', 'launch', { launched: false }),
  claim: () => call('POST', 'claim'),
  vault: () => call('POST', 'vault', { addUsd: 10 }),
  balls: () => call('POST', 'balls', { n: 20 }),
  event: () => call('POST', 'event', {}),
};
$$('[data-act]').forEach((b) => b.addEventListener('click', () => act(actions[b.dataset.act!])));

if (tokenValue) refresh().catch(() => {});
setInterval(() => {
  if (!$('#admin-ui').hidden) refresh().catch(() => {});
}, 5000);

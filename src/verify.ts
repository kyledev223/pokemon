import { oddsForThrow, rollFromHex, rollMessage } from '../shared/fair';
import { api, type FairCard, type FairDetail } from './api';
import { $, esc, pct, txLink } from './ui';

// Client-side provably-fair verifier. Everything is recomputed with WebCrypto in the
// visitor's browser; the server's claimed results are only compared, never trusted.

const hexToBytes = (hex: string) => new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
const bytesToHex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(secretHex: string): Promise<string> {
  return bytesToHex(await crypto.subtle.digest('SHA-256', hexToBytes(secretHex)));
}

export async function rollsFor(secretHex: string, cardId: string, count: number): Promise<number[]> {
  const key = await crypto.subtle.importKey('raw', hexToBytes(secretHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const enc = new TextEncoder();
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(rollMessage(cardId, i)));
    out.push(rollFromHex(bytesToHex(sig)));
  }
  return out;
}

let cards: FairCard[] = [];

export async function initVerifier(): Promise<void> {
  const select = $<HTMLSelectElement>('#verify-card');
  const load = async () => {
    try {
      cards = await api.fairList();
    } catch {
      cards = [];
    }
    select.innerHTML = cards.length
      ? cards.map((c) => `<option value="${esc(c.id)}">${esc(c.name)} · ${c.revealed ? `${c.throws} throws · revealed` : 'in play (secret hidden)'}</option>`).join('')
      : '<option value="">No cards released yet</option>';
  };
  await load();
  setInterval(load, 60_000);

  $('#verify-run').addEventListener('click', async () => {
    const out = $('#verify-out');
    out.innerHTML = '<p>Verifying…</p>';
    try {
      const manualId = $<HTMLInputElement>('#verify-id').value.trim();
      const manualSecret = $<HTMLInputElement>('#verify-secret').value.trim().toLowerCase();
      const manualCommit = $<HTMLInputElement>('#verify-commit').value.trim().toLowerCase();
      const id = manualId || select.value;
      if (!id) throw new Error('Pick a card first.');
      const detail = await api.fair(id);
      const secret = manualSecret || detail.secret;
      const commitment = manualCommit || detail.commitment;
      out.innerHTML = await report(detail, secret, commitment);
    } catch (e) {
      out.innerHTML = `<p class="bad">${esc((e as Error).message)}</p>`;
    }
  });
}

async function report(d: FairDetail, secret: string | null, commitment: string): Promise<string> {
  const head = `<p><b>${esc(d.name)}</b> · <code>${esc(d.id)}</code><br/>Commitment <code>${esc(commitment)}</code> ${d.memoSig ? `· memo ${txLink(d.memoSig)}` : ''}</p>`;
  if (!secret) {
    return `${head}<p>This card is still in play, so its secret stays hidden until someone catches it. <b>${d.throws.length}</b> throws logged so far. Come back after the catch and every roll will be checkable.</p>`;
  }
  if (!/^[0-9a-f]{64}$/.test(secret)) return `${head}<p class="bad">Secret must be 64 hex characters.</p>`;

  const commitOk = (await sha256Hex(secret)) === commitment;
  const rolls = await rollsFor(secret, d.id, d.throws.length);
  let mismatches = 0;
  let firstWin = -1;
  const rows = d.throws.map((t, i) => {
    const odds = oddsForThrow(i);
    const won = rolls[i] < odds;
    if (won && firstWin < 0) firstWin = i;
    const ok = t.index === i && Math.abs(t.odds - odds) < 1e-12 && t.won === won;
    if (!ok) mismatches++;
    return `<tr class="${won ? 'win' : ''}"><td>#${i + 1}</td><td>${esc(t.player)}</td><td>${pct(odds)}</td><td>${rolls[i].toFixed(8)}</td><td>${won ? '🎉 win' : 'miss'}</td><td>${ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'}</td></tr>`;
  });
  const lastIsWin = firstWin === d.throws.length - 1;
  const allOk = commitOk && mismatches === 0 && (d.status === 'in_play' || lastIsWin);
  return `${head}
    <div class="verify-summary">
      <span class="tag ${commitOk ? 'gold' : 'pink'}">${commitOk ? '✓' : '✗'} sha256(secret) matches commitment</span>
      <span class="tag ${mismatches ? 'pink' : 'gold'}">${mismatches ? `✗ ${mismatches} rolls differ` : `✓ all ${d.throws.length} rolls recomputed`}</span>
      <span class="tag ${lastIsWin ? 'gold' : 'pink'}">${lastIsWin ? `✓ first winning roll is throw #${firstWin + 1} (${esc(d.winnerName ?? '')})` : '✗ winner does not match first winning roll'}</span>
    </div>
    <p class="${allOk ? 'ok' : 'bad'}"><b>${allOk ? 'Verified. This catch was fair.' : 'Verification failed. Please report this.'}</b></p>
    <div class="table-wrap"><table><thead><tr><th>Throw</th><th>Trainer</th><th>Odds</th><th>Roll</th><th>Result</th><th>Match</th></tr></thead>
    <tbody>${rows.join('')}</tbody></table></div>`;
}

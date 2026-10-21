import type { Tier } from '../../shared/prizes';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const TIER_COLOR: Record<Tier, string> = { S: '#ffc928', A: '#ff5ea8', B: '#3fa7ff' };

/** Stand-in slab shown until the admin uploads a photo of the real card. Text only, no artwork. */
export function prizeSvg(opts: { name: string; set: string; grade: string; tier: Tier }): string {
  const color = TIER_COLOR[opts.tier];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="560" viewBox="0 0 400 560">
  <rect x="6" y="6" width="388" height="548" rx="26" fill="#f4f7fb" stroke="#2a2140" stroke-width="6"/>
  <rect x="26" y="24" width="348" height="78" rx="14" fill="${color}" stroke="#2a2140" stroke-width="4"/>
  <text x="44" y="58" font-family="Fredoka, Arial, sans-serif" font-weight="700" font-size="24" fill="#2a2140">${esc(opts.name.slice(0, 24))}</text>
  <text x="44" y="86" font-family="Fredoka, Arial, sans-serif" font-size="16" fill="#2a2140">${esc((opts.set || 'Set to be added').slice(0, 34))}</text>
  <text x="356" y="72" text-anchor="end" font-family="Fredoka, Arial, sans-serif" font-weight="700" font-size="30" fill="#2a2140">${opts.tier}</text>
  <rect x="44" y="124" width="312" height="380" rx="16" fill="#fff8ee" stroke="#2a2140" stroke-width="4" stroke-dasharray="14 10"/>
  <text x="200" y="300" text-anchor="middle" font-family="Fredoka, Arial, sans-serif" font-weight="700" font-size="26" fill="#6b6185">Photo coming soon</text>
  <text x="200" y="334" text-anchor="middle" font-family="Fredoka, Arial, sans-serif" font-size="18" fill="#6b6185">${esc((opts.grade || 'Real card').slice(0, 30))}</text>
  <text x="200" y="534" text-anchor="middle" font-family="Fredoka, Arial, sans-serif" font-size="14" fill="#6b6185">Real card prize · Tier ${opts.tier}</text>
</svg>`;
}

import { speciesById } from '../../shared/species';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Placeholder graded-slab art for mock cards (original artwork, generated on the fly). */
export function slabSvg(opts: { name: string; grade: string; set: string; speciesId: number }): string {
  const s = speciesById(opts.speciesId) ?? speciesById(1);
  const [gradeWord, gradeNum] = splitGrade(opts.grade);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="560" viewBox="0 0 400 560">
  <defs>
    <linearGradient id="slab" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4f7fb"/><stop offset="1" stop-color="#d9e2ec"/></linearGradient>
    <linearGradient id="art" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s.accent}"/><stop offset="1" stop-color="${s.color}"/></linearGradient>
    <radialGradient id="foil" cx=".3" cy=".2" r=".9"><stop offset="0" stop-color="#fff" stop-opacity=".75"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></radialGradient>
  </defs>
  <rect x="6" y="6" width="388" height="548" rx="26" fill="url(#slab)" stroke="#b8c4d0" stroke-width="4"/>
  <rect x="26" y="24" width="348" height="74" rx="12" fill="#e63e6d"/>
  <text x="42" y="54" font-family="Arial, sans-serif" font-weight="700" font-size="20" fill="#fff">${esc(opts.name.slice(0, 26))}</text>
  <text x="42" y="80" font-family="Arial, sans-serif" font-size="14" fill="#ffe0ea">${esc(opts.set)} · #${String(s.id).padStart(3, '0')}</text>
  <text x="358" y="58" text-anchor="end" font-family="Arial, sans-serif" font-weight="800" font-size="34" fill="#fff">${esc(gradeNum)}</text>
  <text x="358" y="82" text-anchor="end" font-family="Arial, sans-serif" font-size="12" fill="#fff">${esc(gradeWord)}</text>
  <rect x="44" y="118" width="312" height="418" rx="14" fill="#ffcf3f"/>
  <rect x="58" y="132" width="284" height="210" rx="8" fill="url(#art)"/>
  <circle cx="200" cy="250" r="66" fill="${s.color}" stroke="#fff" stroke-width="6"/>
  <circle cx="176" cy="238" r="12" fill="#fff"/><circle cx="224" cy="238" r="12" fill="#fff"/>
  <circle cx="179" cy="240" r="6" fill="#222"/><circle cx="227" cy="240" r="6" fill="#222"/>
  <path d="M182 272 Q200 286 218 272" stroke="#222" stroke-width="5" fill="none" stroke-linecap="round"/>
  <rect x="58" y="132" width="284" height="210" rx="8" fill="url(#foil)"/>
  <text x="200" y="384" text-anchor="middle" font-family="Arial, sans-serif" font-weight="700" font-size="24" fill="#5b3a00">${esc(s.name)}</text>
  <text x="200" y="414" text-anchor="middle" font-family="Arial, sans-serif" font-size="15" fill="#6b4a10">${s.rarity.toUpperCase()} · ${s.element.toUpperCase()}</text>
  <rect x="78" y="440" width="244" height="2" fill="#c99a1a"/>
  <text x="200" y="476" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" fill="#6b4a10">Placeholder art · mock card provider</text>
</svg>`;
}

function splitGrade(grade: string): [string, string] {
  const m = grade.match(/^(.*?)(\d+(\.\d+)?)\s*$/);
  return m ? [m[1].trim(), m[2]] : [grade, ''];
}

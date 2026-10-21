// Original critters. Placeholder low-poly designs are generated from these fields
// (src/game/critterMesh.ts) until hand-made models replace them.

export type Region = 'base' | 'ocean' | 'sky' | 'cave';
export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
export type Shape = 'blob' | 'cube' | 'cone' | 'tall' | 'flat' | 'spiky' | 'gem' | 'ring';
export type Ears = 'round' | 'pointy' | 'none' | 'antenna' | 'horn' | 'leaf';
export type Element = 'leaf' | 'ember' | 'tide' | 'spark' | 'stone' | 'breeze';

export interface Species {
  id: number;
  name: string;
  region: Region;
  rarity: Rarity;
  shape: Shape;
  ears: Ears;
  element: Element;
  color: string;
  accent: string;
  size: number;
}

type Row = [string, Rarity, Shape, Ears, Element, string, string, number];

const TABLE: Record<Region, Row[]> = {
  base: [
    ['Puffkin', 'common', 'blob', 'round', 'leaf', '#ffb3c7', '#ffffff', 0.9],
    ['Mossmole', 'common', 'flat', 'round', 'stone', '#7fbf6a', '#5a3d2b', 0.8],
    ['Bramblit', 'common', 'spiky', 'pointy', 'leaf', '#4caf50', '#c2185b', 0.8],
    ['Toastoad', 'common', 'cube', 'none', 'ember', '#f4a261', '#8d5524', 0.9],
    ['Fizzbun', 'common', 'blob', 'pointy', 'spark', '#ffe066', '#ff6b9d', 0.8],
    ['Pebbleup', 'common', 'gem', 'none', 'stone', '#b0a8b9', '#6c6f7d', 0.7],
    ['Snoozel', 'common', 'flat', 'round', 'breeze', '#c3b1e1', '#ffffff', 0.9],
    ['Corncub', 'common', 'tall', 'round', 'ember', '#ffd166', '#7cb518', 0.9],
    ['Sproutle', 'common', 'cone', 'leaf', 'leaf', '#95d5b2', '#2d6a4f', 0.7],
    ['Dandefox', 'uncommon', 'tall', 'pointy', 'breeze', '#ffcf56', '#ffffff', 1.0],
    ['Mallowmew', 'uncommon', 'blob', 'pointy', 'spark', '#ffd6e8', '#ff8fab', 0.9],
    ['Burrbee', 'uncommon', 'blob', 'antenna', 'spark', '#ffc300', '#2b2d42', 0.7],
    ['Clovercat', 'uncommon', 'tall', 'pointy', 'leaf', '#74c69d', '#ffffff', 0.9],
    ['Pipsqueal', 'uncommon', 'cone', 'round', 'tide', '#a0c4ff', '#ffafcc', 0.7],
    ['Tumblebun', 'uncommon', 'ring', 'pointy', 'breeze', '#e9c46a', '#f4f1de', 0.9],
    ['Mushmallow', 'uncommon', 'cone', 'none', 'leaf', '#e76f51', '#fefae0', 0.9],
    ['Gumdrake', 'rare', 'tall', 'horn', 'ember', '#ff5d8f', '#ffd6a5', 1.2],
    ['Prismpup', 'rare', 'cube', 'pointy', 'spark', '#9bf6ff', '#bdb2ff', 1.0],
    ['Hazelhog', 'rare', 'spiky', 'round', 'stone', '#a47148', '#ffe8d6', 1.0],
    ['Wobbleroo', 'rare', 'tall', 'round', 'breeze', '#f7b267', '#f4845f', 1.2],
    ['Petalisk', 'rare', 'spiky', 'leaf', 'leaf', '#ff85a1', '#fbb1bd', 1.0],
    ['Cindercub', 'rare', 'blob', 'round', 'ember', '#f3722c', '#f9c74f', 1.0],
    ['Lumabug', 'uncommon', 'flat', 'antenna', 'spark', '#c0fdfb', '#64dfdf', 0.6],
    ['Thistlehorn', 'epic', 'tall', 'horn', 'stone', '#8e7dbe', '#f2d0a9', 1.3],
    ['Rumbleroot', 'epic', 'cube', 'horn', 'leaf', '#6a994e', '#bc6c25', 1.4],
    ['Velvetusk', 'epic', 'flat', 'horn', 'stone', '#b5838d', '#ffcdb2', 1.3],
    ['Honeyhorn', 'epic', 'tall', 'horn', 'spark', '#ffb703', '#fb8500', 1.3],
    ['Solarion', 'legendary', 'spiky', 'pointy', 'ember', '#ffd60a', '#ff7b00', 1.7],
    ['Verdantaur', 'legendary', 'tall', 'horn', 'leaf', '#2a9d8f', '#e9f5db', 1.8],
    ['Aurorabbit', 'legendary', 'blob', 'pointy', 'breeze', '#e0aaff', '#72efdd', 1.6],
  ],
  ocean: [
    ['Bubblefin', 'common', 'blob', 'none', 'tide', '#4cc9f0', '#f1faee', 0.8],
    ['Kelpup', 'common', 'tall', 'leaf', 'tide', '#2a9d8f', '#a7c957', 0.8],
    ['Coralcrab', 'uncommon', 'flat', 'antenna', 'stone', '#ff6f61', '#ffd6a5', 0.8],
    ['Splashling', 'uncommon', 'cone', 'round', 'tide', '#90e0ef', '#0077b6', 0.7],
    ['Glimmeray', 'rare', 'flat', 'none', 'spark', '#48cae4', '#ffd6ff', 1.2],
    ['Leviawave', 'legendary', 'ring', 'horn', 'tide', '#0096c7', '#caf0f8', 2.0],
  ],
  sky: [
    ['Breezlet', 'common', 'blob', 'round', 'breeze', '#bde0fe', '#ffffff', 0.6],
    ['Cloudmunk', 'common', 'flat', 'round', 'breeze', '#f8f9fa', '#a2d2ff', 0.7],
    ['Featherfizz', 'uncommon', 'cone', 'pointy', 'spark', '#ffafcc', '#ffc8dd', 0.7],
    ['Skipwing', 'uncommon', 'tall', 'antenna', 'breeze', '#a2d2ff', '#ffb4a2', 0.8],
    ['Zephyrowl', 'rare', 'blob', 'pointy', 'breeze', '#cdb4db', '#ffffff', 1.0],
    ['Stratosoar', 'legendary', 'gem', 'horn', 'spark', '#ffd166', '#8ecae6', 1.6],
  ],
  cave: [
    ['Crystump', 'common', 'cube', 'none', 'stone', '#7b2cbf', '#e0aaff', 0.8],
    ['Geodillo', 'common', 'flat', 'round', 'stone', '#6c757d', '#c77dff', 0.8],
    ['Shardling', 'uncommon', 'gem', 'pointy', 'spark', '#c77dff', '#ffffff', 0.7],
    ['Echobat', 'uncommon', 'blob', 'pointy', 'breeze', '#3c096c', '#ff9ef5', 0.7],
    ['Quartzle', 'rare', 'spiky', 'none', 'stone', '#e0aaff', '#9d4edd', 1.0],
    ['Prismorrow', 'legendary', 'gem', 'horn', 'spark', '#f72585', '#b5179e', 1.7],
  ],
};

export const REGIONS: Region[] = ['base', 'ocean', 'sky', 'cave'];

export const REGION_LABEL: Record<Region, string> = {
  base: 'Island',
  ocean: 'Ocean',
  sky: 'Sky',
  cave: 'Cave',
};

export const SPECIES: Species[] = REGIONS.flatMap((region) => TABLE[region]).map((row, i) => {
  const [name, rarity, shape, ears, element, color, accent, size] = row;
  const region = REGIONS.find((r) => TABLE[r].includes(row))!;
  return { id: i + 1, name, region, rarity, shape, ears, element, color, accent, size };
});

export const BASE_DEX_SIZE = SPECIES.filter((s) => s.region === 'base').length;

export function speciesById(id: number): Species {
  return SPECIES[id - 1];
}

export const CATCH_RATE: Record<Rarity, number> = {
  common: 0.55,
  uncommon: 0.38,
  rare: 0.22,
  epic: 0.12,
  legendary: 0.06,
};

export const SPAWN_WEIGHT: Record<Rarity, number> = {
  common: 50,
  uncommon: 25,
  rare: 10,
  epic: 4,
  legendary: 0, // only during timed events
};

/** Arena stats derived from rarity + size so every species has a distinct profile. */
export function statsFor(s: Species) {
  const tier = { common: 1, uncommon: 1.15, rare: 1.3, epic: 1.5, legendary: 1.8 }[s.rarity];
  return {
    hp: Math.round((40 + s.size * 22) * tier),
    atk: Math.round((10 + (s.id % 7) * 1.5) * tier),
    def: Math.round((8 + ((s.id * 3) % 8) * 1.2 + s.size * 4) * tier),
    spd: Math.round((8 + ((s.id * 5) % 9)) * tier * (1.6 - s.size * 0.35)),
  };
}

/** Rough upper bounds for drawing stat bars. */
export const STAT_MAX = { hp: 140, atk: 34, def: 40, spd: 36 };

export interface Move {
  name: string;
  element: Element | 'neutral';
  power: number;
  accuracy: number;
}

const MOVE_POOL: Record<Element, [string, number, number][]> = {
  leaf: [['Petal Pelt', 40, 1], ['Vine Snap', 55, 0.95], ['Bloom Burst', 75, 0.85], ['Thorn Volley', 65, 0.9]],
  ember: [['Ember Puff', 40, 1], ['Toast Slam', 55, 0.95], ['Cinder Swirl', 75, 0.85], ['Flare Hop', 65, 0.9]],
  tide: [['Bubble Pop', 40, 1], ['Splash Dash', 55, 0.95], ['Riptide Roll', 75, 0.85], ['Foam Spray', 65, 0.9]],
  spark: [['Static Nip', 40, 1], ['Zap Zip', 55, 0.95], ['Thunder Fizz', 75, 0.85], ['Glimmer Bolt', 65, 0.9]],
  stone: [['Pebble Toss', 40, 1], ['Rock Bump', 55, 0.95], ['Boulder Drop', 75, 0.85], ['Crystal Crush', 65, 0.9]],
  breeze: [['Gust Flick', 40, 1], ['Feather Swipe', 55, 0.95], ['Cyclone Spin', 75, 0.85], ['Draft Dive', 65, 0.9]],
};
const NEUTRAL_MOVES: [string, number, number][] = [['Bonk', 45, 1], ['Tumble', 50, 0.95], ['Cheeky Nibble', 40, 1], ['Wiggle Whack', 55, 0.9]];
const ELEMENTS: Element[] = ['leaf', 'ember', 'tide', 'spark', 'stone', 'breeze'];

/** Exactly 4 moves: three of the species' element, one neutral (or a coverage move for rare+). */
export function movesFor(s: Species): Move[] {
  const pool = MOVE_POOL[s.element];
  const start = s.id % pool.length;
  const own = [0, 1, 2].map((k) => pool[(start + k) % pool.length]);
  const out: Move[] = own.map(([name, power, accuracy]) => ({ name, element: s.element, power, accuracy }));
  if (s.rarity === 'rare' || s.rarity === 'epic' || s.rarity === 'legendary') {
    const cover = ELEMENTS.find((e) => BEATS[e] === BEATS[BEATS[s.element]]) ?? ELEMENTS[(s.id * 7) % ELEMENTS.length];
    const [name, power, accuracy] = MOVE_POOL[cover][(s.id + 1) % 4];
    out.push({ name, element: cover, power, accuracy });
  } else {
    const [name, power, accuracy] = NEUTRAL_MOVES[s.id % NEUTRAL_MOVES.length];
    out.push({ name, element: 'neutral', power, accuracy });
  }
  return out;
}

/** Elements that deal super-effective damage to this species. */
export function weaknessesOf(s: Species): Element[] {
  return ELEMENTS.filter((e) => BEATS[e] === s.element);
}

/** Level from how many copies you own: 5 for the first, +3 per extra copy, capped at 50. */
export function levelFor(copies: number): number {
  return Math.min(50, 5 + 3 * Math.max(0, copies - 1));
}

/** Stats scaled for a level (level 5 = base stats). */
export function statsAtLevel(s: Species, level: number) {
  const st = statsFor(s);
  const k = 1 + (level - 5) * 0.03;
  return { hp: Math.round(st.hp * k), atk: Math.round(st.atk * k), def: Math.round(st.def * k), spd: Math.round(st.spd * k) };
}

const BEATS: Record<Element, Element> = {
  leaf: 'tide',
  tide: 'ember',
  ember: 'leaf',
  spark: 'breeze',
  breeze: 'stone',
  stone: 'spark',
};

export function elementMultiplier(att: Element | 'neutral', def: Element): number {
  if (att === 'neutral') return 1;
  if (BEATS[att] === def) return 1.5;
  if (BEATS[def] === att) return 0.7;
  return 1;
}

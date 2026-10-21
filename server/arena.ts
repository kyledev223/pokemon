import type { Row } from './db';
import type { Game } from './game';
import { HttpError } from './market';
import type { PlayerRow } from './store';
import { SPECIES, elementMultiplier, speciesById, statsFor, type Species } from '../shared/species';

interface Fighter {
  species: number;
  name: string;
  hp: number;
  maxHp: number;
  atk: number;
  spd: number;
}

const BOT_NAMES = ['Coach Pip', 'Ranger Mo', 'Captain Tully', 'Old Fennel', 'Twin Juno', 'Scout Bix'];
const COOLDOWN_MS = 6_000;

/** Quick server-resolved 3v3 critter duels against a bot trainer. Wins feed the Ranks board. */
export class Arena {
  private lastDuel = new Map<string, number>();

  constructor(private game: Game) {}

  duel(player: PlayerRow, critterIds: number[]) {
    const now = Date.now();
    if (now - (this.lastDuel.get(player.id) ?? 0) < COOLDOWN_MS) throw new HttpError(429, 'Catch your breath, next duel in a few seconds.');
    const ids = [...new Set(critterIds.map(Number))].slice(0, 3);
    if (!ids.length) throw new HttpError(400, 'Pick 1 to 3 critters.');
    const rows = ids.map((id) => this.game.db.prepare('SELECT species FROM critters WHERE id = ? AND owner_id = ?').get(id, player.id) as Row | undefined);
    if (rows.some((r) => !r)) throw new HttpError(400, 'You can only send critters you own.');
    this.lastDuel.set(player.id, now);

    const mine = rows.map((r) => fighter(speciesById(r!.species as number)));
    const avgTier = mine.reduce((a, f) => a + f.maxHp, 0) / mine.length;
    const pool = SPECIES.filter((s) => s.rarity !== 'legendary').sort((a, b) => Math.abs(statsFor(a).hp - avgTier) - Math.abs(statsFor(b).hp - avgTier));
    const foe = mine.map(() => fighter(pool[Math.floor(Math.random() * Math.min(12, pool.length))]));
    const foeName = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];

    const log: string[] = [];
    let a = 0;
    let b = 0;
    for (let turn = 0; turn < 80 && a < mine.length && b < foe.length; turn++) {
      const x = mine[a];
      const y = foe[b];
      const order: [Fighter, Fighter, 'you' | 'foe'][] =
        x.spd >= y.spd
          ? [[x, y, 'you'], [y, x, 'foe']]
          : [[y, x, 'foe'], [x, y, 'you']];
      for (const [att, def, side] of order) {
        if (att.hp <= 0 || def.hp <= 0) continue;
        const mult = elementMultiplier(speciesById(att.species).element, speciesById(def.species).element);
        const dmg = Math.max(1, Math.round(att.atk * mult * (0.85 + Math.random() * 0.3)));
        def.hp = Math.max(0, def.hp - dmg);
        const note = mult > 1 ? ' It’s super effective!' : mult < 1 ? ' Not very effective…' : '';
        log.push(`${side === 'you' ? 'Your' : `${foeName}'s`} ${att.name} hits ${def.name} for ${dmg}.${note}`);
        if (def.hp === 0) log.push(`${def.name} is out!`);
      }
      if (x.hp === 0) a++;
      if (y.hp === 0) b++;
    }
    const won = b >= foe.length && a < mine.length;
    const points = won ? 3 : 1;
    this.game.db.prepare('UPDATE players SET arena_points = arena_points + ? WHERE id = ?').run(points, player.id);
    log.push(won ? `You beat ${foeName}! +${points} arena points.` : `${foeName} wins this time. +${points} point for trying.`);
    return { foeName, you: mine.map((f) => f.species), foe: foe.map((f) => f.species), log, won, points };
  }
}

function fighter(s: Species): Fighter {
  const st = statsFor(s);
  return { species: s.id, name: s.name, hp: st.hp, maxHp: st.hp, atk: st.atk, spd: st.spd };
}

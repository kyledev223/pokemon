import { randomBytes } from 'node:crypto';
import type { Row } from './db';
import type { Game } from './game';
import { HttpError } from './market';
import type { PlayerRow } from './store';
import { SPECIES, elementMultiplier, levelFor, movesFor, speciesById, statsAtLevel, type Move } from '../shared/species';

interface Fighter {
  species: number;
  name: string;
  level: number;
  hp: number;
  maxHp: number;
  atk: number;
  def: number;
  spd: number;
  moves: Move[];
}

interface Battle {
  id: string;
  playerId: string;
  foeName: string;
  mine: Fighter[];
  foe: Fighter[];
  a: number;
  b: number;
  turn: number;
  startedAt: number;
  touchedAt: number;
  done: boolean;
}

export interface FighterView {
  species: number;
  name: string;
  level: number;
  hp: number;
  maxHp: number;
  moves: Move[];
}

export interface BattleState {
  you: FighterView | null;
  foe: FighterView | null;
  yourTeam: { species: number; hp: number; maxHp: number }[];
  foeTeam: { species: number; hp: number; maxHp: number }[];
  turn: number;
}

const BOT_NAMES = ['Coach Pip', 'Ranger Mo', 'Captain Tully', 'Old Fennel', 'Twin Juno', 'Scout Bix'];
const COOLDOWN_MS = 4_000;
const TTL_MS = 10 * 60_000;
const MAX_TURNS = 60;

/** Server-authoritative turn-based 1–3 critter battles against a bot trainer. Results feed the Ranks board. */
export class Arena {
  private battles = new Map<string, Battle>(); // by player id
  private lastStart = new Map<string, number>();

  constructor(private game: Game) {
    setInterval(() => this.sweep(), 60_000).unref?.();
  }

  start(player: PlayerRow, critterIds: unknown[]) {
    const now = Date.now();
    if (now - (this.lastStart.get(player.id) ?? 0) < COOLDOWN_MS) throw new HttpError(429, 'Catch your breath, next battle in a few seconds.');
    const ids = [...new Set(critterIds.map(Number).filter(Number.isInteger))].slice(0, 3);
    if (!ids.length) throw new HttpError(400, 'Pick 1 to 3 critters.');
    const rows = ids.map((id) => this.game.db.prepare('SELECT species FROM critters WHERE id = ? AND owner_id = ?').get(id, player.id) as Row | undefined);
    if (rows.some((r) => !r)) throw new HttpError(400, 'You can only send critters you own.');
    this.lastStart.set(player.id, now);

    const copies = new Map<number, number>();
    for (const r of this.game.db.prepare('SELECT species, COUNT(*) AS n FROM critters WHERE owner_id = ? GROUP BY species').all(player.id) as Row[]) {
      copies.set(r.species as number, r.n as number);
    }
    const mine = rows.map((r) => {
      const sp = r!.species as number;
      return fighter(sp, levelFor(copies.get(sp) ?? 1));
    });
    const avgLevel = Math.round(mine.reduce((a, f) => a + f.level, 0) / mine.length);
    const avgHp = mine.reduce((a, f) => a + f.maxHp, 0) / mine.length;
    const pool = SPECIES.filter((s) => s.rarity !== 'legendary')
      .map((s) => ({ s, d: Math.abs(statsAtLevel(s, avgLevel).hp - avgHp) }))
      .sort((x, y) => x.d - y.d)
      .slice(0, 12);
    const foe = mine.map(() => fighter(pool[Math.floor(Math.random() * pool.length)].s.id, Math.max(3, avgLevel + Math.floor(Math.random() * 3) - 1)));

    const battle: Battle = {
      id: randomBytes(8).toString('hex'),
      playerId: player.id,
      foeName: BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)],
      mine,
      foe,
      a: 0,
      b: 0,
      turn: 0,
      startedAt: now,
      touchedAt: now,
      done: false,
    };
    this.battles.set(player.id, battle);
    return { battleId: battle.id, foeName: battle.foeName, state: view(battle) };
  }

  move(player: PlayerRow, battleId: unknown, moveIdx: unknown) {
    const battle = this.battles.get(player.id);
    if (!battle || battle.id !== battleId || battle.done) throw new HttpError(404, 'That battle is over. Start a new one.');
    const idx = Number(moveIdx);
    if (!Number.isInteger(idx) || idx < 0 || idx > 3) throw new HttpError(400, 'Pick one of your 4 moves.');
    battle.touchedAt = Date.now();
    battle.turn++;

    const x = battle.mine[battle.a];
    const y = battle.foe[battle.b];
    const myMove = x.moves[idx];
    const foeMove = botMove(y, x);
    const order: [Fighter, Fighter, Move, 'you' | 'foe'][] =
      x.spd > y.spd || (x.spd === y.spd && Math.random() < 0.5)
        ? [
            [x, y, myMove, 'you'],
            [y, x, foeMove, 'foe'],
          ]
        : [
            [y, x, foeMove, 'foe'],
            [x, y, myMove, 'you'],
          ];
    const log: string[] = [];
    for (const [att, def, mv, side] of order) {
      if (att.hp <= 0 || def.hp <= 0) continue;
      const who = side === 'you' ? `Your ${att.name}` : `${battle.foeName}'s ${att.name}`;
      if (Math.random() > mv.accuracy) {
        log.push(`${who} used ${mv.name}… but it missed!`);
        continue;
      }
      const mult = elementMultiplier(mv.element, speciesById(def.species).element);
      const crit = Math.random() < 0.06 ? 1.5 : 1;
      const base = ((2 * att.level) / 5 + 2) * mv.power * (att.atk / Math.max(1, def.def)) / 12 + 2;
      const dmg = Math.max(1, Math.round(base * mult * crit * (0.85 + Math.random() * 0.15)));
      def.hp = Math.max(0, def.hp - dmg);
      const note = `${mult > 1 ? ' Super effective!' : mult < 1 ? ' Not very effective…' : ''}${crit > 1 ? ' Critical hit!' : ''}`;
      log.push(`${who} used ${mv.name} for ${dmg} damage.${note}`);
      if (def.hp === 0) log.push(`${side === 'you' ? `${battle.foeName}'s` : 'Your'} ${def.name} fainted!`);
    }
    if (x.hp === 0 && battle.a < battle.mine.length - 1) {
      battle.a++;
      log.push(`Go, ${battle.mine[battle.a].name}!`);
    }
    if (y.hp === 0 && battle.b < battle.foe.length - 1) {
      battle.b++;
      log.push(`${battle.foeName} sends out ${battle.foe[battle.b].name}!`);
    }

    const mineOut = battle.mine.every((f) => f.hp === 0);
    const foeOut = battle.foe.every((f) => f.hp === 0);
    if (mineOut || foeOut || battle.turn >= MAX_TURNS) {
      battle.done = true;
      const won = foeOut && !mineOut;
      const points = won ? 3 : 1;
      this.game.db.prepare('UPDATE players SET arena_points = arena_points + ? WHERE id = ?').run(points, player.id);
      log.push(won ? `You beat ${battle.foeName}! +${points} arena points.` : `${battle.foeName} wins this time. +${points} point for trying.`);
      this.battles.delete(player.id);
      return { log, state: view(battle), done: true, won, points };
    }
    return { log, state: view(battle), done: false };
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, b] of this.battles) if (now - b.touchedAt > TTL_MS) this.battles.delete(id);
  }
}

function fighter(speciesId: number, level: number): Fighter {
  const s = speciesById(speciesId);
  const st = statsAtLevel(s, level);
  return { species: s.id, name: s.name, level, hp: st.hp, maxHp: st.hp, atk: st.atk, def: st.def, spd: st.spd, moves: movesFor(s) };
}

/** Bot prefers its strongest expected-damage move, with a little randomness. */
function botMove(att: Fighter, def: Fighter): Move {
  const defEl = speciesById(def.species).element;
  let best = att.moves[0];
  let bestScore = -1;
  for (const m of att.moves) {
    const score = m.power * m.accuracy * elementMultiplier(m.element, defEl) * (0.8 + Math.random() * 0.4);
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best;
}

function fv(f: Fighter | undefined): FighterView | null {
  return f ? { species: f.species, name: f.name, level: f.level, hp: f.hp, maxHp: f.maxHp, moves: f.moves } : null;
}

function view(b: Battle): BattleState {
  return {
    you: fv(b.mine[b.a]),
    foe: fv(b.foe[b.b]),
    yourTeam: b.mine.map((f) => ({ species: f.species, hp: f.hp, maxHp: f.maxHp })),
    foeTeam: b.foe.map((f) => ({ species: f.species, hp: f.hp, maxHp: f.maxHp })),
    turn: b.turn,
  };
}

// Prints a coarse ASCII map of the island and sanity-checks spawn helpers.
import { terrainHeight, CAVE, BAZAAR, ARENA, DEX_MASTER, inlandWater, pathDistance, randomLandPoint, randomOceanPoint, randomCavePoint, inCaveDoor, resolveMove } from '../shared/world';
const rows: string[] = [];
for (let z = -120; z <= 120; z += 6) {
  let line = '';
  for (let x = -120; x <= 120; x += 3) {
    const h = terrainHeight(x, z);
    const dc = Math.hypot(x - CAVE.x, z - CAVE.z);
    if (dc < CAVE.r) line += inCaveDoor(x, z) ? 'D' : 'c';
    else if (dc < CAVE.outer) line += inCaveDoor(x, z) ? 'D' : 'M';
    else if (Math.hypot(x - BAZAAR.x, z - BAZAAR.z) < BAZAAR.r) line += 'B';
    else if (Math.hypot(x - ARENA.x, z - ARENA.z) < ARENA.r) line += 'A';
    else if (Math.hypot(x - DEX_MASTER.x, z - DEX_MASTER.z) < DEX_MASTER.r) line += 'X';
    else if (inlandWater(x, z) > 0.5 && h < 0) line += 'w';
    else if (h < -1.4) line += ' ';
    else if (h < 0) line += '~';
    else if (h < 1) line += '.';
    else if (pathDistance(x, z) < 2) line += '=';
    else line += h > 7 ? '^' : h > 4.5 ? '+' : '-';
  }
  rows.push(line);
}
console.log(rows.join('\n'));
const r = Math.random;
let minH = Infinity, maxH = -Infinity;
for (let i = 0; i < 200; i++) { const p = randomLandPoint(r); const h = terrainHeight(p.x, p.z); minH = Math.min(minH, h); maxH = Math.max(maxH, h); }
console.log('land spawn h range', minH.toFixed(2), maxH.toFixed(2));
for (let i = 0; i < 3; i++) { const p = randomOceanPoint(r); console.log('ocean', p.x.toFixed(1), p.z.toFixed(1), terrainHeight(p.x, p.z).toFixed(2)); }
for (let i = 0; i < 3; i++) { const p = randomCavePoint(r); console.log('cave', p.x.toFixed(1), p.z.toFixed(1), terrainHeight(p.x, p.z).toFixed(2)); }
// walk into cave from plaza along path
let x = 0, z = 0; const ex = Math.cos(CAVE.doorAngle), ez = Math.sin(CAVE.doorAngle);
const target = { x: CAVE.x, z: CAVE.z };
for (let i = 0; i < 2000; i++) { const dx = target.x - x, dz = target.z - z, d = Math.hypot(dx, dz); if (d < 0.5) break; const n = resolveMove(x, z, x + dx / d * 0.1, z + dz / d * 0.1, 'island'); x = n.x; z = n.z; }
console.log('walked to cave center?', x.toFixed(1), z.toFixed(1), 'door dir', ex.toFixed(2), ez.toFixed(2));

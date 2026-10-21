import { randomBytes } from 'node:crypto';
import { SPECIES } from '../../shared/species';
import type { CardListing, CardProvider } from './types';

const FINISH = ['Holo', 'Reverse Holo', 'Full Art', 'Promo', 'Gold Foil', 'Shadowless'];
const GRADES = ['GEM MINT 10', 'MINT 9', 'MINT 9', 'NM-MT 8'];

/** Offline card shop: sells placeholder cards featuring the game's own critters. */
export class MockCards implements CardProvider {
  readonly name = 'mock';

  async findCard(maxUsd: number): Promise<CardListing | null> {
    if (maxUsd < 1) return null;
    const pool = SPECIES.filter((s) => s.rarity !== 'legendary');
    const s = pool[Math.floor(Math.random() * pool.length)];
    const finish = FINISH[Math.floor(Math.random() * FINISH.length)];
    const price = Math.min(maxUsd, Math.round((8 + Math.random() * 2) * 100) / 100);
    return {
      listingId: randomBytes(6).toString('hex'),
      name: `${s.name} ${finish}`,
      set: 'Cove Starter Set',
      grade: GRADES[Math.floor(Math.random() * GRADES.length)],
      priceUsd: price,
      valueUsd: Math.round(price * (1 + Math.random() * 0.4) * 100) / 100,
      image: `mock:${s.id}`,
      payTo: 'MockSe11erWa11et1111111111111111111111111111',
    };
  }

  async confirmPurchase(): Promise<{ mint: string }> {
    return { mint: `mockMint${randomBytes(12).toString('hex')}` };
  }
}

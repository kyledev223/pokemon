import { CONFIG } from '../config';
import type { CardListing, CardProvider } from './types';

/**
 * Generic REST adapter for a tokenized graded-card marketplace.
 * Expected endpoints (adapt the paths/shapes to your vendor):
 *   POST {CARD_API_URL}/quote     { maxUsd }                 → CardListing | { listing: null }
 *   POST {CARD_API_URL}/purchase  { listingId, paymentSig }  → { mint }
 *   POST {CARD_API_URL}/transfer  { mint, wallet }           → { signature }
 * All requests carry `Authorization: Bearer ${CARD_API_KEY}`.
 */
export class HttpCards implements CardProvider {
  readonly name = 'http';

  constructor() {
    if (!CONFIG.cardApiUrl || !CONFIG.cardApiKey) throw new Error('CARD_API_URL and CARD_API_KEY are required when CARD_PROVIDER=http');
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${CONFIG.cardApiUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CONFIG.cardApiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`card api ${path} → ${res.status}`);
    return (await res.json()) as T;
  }

  async findCard(maxUsd: number): Promise<CardListing | null> {
    const out = await this.post<CardListing | { listing: null }>('/quote', { maxUsd });
    return 'listingId' in out ? out : null;
  }

  async confirmPurchase(listing: CardListing, paymentSig: string): Promise<{ mint: string }> {
    return this.post('/purchase', { listingId: listing.listingId, paymentSig });
  }

  async transferToWinner(mint: string, wallet: string): Promise<string> {
    const out = await this.post<{ signature: string }>('/transfer', { mint, wallet });
    return out.signature;
  }
}

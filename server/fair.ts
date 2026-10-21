import { createHash, createHmac, randomBytes } from 'node:crypto';
import { rollFromHex, rollMessage } from '../shared/fair';

/** 32 random bytes, hex encoded. Kept server-side until the card is caught. */
export function newSecret(): string {
  return randomBytes(32).toString('hex');
}

/** Public commitment: sha256 over the raw secret bytes, hex encoded. */
export function commitmentFor(secretHex: string): string {
  return createHash('sha256').update(Buffer.from(secretHex, 'hex')).digest('hex');
}

/** HMAC-SHA256(key = secret bytes, msg = "cardId:i") → float in [0,1). */
export function rollFor(secretHex: string, cardId: string, i: number): number {
  const hex = createHmac('sha256', Buffer.from(secretHex, 'hex')).update(rollMessage(cardId, i)).digest('hex');
  return rollFromHex(hex);
}

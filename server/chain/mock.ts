import { randomBytes } from 'node:crypto';
import type { ChainProvider, FeeClaim } from './types';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function mockSig(): string {
  const bytes = randomBytes(64);
  let s = 'mock';
  for (let i = 0; i < 84; i++) s += B58[bytes[i % 64] % 58];
  return s;
}

/** Offline chain: fees appear out of thin air, every tx "succeeds" with a mock signature. */
export class MockChain implements ChainProvider {
  readonly name = 'mock';
  /** Fixed, obviously fake address so the vault card has something to show offline. */
  readonly vaultWallet = 'MockVau1t1111111111111111111111111111111111';

  async claimCreatorFees(): Promise<FeeClaim> {
    const usd = Math.round((1.2 + Math.random() * 4.5) * 100) / 100;
    return { usd, sol: usd / 180, signature: mockSig() };
  }

  async depositToVault(): Promise<string> {
    return mockSig();
  }

  async payUsdc(): Promise<string> {
    return mockSig();
  }

  async writeMemo(): Promise<string> {
    return mockSig();
  }

  async verifyTokenPayment(signature: string): Promise<boolean> {
    return signature.trim().length >= 8;
  }

  isValidAddress(address: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  }
}

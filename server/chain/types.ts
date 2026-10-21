export interface FeeClaim {
  /** USD value of the claimed fees at claim time. */
  usd: number;
  sol: number;
  signature: string;
}

/**
 * Everything the game needs from Solana. `MockChain` runs fully offline;
 * `SolanaChain` talks to a real RPC. Pick one with CHAIN_PROVIDER.
 */
export interface ChainProvider {
  readonly name: string;
  /** Public address of the USDC card vault, shown on the landing page. */
  readonly vaultWallet: string;
  /** Claim accrued creator fees into the fee wallet. Null when there was nothing to claim. */
  claimCreatorFees(): Promise<FeeClaim | null>;
  /** Convert `usd` worth of claimed SOL into USDC held by the vault wallet. */
  depositToVault(usd: number): Promise<string>;
  /** Pay a card seller from the USDC vault. */
  payUsdc(to: string, usd: number): Promise<string>;
  /** Write a plain-text memo on-chain (used for fair-roll commitments). */
  writeMemo(text: string): Promise<string>;
  /** Check that `signature` moved at least `amount` of the game token into `toWallet`. */
  verifyTokenPayment(signature: string, toWallet: string, amount: number): Promise<boolean>;
  isValidAddress(address: string): boolean;
}

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { createTransferCheckedInstruction, getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import { CONFIG } from '../config';
import type { ChainProvider, FeeClaim } from './types';

const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_DECIMALS = 6;
const JUP = 'https://lite-api.jup.ag';

function loadKeypair(secret: string, label: string): Keypair {
  if (!secret) throw new Error(`${label} is required when CHAIN_PROVIDER=solana`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret) as number[]));
}

/**
 * Real Solana integration.
 *
 * Fee claiming is launchpad specific. Put the launchpad's "collect creator fee"
 * instruction(s) in `claimInstructions()`. Whatever SOL lands in the fee wallet
 * on top of what we have already accounted for is treated as freshly claimed fees.
 */
export class SolanaChain implements ChainProvider {
  readonly name = 'solana';
  private conn = new Connection(CONFIG.rpcUrl, 'confirmed');
  private fee = loadKeypair(CONFIG.feeWalletSecret, 'FEE_WALLET_SECRET_KEY');
  private vault = loadKeypair(CONFIG.vaultWalletSecret, 'VAULT_WALLET_SECRET_KEY');
  private usdc = new PublicKey(CONFIG.usdcMint);
  private accountedLamports: number | null = null;

  get feeWallet() {
    return this.fee.publicKey.toBase58();
  }
  get vaultWallet() {
    return this.vault.publicKey.toBase58();
  }

  /** Launchpad-specific claim instructions. Return [] if fees are pushed to the wallet automatically. */
  protected async claimInstructions(): Promise<TransactionInstruction[]> {
    return [];
  }

  private async solPriceUsd(): Promise<number> {
    const res = await fetch(`${JUP}/price/v3?ids=${SOL_MINT}`);
    const json = (await res.json()) as Record<string, { usdPrice: number }>;
    const price = json[SOL_MINT]?.usdPrice;
    if (!price) throw new Error('SOL price unavailable');
    return price;
  }

  async claimCreatorFees(): Promise<FeeClaim | null> {
    let signature = 'balance-delta';
    const ixs = await this.claimInstructions();
    if (ixs.length) signature = await sendAndConfirmTransaction(this.conn, new Transaction().add(...ixs), [this.fee]);

    const balance = await this.conn.getBalance(this.fee.publicKey);
    if (this.accountedLamports === null) {
      // First run after boot: whatever is already there was counted before.
      this.accountedLamports = balance;
      return null;
    }
    const delta = balance - this.accountedLamports;
    this.accountedLamports = balance;
    if (delta < 0.001 * LAMPORTS_PER_SOL) return null;

    const sol = delta / LAMPORTS_PER_SOL;
    return { usd: sol * (await this.solPriceUsd()), sol, signature };
  }

  async depositToVault(usd: number): Promise<string> {
    const reserve = CONFIG.feeWalletReserveSol * LAMPORTS_PER_SOL;
    const balance = await this.conn.getBalance(this.fee.publicKey);
    const lamports = Math.min(Math.floor((usd / (await this.solPriceUsd())) * LAMPORTS_PER_SOL), balance - reserve);
    if (lamports <= 0) throw new Error('fee wallet below reserve');

    const vaultAta = await getOrCreateAssociatedTokenAccount(this.conn, this.fee, this.usdc, this.vault.publicKey);
    const quote = await (
      await fetch(`${JUP}/swap/v1/quote?inputMint=${SOL_MINT}&outputMint=${this.usdc.toBase58()}&amount=${lamports}&slippageBps=100`)
    ).json();
    const swap = (await (
      await fetch(`${JUP}/swap/v1/swap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: this.fee.publicKey.toBase58(),
          destinationTokenAccount: vaultAta.address.toBase58(),
          wrapAndUnwrapSol: true,
        }),
      })
    ).json()) as { swapTransaction?: string };
    if (!swap.swapTransaction) throw new Error('Jupiter swap failed');

    const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
    tx.sign([this.fee]);
    const sig = await this.conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    await this.conn.confirmTransaction(sig, 'confirmed');
    this.accountedLamports = await this.conn.getBalance(this.fee.publicKey);
    return sig;
  }

  async payUsdc(to: string, usd: number): Promise<string> {
    const dest = new PublicKey(to);
    const from = await getOrCreateAssociatedTokenAccount(this.conn, this.vault, this.usdc, this.vault.publicKey);
    const toAta = await getOrCreateAssociatedTokenAccount(this.conn, this.vault, this.usdc, dest);
    const amount = BigInt(Math.round(usd * 10 ** USDC_DECIMALS));
    const ix = createTransferCheckedInstruction(from.address, this.usdc, toAta.address, this.vault.publicKey, amount, USDC_DECIMALS);
    return sendAndConfirmTransaction(this.conn, new Transaction().add(ix), [this.vault]);
  }

  async writeMemo(text: string): Promise<string> {
    const ix = new TransactionInstruction({
      programId: MEMO_PROGRAM,
      keys: [{ pubkey: this.fee.publicKey, isSigner: true, isWritable: true }],
      data: Buffer.from(text, 'utf8'),
    });
    return sendAndConfirmTransaction(this.conn, new Transaction().add(ix), [this.fee]);
  }

  async verifyTokenPayment(signature: string, toWallet: string, amount: number): Promise<boolean> {
    if (!CONFIG.tokenMint) return false;
    const tx = await this.conn.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    if (!tx?.meta || tx.meta.err) return false;
    if (tx.blockTime && Date.now() / 1000 - tx.blockTime > 86_400) return false;
    const match = (b: { mint: string; owner?: string }) => b.mint === CONFIG.tokenMint && b.owner === toWallet;
    const pre = tx.meta.preTokenBalances?.find(match)?.uiTokenAmount.uiAmount ?? 0;
    const post = tx.meta.postTokenBalances?.find(match)?.uiTokenAmount.uiAmount ?? 0;
    return post - pre >= amount - 1e-9;
  }

  isValidAddress(address: string): boolean {
    try {
      return PublicKey.isOnCurve(new PublicKey(address).toBytes());
    } catch {
      return false;
    }
  }
}

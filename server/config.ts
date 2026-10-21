import 'dotenv/config';

const env = process.env;
const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));

export const CONFIG = {
  port: num(env.PORT, 8787),
  adminToken: env.ADMIN_TOKEN || 'dev-admin',
  ipSalt: env.IP_SALT || 'dev-salt',
  dbPath: env.DB_PATH || './data/game.db',
  launchedDefault: env.LAUNCHED === 'true',
  launchAt: env.LAUNCH_AT || '',

  feeClaimIntervalSec: num(env.FEE_CLAIM_INTERVAL_SEC, 60),
  cardThresholdUsd: num(env.CARD_THRESHOLD_USD, 10),
  vaultShare: num(env.VAULT_SHARE, 0.5),
  usdPerGoldenBall: num(env.USD_PER_GOLDEN_BALL, 0.25),
  maxBallsPerDrop: num(env.MAX_BALLS_PER_DROP, 40),

  chainProvider: (env.CHAIN_PROVIDER || 'mock') as 'mock' | 'solana',
  cluster: env.SOLANA_CLUSTER || 'mainnet-beta',
  rpcUrl: env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  tokenMint: env.TOKEN_MINT || '',
  usdcMint: env.USDC_MINT || 'EPjFWyuyNv1qmEYfjEjQ9Ab4HgJs7jz8kRB2vPcAFNAG',
  feeWalletSecret: env.FEE_WALLET_SECRET_KEY || '',
  vaultWalletSecret: env.VAULT_WALLET_SECRET_KEY || '',
  feeWalletReserveSol: num(env.FEE_WALLET_RESERVE_SOL, 0.05),

  cardProvider: (env.CARD_PROVIDER || 'mock') as 'mock' | 'http',
  cardApiUrl: env.CARD_API_URL || '',
  cardApiKey: env.CARD_API_KEY || '',
};

export const explorerSuffix = CONFIG.cluster === 'mainnet-beta' ? '' : `?cluster=${CONFIG.cluster}`;

export interface CardListing {
  listingId: string;
  name: string;
  set: string;
  grade: string;
  priceUsd: number;
  valueUsd: number;
  /** Image URL, or "mock:<hue>" to have the server draw placeholder slab art. */
  image: string;
  /** Wallet the USDC payment goes to. */
  payTo: string;
}

/**
 * Buys real graded cards for the prize catalog (only when VAULT_AUTO_BUY is on). Winners claim
 * them with a claim code like every other catalog card, so there is no automatic delivery.
 * `MockCards` runs offline; `HttpCards` talks to a card marketplace API.
 */
export interface CardProvider {
  readonly name: string;
  /** Find the best card we can afford with `maxUsd`. */
  findCard(maxUsd: number): Promise<CardListing | null>;
  /** Tell the marketplace we paid; returns the card's on-chain mint. */
  confirmPurchase(listing: CardListing, paymentSig: string): Promise<{ mint: string }>;
}

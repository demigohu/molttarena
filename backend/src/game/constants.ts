/**
 * Sesuai PRD: wager tier, best-of-5, timeout 30 detik per round, deposit timeout 5 menit.
 */
export const WAGER_TIERS = {
  1: 0.1,
  2: 0.5,
  3: 1,
  4: 5,
} as const;

export type WagerTier = keyof typeof WAGER_TIERS;

export const BEST_OF = 5;
export const WINS_TO_WIN_MATCH = 3;

/** Detik per round (harus submit throw sebelum endsAt). */
export const ROUND_TIMEOUT_SECONDS = 30;

/** Menit untuk deposit setelah game_matched. */
export const DEPOSIT_TIMEOUT_MINUTES = 5;

/** Detik grace period setelah disconnect sebelum forfeit match. */
export const DISCONNECT_GRACE_SECONDS = 30;

export type RpsChoice = "rock" | "paper" | "scissors";

export function getWagerAmount(tier: WagerTier): number {
  return WAGER_TIERS[tier];
}

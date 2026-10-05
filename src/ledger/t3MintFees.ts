import type { Cell } from '@ton/core';

type MintFeeState = {
  totalSupply: string;
  balances: string[];
  fees: Cell;
};

const MAX_COINS = (1n << 120n) - 1n;

function amount(raw: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw Error('Invalid T3 coins');
  const value = BigInt(raw);
  if (value > MAX_COINS) throw Error('Invalid T3 coins');
  return value;
}

function basket(raw: string[]): bigint[] {
  if (raw.length !== 3) throw Error('Invalid T3 basket');
  return raw.map(amount);
}

function feeBuckets(cell: Cell) {
  const s = cell.beginParse();
  const proportional = [s.loadCoins(), s.loadCoins(), s.loadCoins()];
  const single = [s.loadCoins(), s.loadCoins(), s.loadCoins()];
  if (s.remainingBits || s.remainingRefs) throw Error('Invalid T3 fee buckets');
  return { proportional, single };
}

/** Exact attribution at the original mint execution, after its historical code
 * and before/after states have been authenticated. Delivery/retry transactions
 * cannot substitute for that execution. The native mint retains gross collateral
 * in balances and only adds the skim to the proportional fee bucket; observing
 * that transition avoids guessing fee exemptions or governed recap fee rates. */
export function mintFeesFromStateTransition(
  before: MintFeeState,
  after: MintFeeState,
  grossBasketRaw: string[],
  mintedRaw: string,
): string[] | null {
  try {
    const gross = basket(grossBasketRaw);
    const b = basket(before.balances);
    const a = basket(after.balances);
    const minted = amount(mintedRaw);
    if (minted === 0n || amount(after.totalSupply) - amount(before.totalSupply) !== minted)
      return null;
    if (a.some((value, i) => value - b[i] !== gross[i])) return null;

    const oldFees = feeBuckets(before.fees);
    const newFees = feeBuckets(after.fees);
    if (newFees.single.some((value, i) => value !== oldFees.single[i])) return null;
    const fees = newFees.proportional.map((value, i) => value - oldFees.proportional[i]);
    if (fees.some((value, i) => value < 0n || value > gross[i])) return null;
    return fees.map(String);
  } catch {
    return null;
  }
}

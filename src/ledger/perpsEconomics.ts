import type { PerpsRequest } from "./perpsWire";
import {
  perpsAccount,
  perpsPosition,
  perpsPending,
  type PerpsState,
  type PerpsMarket,
  type PerpsPosition,
} from "./perpsState";
const abs = (v: bigint) => (v < 0n ? -v : v),
  min = (a: bigint, b: bigint) => (a < b ? a : b),
  max = (a: bigint, b: bigint) => (a > b ? a : b);
const clamp128 = (v: bigint) => max(-(1n << 127n), min((1n << 127n) - 1n, v));
/** TVM DIV floors toward negative infinity; native BigInt division truncates toward zero. */
export function tvmDiv(a: bigint, b: bigint) {
  if (b === 0n || a < -(1n << 256n) || a >= 1n << 256n)
    throw Error("TVM arithmetic unavailable");
  const q = a / b,
    r = a % b;
  return r !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}
function fill(m: PerpsMarket, delta: bigint) {
  const ratio =
    BigInt(m.depthRaw) === 0n
      ? 0n
      : tvmDiv(delta * 1000000000n, BigInt(m.depthRaw));
  if (ratio < -(1n << 127n) || ratio >= 1n << 127n)
    throw Error("Perps ratio overflow");
  const linear = tvmDiv(BigInt(m.alphaRaw) * abs(ratio), 1000000000n),
    square = tvmDiv(abs(ratio) ** 2n, 1000000000n),
    quadratic = tvmDiv(BigInt(m.betaRaw) * square, 1000000000n);
  let premium = clamp128((linear + quadratic) * (ratio < 0n ? -1n : 1n));
  if (m.clampBps > 0)
    premium = max(-BigInt(m.clampBps), min(BigInt(m.clampBps), premium));
  const price = max(
    0n,
    BigInt(m.markRaw) + tvmDiv(BigInt(m.markRaw) * premium, 10000n),
  );
  return { price, notional: tvmDiv(abs(delta) * price, 1000000000n) };
}
export type PerpsEconomics = {
  outcome: "accepted" | "rejected" | "retry";
  fundingRaw: string;
  realizedPnlRaw: string;
  tradeFeeRaw: string;
  depositCollateralRaw: string;
  excessRaw: string;
  payoutContributionRaw: string;
  adlAbsorbedRaw: string;
  badDebtRaw: string;
  tradedNotionalRaw: string;
  executedSizeRaw: string;
};
export function perpsEconomics(
  before: PerpsState,
  after: PerpsState,
  owner: string,
  wallet: string,
  r: PerpsRequest,
  depositRaw: string,
): PerpsEconomics | null {
  try {
    const ba = perpsAccount(before, owner),
      aa = perpsAccount(after, owner),
      bp = perpsPosition(before, owner, r.marketId),
      ap = perpsPosition(after, owner, r.marketId),
      bm = before.markets.get(r.marketId),
      am = after.markets.get(r.marketId),
      bt = perpsPending(before, wallet),
      at = perpsPending(after, wallet);
    const debt = (t: typeof bt) =>
        t && [1, 2, 3, 10, 11, 12, 13].includes(t.kind)
          ? BigInt(t.amountRaw) + BigInt(t.queuedRaw)
          : 0n,
      payoutDelta = debt(at) - debt(bt),
      deposit = BigInt(depositRaw),
      sameAccount = JSON.stringify(ba) === JSON.stringify(aa),
      samePosition = JSON.stringify(bp) === JSON.stringify(ap);
    if (
      before.configHash !== after.configHash ||
      (bt && bt.owner !== owner) ||
      (at && at.owner !== owner)
    )
      return null;
    const result: PerpsEconomics = {
      outcome: "accepted",
      fundingRaw: "0",
      realizedPnlRaw: "0",
      tradeFeeRaw: "0",
      depositCollateralRaw: "0",
      excessRaw: "0",
      payoutContributionRaw: "0",
      adlAbsorbedRaw: "0",
      badDebtRaw: "0",
      tradedNotionalRaw: "0",
      executedSizeRaw: "0",
    };
    if (
      deposit > 0n &&
      sameAccount &&
      samePosition &&
      payoutDelta === deposit
    ) {
      result.outcome = "rejected";
      result.excessRaw = depositRaw;
      result.payoutContributionRaw = depositRaw;
      return result;
    }
    if (
      r.operation === "claim" &&
      bt &&
      sameAccount &&
      samePosition &&
      payoutDelta === 0n
    ) {
      result.outcome = "retry";
      return result;
    }
    if (
      !bm ||
      !am ||
      before.configHash !== after.configHash ||
      bm.pool !== am.pool ||
      bm.depthRaw !== am.depthRaw ||
      bm.fundingIndexRaw !== am.fundingIndexRaw ||
      bm.markRaw !== am.markRaw ||
      bm.alphaRaw !== am.alphaRaw ||
      bm.betaRaw !== am.betaRaw ||
      bm.clampBps !== am.clampBps ||
      bm.controlFeeDeltaBps !== am.controlFeeDeltaBps
    )
      return null;
    let collateral = BigInt(ba.collateralRaw),
      pending = BigInt(ba.pendingFundingRaw),
      count = ba.openPositionCount,
      cross = ba.crossMargin,
      position = bp ? { ...bp } : null,
      funding = 0n,
      pnl = 0n,
      fee = 0n,
      depositCollateral = 0n,
      excess = 0n,
      payout = 0n,
      cover = 0n,
      badDebt = 0n,
      traded = 0n;
    const settle = () => {
      if (!position) return;
      const size = BigInt(position.sizeRaw);
      funding = clamp128(
        tvmDiv(
          BigInt(position.entryNotionalRaw) *
            (BigInt(bm.fundingIndexRaw) -
              BigInt(position.lastFundingIndexRaw)) *
            (size > 0n ? -1n : size < 0n ? 1n : 0n),
          10000n,
        ),
      );
      if (funding > 0n) {
        const next = clamp128(pending + funding);
        funding = next - pending;
        pending = next;
      }
      if (funding < 0n) {
        const owed = -funding;
        if (collateral < owed && r.operation !== "liquidation")
          throw Error("Unfunded user settlement");
        badDebt += max(0n, owed - collateral);
        collateral = max(0n, collateral - owed);
        position.marginRaw = max(
          0n,
          BigInt(position.marginRaw) - owed,
        ).toString();
      }
      position.lastFundingIndexRaw = bm.fundingIndexRaw;
    };
    const pricePnl = (p: PerpsPosition, quantity: bigint, price: bigint) => {
      const entry = tvmDiv(
        BigInt(p.entryNotionalRaw) * 1000000000n,
        abs(BigInt(p.sizeRaw)),
      );
      return tvmDiv(
        (price - entry) * quantity * (BigInt(p.sizeRaw) > 0n ? 1n : -1n),
        1000000000n,
      );
    };
    const realize = (value: bigint) => {
      pnl += value;
      const next = collateral + value;
      if (next < 0n) {
        badDebt += -next;
        collateral = 0n;
      } else collateral = next;
    };
    const assess = () => {
      const bps = BigInt(
        Math.max(0, Math.min(10000, before.feeBps + bm.controlFeeDeltaBps)),
      );
      fee = tvmDiv(traded * bps, 10000n);
    };
    if (r.operation === "open") {
      if (
        (bp && BigInt(bp.sizeRaw) !== 0n) ||
        deposit === 0n ||
        BigInt(r.sizeRaw ?? "0") === 0n
      )
        return null;
      const f = fill(bm, BigInt(r.sizeRaw!));
      traded = f.notional;
      assess();
      depositCollateral = BigInt(r.marginRaw!);
      excess = deposit - depositCollateral - fee;
      if (excess < 0n) return null;
      collateral += depositCollateral;
      count++;
      payout = excess;
      position = {
        owner,
        marketId: r.marketId,
        sizeRaw: r.sizeRaw!,
        marginRaw: r.marginRaw!,
        entryNotionalRaw: f.notional.toString(),
        lastFundingIndexRaw: bm.fundingIndexRaw,
        flags: 0,
      };
    } else if (r.operation === "claim") {
      settle();
      if (pending <= 0n || bt) return null;
      payout = pending;
      pending = 0n;
    } else {
      if (!position) return null;
      if (r.operation === "modify") {
        const change = BigInt(r.marginRaw!);
        if (change > 0n) {
          if (deposit < change) return null;
          depositCollateral = change;
          excess = deposit - change;
          collateral += change;
          position.marginRaw = (BigInt(position.marginRaw) + change).toString();
        } else if (change < 0n) {
          if (
            deposit !== 0n ||
            collateral < -change ||
            BigInt(position.marginRaw) < -change
          )
            return null;
          collateral += change;
          position.marginRaw = (BigInt(position.marginRaw) + change).toString();
          payout = -change;
        } else if (deposit > 0n) return null;
        settle();
        let remaining = BigInt(r.sizeRaw!),
          released = 0n;
        for (let i = 0; remaining !== 0n && i < 2; i++) {
          const current = BigInt(position.sizeRaw);
          let chunk = remaining;
          if (
            current !== 0n &&
            current * chunk < 0n &&
            abs(chunk) > abs(current)
          )
            chunk = -current;
          const f = fill(bm, chunk);
          traded += f.notional;
          if (current === 0n || current * chunk > 0n) {
            position.sizeRaw = (current + chunk).toString();
            position.entryNotionalRaw = (
              BigInt(position.entryNotionalRaw) + f.notional
            ).toString();
          } else {
            const marginShare = tvmDiv(
                BigInt(position.marginRaw) * abs(chunk),
                abs(current),
              ),
              entryShare = tvmDiv(
                BigInt(position.entryNotionalRaw) * abs(chunk),
                abs(current),
              ),
              gain = pricePnl(position, abs(chunk), f.price);
            realize(gain);
            released += max(0n, marginShare + min(0n, gain));
            position.marginRaw = max(
              0n,
              BigInt(position.marginRaw) -
                marginShare -
                max(0n, -gain - marginShare),
            ).toString();
            position.entryNotionalRaw = (
              BigInt(position.entryNotionalRaw) - entryShare
            ).toString();
            position.sizeRaw = (current + chunk).toString();
            if (position.sizeRaw === "0") {
              position.marginRaw = "0";
              position.entryNotionalRaw = "0";
            }
          }
          remaining -= chunk;
        }
        if (remaining !== 0n) return null;
        assess();
        if (collateral < fee) return null;
        collateral -= fee;
        position.marginRaw = max(
          0n,
          BigInt(position.marginRaw) - fee,
        ).toString();
        const release = min(released, collateral);
        collateral -= release;
        payout += release + excess;
        if ((r.flags ?? 0) & 1) cross = 1;
        if ((r.flags ?? 0) & 2) cross = 0;
        if (bp?.sizeRaw === "0" && position.sizeRaw !== "0") count++;
        if (bp?.sizeRaw !== "0" && position.sizeRaw === "0") count--;
      } else {
        settle();
        if (r.operation === "add_margin") {
          depositCollateral = BigInt(r.marginRaw!);
          if (deposit < depositCollateral) return null;
          excess = deposit - depositCollateral;
          collateral += depositCollateral;
          position.marginRaw = (
            BigInt(position.marginRaw) + depositCollateral
          ).toString();
          payout = excess;
        } else if (r.operation === "remove_margin") {
          const withdrawal = BigInt(r.marginRaw!);
          if (
            deposit ||
            withdrawal <= 0n ||
            collateral < withdrawal ||
            BigInt(position.marginRaw) < withdrawal
          )
            return null;
          collateral -= withdrawal;
          position.marginRaw = (
            BigInt(position.marginRaw) - withdrawal
          ).toString();
          payout = withdrawal;
        } else {
          const size = BigInt(position.sizeRaw),
            newSize = ap ? BigInt(ap.sizeRaw) : 0n,
            quantity =
              r.operation === "close" ? abs(size) : abs(size) - abs(newSize);
          if (
            size === 0n ||
            quantity <= 0n ||
            quantity > abs(size) ||
            newSize * size < 0n
          )
            return null;
          if (r.operation === "liquidation" && quantity > BigInt(r.sizeRaw!))
            return null;
          if (
            r.operation === "adl" &&
            (quantity > abs(BigInt(r.sizeRaw!)) ||
              (tvmDiv(abs(size) * 2500n, 10000n) > 0n &&
                quantity > tvmDiv(abs(size) * 2500n, 10000n)))
          )
            return null;
          const f = fill(bm, -(size > 0n ? 1n : -1n) * quantity),
            gain = pricePnl(position, quantity, f.price),
            entryShare = tvmDiv(
              BigInt(position.entryNotionalRaw) * quantity,
              abs(size),
            );
          if (r.operation === "adl") {
            if (gain <= 0n) return null;
            pnl = gain;
            cover = min(gain, BigInt(bm.adlDeficitRaw));
            collateral += gain - cover;
            position.marginRaw = (
              BigInt(position.marginRaw) -
              tvmDiv(BigInt(position.marginRaw) * quantity, abs(size))
            ).toString();
          } else {
            realize(gain);
            if (r.operation === "liquidation")
              position.marginRaw = max(
                0n,
                BigInt(position.marginRaw) + min(0n, gain),
              ).toString();
          }
          position.sizeRaw = (
            size -
            (size > 0n ? 1n : -1n) * quantity
          ).toString();
          position.entryNotionalRaw = (
            BigInt(position.entryNotionalRaw) - entryShare
          ).toString();
          if (r.operation === "close") {
            traded = f.notional;
            assess();
            if (collateral < fee) return null;
            collateral -= fee;
          }
          if (position.sizeRaw === "0") {
            position.marginRaw = "0";
            position.entryNotionalRaw = "0";
            count--;
            if (count === 0 && collateral > 0n) {
              payout = collateral;
              collateral = 0n;
            }
          } else if (r.operation === "liquidation")
            position.marginRaw = min(
              BigInt(position.marginRaw),
              collateral,
            ).toString();
        }
      }
    }
    if (position?.sizeRaw === "0") position = null;
    if (
      collateral.toString() !== aa.collateralRaw ||
      pending.toString() !== aa.pendingFundingRaw ||
      count !== aa.openPositionCount ||
      cross !== aa.crossMargin ||
      JSON.stringify(position) !== JSON.stringify(ap) ||
      payout !== payoutDelta ||
      BigInt(am.adlDeficitRaw) !== BigInt(bm.adlDeficitRaw) + badDebt - cover
    )
      return null;
    if (at && at.owner !== owner) return null;
    return {
      ...result,
      fundingRaw: funding.toString(),
      realizedPnlRaw: pnl.toString(),
      tradeFeeRaw: fee.toString(),
      depositCollateralRaw: depositCollateral.toString(),
      excessRaw: excess.toString(),
      payoutContributionRaw: payout.toString(),
      adlAbsorbedRaw: cover.toString(),
      badDebtRaw: badDebt.toString(),
      tradedNotionalRaw: traded.toString(),
      executedSizeRaw: (
        (ap ? BigInt(ap.sizeRaw) : 0n) - (bp ? BigInt(bp.sizeRaw) : 0n)
      ).toString(),
    };
  } catch {
    return null;
  }
}

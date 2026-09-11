import { Address, Cell, Dictionary, type Slice } from "@ton/core";
import { perpsPositionKey, perpsTransferKey } from "./perpsWire";
const end = (s: Slice) => {
  if (s.remainingBits || s.remainingRefs)
    throw Error("Unsupported perps state layout");
};
const rawValue = {
  serialize: (c: Cell, b: any) => b.storeSlice(c.beginParse()),
  parse: (s: Slice) => {
    const c = s.asCell();
    s.skip(s.remainingBits);
    while (s.remainingRefs) s.loadRef();
    return c;
  },
};
export type PerpsAccount = {
  collateralRaw: string;
  pendingFundingRaw: string;
  crossMargin: number;
  referralLinked: number;
  openPositionCount: number;
};
export type PerpsPosition = {
  owner: string;
  marketId: number;
  sizeRaw: string;
  marginRaw: string;
  entryNotionalRaw: string;
  lastFundingIndexRaw: string;
  flags: number;
};
export type PerpsPending = {
  kind: number;
  owner: string | null;
  marketId: number;
  wireId: string;
  amountRaw: string;
  queuedRaw: string;
  recordedAt: string;
};
export type PerpsMarket = {
  pool: string;
  depthRaw: string;
  alphaRaw: string;
  betaRaw: string;
  fundingIndexRaw: string;
  markRaw: string;
  controlFeeDeltaBps: number;
  clampBps: number;
  adlDeficitRaw: string;
};
export type PerpsState = {
  root: string;
  walletCode: Cell;
  feeBps: number;
  feeTreasury: string | null;
  router: string | null;
  riskVault: string | null;
  configHash: string;
  dataHash: string;
  accounts: Map<string, PerpsAccount>;
  positions: Map<string, PerpsPosition>;
  markets: Map<number, PerpsMarket>;
  pending: Map<string, PerpsPending>;
};
export const emptyPerpsAccount = (): PerpsAccount => ({
  collateralRaw: "0",
  pendingFundingRaw: "0",
  crossMargin: 0,
  referralLinked: 0,
  openPositionCount: 0,
});
export function readPerpsState(boc: string): PerpsState {
  const cell = Cell.fromBase64(boc),
    s = cell.beginParse();
  if (s.remainingRefs !== 4) throw Error("Perps storage refs");
  const registry = s.loadRef(),
    maps = s.loadRef();
  s.skip(32 + 64 + 32 + 32 + 32 + 64 + 32 + 32 + 32 + 64 + 32);
  s.loadMaybeAddress();
  s.skip(32 + 64);
  const queues = s.loadRef();
  s.loadRef();
  end(s);
  const reg = registry.beginParse();
  reg.loadRef();
  const config = reg.loadRef();
  reg.loadRef();
  end(reg);
  const cfg = config.beginParse();
  for (let i = 0; i < 4; i++) cfg.loadMaybeAddress();
  const feeBps = cfg.loadUint(32);
  cfg.skip(64 + 32 + 32);
  const routerCell = cfg.loadRef();
  cfg.loadRef();
  cfg.loadRef();
  cfg.loadRef();
  if (cfg.loadUint(32) !== 1) throw Error("Perps config version");
  end(cfg);
  const r = routerCell.beginParse(),
    router = r.loadMaybeAddress()?.toRawString() ?? null;
  r.loadMaybeAddress();
  const feeTreasury = r.loadMaybeAddress()?.toRawString() ?? null,
    extras = r.loadRef().beginParse();
  end(r);
  const mask = extras.loadUint(8);
  if (mask & 1 || !(mask & 128)) throw Error("Perps configured collateral");
  if (mask & 2) extras.loadMaybeAddress();
  if (mask & 4) extras.skip(32);
  const riskVault =
    mask & 8 ? (extras.loadMaybeAddress()?.toRawString() ?? null) : null;
  if (mask & 16) extras.skip(16);
  if (mask & 96) {
    const clmm = extras.loadRef().beginParse();
    if (mask & 32) clmm.loadMaybeAddress();
    if (mask & 64) clmm.skip(256);
    end(clmm);
  }
  const token = extras.loadRef().beginParse(),
    root = token.loadAddress().toRawString(),
    walletCode = token.loadRef();
  end(token);
  end(extras);
  const m = maps.beginParse(),
    marketCell = m.loadRef(),
    accountCell = m.loadRef(),
    positionCell = m.loadRef();
  end(m);
  const accounts = new Map<string, PerpsAccount>();
  for (const [key, value] of accountCell
    .beginParse()
    .loadDict(Dictionary.Keys.Address(), rawValue)) {
    const a = value.beginParse();
    const v = {
      collateralRaw: a.loadCoins().toString(),
      pendingFundingRaw: a.loadIntBig(128).toString(),
      crossMargin: a.loadUint(8),
      referralLinked: a.loadUint(8),
      openPositionCount: a.loadUint(32),
    };
    end(a);
    accounts.set(key.toRawString(), v);
  }
  const positions = new Map<string, PerpsPosition>();
  for (const [key, value] of positionCell
    .beginParse()
    .loadDict(Dictionary.Keys.BigUint(256), rawValue)) {
    const p = value.beginParse(),
      v = {
        owner: p.loadAddress().toRawString(),
        marketId: p.loadUint(32),
        sizeRaw: p.loadIntBig(128).toString(),
        marginRaw: p.loadCoins().toString(),
        entryNotionalRaw: p.loadCoins().toString(),
        lastFundingIndexRaw: p.loadIntBig(128).toString(),
        flags: p.loadUint(32),
      };
    end(p);
    const id = key.toString(16).padStart(64, "0");
    if (id !== perpsPositionKey(v.owner, v.marketId))
      throw Error("Perps owner/position key mismatch");
    positions.set(id, v);
  }
  const markets = new Map<number, PerpsMarket>();
  for (const [key, value] of marketCell
    .beginParse()
    .loadDict(Dictionary.Keys.Uint(32), rawValue)) {
    const c = value.beginParse(),
      pool = c.loadAddress().toRawString(),
      p = c.loadRef().beginParse(),
      st = c.loadRef().beginParse();
    end(c);
    const depthRaw = p.loadCoins().toString(),
      alphaRaw = p.loadIntBig(128).toString(),
      betaRaw = p.loadIntBig(128).toString();
    p.skip(64);
    p.loadCoins();
    p.skip(32);
    p.loadCoins();
    p.skip(64 + 32 + 8);
    p.loadRef();
    end(p);
    const fundingIndexRaw = st.loadIntBig(128).toString();
    st.skip(64);
    st.loadCoins();
    st.loadCoins();
    st.skip(1);
    st.loadCoins();
    st.skip(64);
    const markRaw = st.loadCoins().toString();
    st.skip(64);
    const adlDeficitRaw = st.loadCoins().toString();
    st.skip(32);
    st.loadCoins();
    st.loadCoins();
    const extra = st.loadRef().beginParse();
    end(st);
    extra.skip(32 * 4 + 64 + 32 + 32 + 32 + 64 + 32 + 32);
    const controlFeeDeltaBps = extra.loadInt(32),
      clampBps = extra.loadUint(32);
    extra.skip(64 + 1);
    extra.loadCoins();
    extra.loadCoins();
    extra.loadCoins();
    extra.skip(64);
    extra.loadCoins();
    const hashes = extra.loadRef().beginParse();
    hashes.skip(256 + 256 + 64 + 256);
    end(hashes);
    end(extra);
    markets.set(key, {
      pool,
      depthRaw,
      alphaRaw,
      betaRaw,
      fundingIndexRaw,
      markRaw,
      controlFeeDeltaBps,
      clampBps,
      adlDeficitRaw,
    });
  }
  const q = queues.beginParse();
  q.loadRef();
  q.loadRef();
  const pendingCell = q.loadRef();
  q.loadRef();
  end(q);
  const pending = new Map<string, PerpsPending>();
  for (const [key, value] of pendingCell
    .beginParse()
    .loadDict(Dictionary.Keys.BigUint(256), rawValue)) {
    const p = value.beginParse(),
      v = {
        kind: p.loadUint(8),
        owner: p.loadMaybeAddress()?.toRawString() ?? null,
        marketId: p.loadUint(32),
        wireId: p.loadUintBig(64).toString(),
        amountRaw: p.loadCoins().toString(),
        queuedRaw: p.loadCoins().toString(),
        recordedAt: p.loadIntBig(64).toString(),
      };
    end(p);
    pending.set(key.toString(16).padStart(64, "0"), v);
  }
  return {
    root,
    walletCode,
    feeBps,
    router,
    feeTreasury,
    riskVault,
    configHash: config.hash().toString("hex"),
    dataHash: cell.hash().toString("hex"),
    accounts,
    positions,
    markets,
    pending,
  };
}
export const perpsAccount = (s: PerpsState, owner: string) =>
  s.accounts.get(owner) ?? emptyPerpsAccount();
export const perpsPosition = (s: PerpsState, owner: string, marketId: number) =>
  s.positions.get(perpsPositionKey(owner, marketId)) ?? null;
export const perpsPending = (s: PerpsState, wallet: string) =>
  s.pending.get(perpsTransferKey(wallet)) ?? null;

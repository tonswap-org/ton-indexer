import { Cell, Dictionary, type Slice } from '@ton/core';
import { validJettonWalletProfile, type RuntimeReleaseManifest } from '../config/runtimeManifest';
import { ProductEvidenceError } from './productEvidence';
export function perpsCheck(value: unknown): asserts value { if (!value) throw new ProductEvidenceError(503, 'upstream_unavailable'); }
const slice = (c: Cell) => { perpsCheck(!c.isExotic); return c.beginParse(); };
const address = (s: Slice) => { const a = s.loadAddress(); perpsCheck(a.workChain === 0); return a.toRawString(); };
const readonly = <T>(parse: (s: Slice) => T) => ({ serialize() { throw Error('Read-only current Perps state'); }, parse });
function managed(cell: Cell, manifest: RuntimeReleaseManifest) {
  const s = slice(cell), slots = s.loadDict(Dictionary.Keys.Uint(8), readonly(q => {
    const master = address(q), wallet = q.loadMaybeAddress(), gas = q.loadUint(32), gram = q.loadCoins(), optional = q.loadBit(), b = slice(q.loadRef());
    const budget: Record<string, number | boolean> = {};
    for (const [key, width] of [['senderGas',32],['walletBounceGas',32],['burnWalletGas',32],['smallPayloadCells',16],['largeWalletGas',32],['largeSenderGas',32],['rentSeconds',32],['rentBits',32],['rentCells',16],['initBits',32],['initCells',16],['initCopies',8],['transferBits',16],['transferCells',8],['transferCopies',8]] as const) budget[key] = b.loadUint(width);
    budget.creditProtection = b.loadBit(); b.endParse(); q.endParse();
    perpsCheck(validJettonWalletProfile(gas, gram.toString(), budget) && (!wallet || wallet.workChain === 0));
    return { master, wallet: wallet?.toRawString() ?? null, optional };
  }));
  s.loadMaybeRef(); s.loadDict(Dictionary.Keys.Uint(8), Dictionary.Values.Cell()); s.endParse();
  perpsCheck(slots.size === 1 && slots.get(0)?.master === manifest.contracts.T3Hub?.address && !slots.get(0)?.optional);
  return slots.get(0)!;
}
/** Current PxStorage identity. Business position economics are proved separately
 * from these original transport boundaries, never by the current state alone. */
export function readCurrentPerpsEngine(data: Cell, manifest: RuntimeReleaseManifest) {
  const s = slice(data), governance = address(s); s.loadBit(); const p = slice(s.loadRef());
  const fee = address(p), risk = address(p), treasury = address(p), bucket = p.loadUint(16); p.endParse();
  const slot = managed(s.loadRef(), manifest); slice(s.loadRef()); const b = slice(s.loadRef()); s.endParse();
  perpsCheck(governance === manifest.contracts.Governance?.address && fee === manifest.contracts.FeeRouter?.address
    && risk === manifest.contracts.RiskVault?.address && treasury === manifest.contracts.Treasury?.address && bucket === 1);
  b.loadUintBig(64); const feeBps = b.loadUint(16), pendingCount = b.loadUint(16), settleCount = b.loadUint(16), positionCount = b.loadUint(8);
  for (let i = 0; i < 6; i++) b.loadCoins();
  const v = slice(b.loadRef()), markets = v.loadDict(Dictionary.Keys.Uint(32), Dictionary.Values.Cell());
  v.loadDict(Dictionary.Keys.Uint(8), Dictionary.Values.Uint(32)); v.endParse();
  const positions = b.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell()), pending = b.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell()), settlements = b.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell()); b.endParse();
  perpsCheck(feeBps <= 1000 && positionCount <= 30 && pendingCount <= 512 && settleCount <= 542
    && positions.size === positionCount && pending.size === pendingCount && settlements.size === settleCount && markets.size <= 4);
  const pools = new Map<number, string>(); let cap = 0n;
  for (const [id, cell] of markets) {
    const m = slice(cell), pool = address(m), params = slice(m.loadRef()), totals = slice(m.loadRef()), funding = slice(m.loadRef()); m.endParse();
    const depth = params.loadCoins(), oiCap = params.loadCoins(), alpha = params.loadIntBig(128), beta = params.loadIntBig(128), leverage = params.loadUint(32), maintenance = params.loadUint(32), fundingCap = params.loadUint(32); params.endParse();
    for (let i = 0; i < 3; i++) totals.loadCoins(); totals.endParse(); funding.loadIntBig(128); funding.loadIntBig(64); funding.loadIntBig(64); for (let i = 0; i < 3; i++) funding.loadUintBig(64); funding.endParse();
    perpsCheck(id >= 1 && id <= 4 && manifest.perpsMarkets.find(m => m.marketId === id)?.pool === pool && depth > 0n && oiCap <= 22500000000n
      && alpha >= 0n && alpha <= 10000n && beta >= 0n && beta <= 10000n && leverage >= 1 && leverage <= 10000 && maintenance >= 1 && maintenance <= 20000 && fundingCap >= 1 && fundingCap <= 1000);
    cap += oiCap; pools.set(id, pool);
  }
  perpsCheck(cap <= 22500000000n); return { slot, pools };
}
export function readCurrentPerpsRiskVault(data: Cell, manifest: RuntimeReleaseManifest, current = false) {
  const s = slice(data), governance = address(s); s.loadBit(); const treasury = address(s), slot = managed(s.loadRef(), manifest); slice(s.loadRef());
  perpsCheck(governance === manifest.contracts.Governance?.address && treasury === manifest.contracts.Treasury?.address);
  const buckets = s.loadDict(Dictionary.Keys.Uint(16), readonly(q => {
    const controller = address(q), payoutHook = address(q); q.loadCoins(); const totals = slice(q.loadRef()); q.endParse();
    for (let i = 0; i < 3; i++) totals.loadCoins(); totals.endParse(); return { controller, payoutHook };
  }));
  const liabilities = s.loadDict(Dictionary.Keys.BigUint(256), readonly(q => {
    q.loadCoins(); q.loadCoins(); q.loadUintBig(64); q.loadUint(8); q.loadUint(16); q.loadCoins(); q.loadBit(); q.loadUint(32); q.loadCoins(); q.endParse(); return true;
  })), count = s.loadUint(16); s.endParse();
  const bucket = buckets.get(1); perpsCheck(count === liabilities.size && count <= 16384 && (!current || bucket)
    && (!bucket || bucket.controller === manifest.contracts.PerpsEngine?.address && bucket.payoutHook === manifest.contracts.PerpsEngine?.address));
  return { slot };
}

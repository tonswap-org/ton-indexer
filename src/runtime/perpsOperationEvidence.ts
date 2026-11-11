import { beginCell, type Cell } from '@ton/core';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { createJettonWalletReader } from '../data/jettonWallet';
import { activeOrderAccount, orderShard, verifyOrderTransaction } from '../orders/evidence';
import { createPhysicalEvidenceReader, type PhysicalEvidenceStore } from './physicalEvidence';
import { boundProductResponse, collectProductPhysicalGraph, productAddress, productCell, productDispatch, productUint,
  ProductEvidenceError, PRODUCT_EVIDENCE_LIMITS, requireProduct, type ProductDispatch, type ProductPhysicalGraph } from './productEvidence';
import { perpsCheck, readCurrentPerpsEngine, readCurrentPerpsRiskVault } from './perpsEvidenceState';
const ops = { open: 0x50584f50, increase: 0x50584d44, addMargin: 0x5058414d, removeMargin: 0x5058524d, close: 0x5058434c, funding: 0x50584643 };
export type CurrentPerpsEvidenceRequest = { network: string; releaseId: string; manifestHash: string; owner: string; engine: string; riskVault: string;
  kind: keyof typeof ops; marketId: number; queryId: string; gen: string | null; depositRaw: string; sourceWallet: string | null;
  bodyBoc: string; bodyHash: string; valueNano: string; createdAt: number; dispatch: ProductDispatch };
function readTrade(body: Cell) {
  const s = body.beginParse(), op = s.loadUint(32), kind = (Object.keys(ops) as Array<keyof typeof ops>).find(k => ops[k] === op); requireProduct(kind);
  const query = s.loadUintBig(64), market = s.loadUint(32); requireProduct(market >= 1 && market <= 4);
  let gen: bigint | null = null, deadline = 0;
  if (kind !== 'open') { gen = s.loadUintBig(64); deadline = s.loadUint(32); requireProduct(gen > 0n); }
  if (kind === 'open' || kind === 'increase' || kind === 'close') {
    const size = s.loadIntBig(128), limit = s.loadCoins(); requireProduct(size > -(1n << 127n) && (kind === 'close' || size !== 0n) && limit > 0n);
  }
  if (kind === 'open') { const leverage = s.loadUint(32); requireProduct(leverage >= 1 && leverage <= 10000); deadline = s.loadUint(32); }
  if (kind === 'removeMargin') requireProduct(s.loadCoins() > 0n);
  requireProduct(deadline > 0); s.endParse(); return { kind, query, market, gen };
}
export function readPerpsOperationRequest(value: unknown, manifest: RuntimeReleaseManifest) {
  try {
    requireProduct(value && typeof value === 'object' && !Array.isArray(value)); const v = value as Record<string, unknown>;
    requireProduct(Object.keys(v).sort().join() === ['network','releaseId','manifestHash','owner','engine','riskVault','kind','marketId','queryId','gen','depositRaw','sourceWallet','bodyBoc','bodyHash','valueNano','createdAt','dispatch'].sort().join());
    if (v.network !== manifest.network.slice(4) || v.releaseId !== manifest.releaseId || v.manifestHash !== manifest.manifestHash
      || v.engine !== manifest.contracts.PerpsEngine?.address || v.riskVault !== manifest.contracts.RiskVault?.address) throw new ProductEvidenceError(409, 'release_mismatch');
    for (const key of ['owner','engine','riskVault']) productAddress(v[key]); if (v.sourceWallet !== null) productAddress(v.sourceWallet);
    const query = productUint(v.queryId, 64), gen = v.gen === null ? null : productUint(v.gen, 64, true), deposit = productUint(v.depositRaw, 120), dispatch = productDispatch(v.dispatch);
    productUint(v.valueNano, 120, true); requireProduct(v.valueNano === dispatch.valueNano && Number.isSafeInteger(v.createdAt) && Number(v.createdAt) > 0);
    requireProduct(Number.isInteger(v.marketId) && manifest.perpsMarkets.some(m => m.marketId === v.marketId));
    const body = productCell(v.bodyBoc, v.bodyHash); let command = body;
    if (v.sourceWallet !== null) {
      const s = body.beginParse(); requireProduct(deposit > 0n && s.loadUint(32) === 0x0f8a7ea5 && s.loadUintBig(64) === query && s.loadCoins() === deposit
        && s.loadAddress().toRawString() === v.engine && s.loadMaybeAddress()?.toRawString() === v.owner && !s.loadMaybeRef() && s.loadCoins() > 0n);
      const ref = s.loadBit(); command = ref ? s.loadRef() : beginCell().storeSlice(s).endCell(); if (ref) s.endParse();
    } else requireProduct(deposit === 0n);
    const trade = readTrade(command); requireProduct(trade.kind === v.kind && trade.query === query && trade.market === v.marketId && trade.gen === gen
      && (v.sourceWallet === null || ['open','increase','addMargin'].includes(trade.kind)) && (!['open','addMargin'].includes(trade.kind) || deposit > 0n));
    return { request: structuredClone(v) as CurrentPerpsEvidenceRequest, body };
  } catch (error) { if (error instanceof ProductEvidenceError) throw error; throw new ProductEvidenceError(400, 'bad_request'); }
}
export async function readPerpsEvidenceContext(manifest: RuntimeReleaseManifest, source: ChainSource, store: PhysicalEvidenceStore,
  parsed: ReturnType<typeof readPerpsOperationRequest>, signal?: AbortSignal) {
  signal?.throwIfAborted(); perpsCheck(`ton:${source.network}` === manifest.network);
  const p = parsed.request, head = await source.head({ signal }); assertFreshHeadTime(head.utime);
  const reader = createPhysicalEvidenceReader(source, store, head, { signal, newTransactions: PRODUCT_EVIDENCE_LIMITS.newTransactions });
  const engine = readCurrentPerpsEngine(activeOrderAccount(orderShard((await reader.current(p.engine)).shardAccountBoc!, p.engine).shard, manifest.contracts.PerpsEngine!.codeHash).data, manifest);
  const riskShard = orderShard((await reader.current(p.riskVault)).shardAccountBoc!, p.riskVault).shard;
  const frozenRisk = riskShard.account?.storage.state.type === 'frozen';
  const risk = frozenRisk ? null : readCurrentPerpsRiskVault(activeOrderAccount(riskShard, manifest.contracts.RiskVault!.codeHash).data, manifest, true);
  perpsCheck(engine.pools.has(p.marketId)); const t3 = manifest.tokens.find(t => t.symbol === 'T3'); perpsCheck(t3 && t3.root === manifest.contracts.T3Hub?.address);
  const wallets = createJettonWalletReader({ source, tokens: [{ master: t3.root, masterCodeHash: t3.masterCodeHash, walletCodeHash: t3.walletCodeHash }] });
  const [ownerWallet, engineWallet, riskWallet] = await Promise.all([p.owner, p.engine, p.riskVault].map(owner => wallets.identity(t3.root, owner, { at: head, signal })));
  perpsCheck(engine.slot.wallet === engineWallet.wallet && (!risk || risk.slot.wallet === riskWallet.wallet));
  requireProduct(p.sourceWallet === null || p.sourceWallet === ownerWallet.wallet);
  const pins = new Map([[p.engine, manifest.contracts.PerpsEngine!.codeHash], [p.riskVault, manifest.contracts.RiskVault!.codeHash],
    ...[...engine.pools.values()].map(pool => [pool, manifest.templates.DlmmPool] as [string, string])]);
  return { head, reader, pins, t3, allowFrozenPins: new Set(frozenRisk ? [p.riskVault] : []), wallets: [
    { role: 'engine' as const, owner: p.engine, address: engineWallet.wallet }, { role: 'risk-vault' as const, owner: p.riskVault, address: riskWallet.wallet },
    { role: 'owner' as const, owner: p.owner, address: ownerWallet.wallet }],
    completeAccounts: [p.engine, p.riskVault, engineWallet.wallet, riskWallet.wallet], includeAccounts: [ownerWallet.wallet] };
}
export function verifyPerpsEvidenceHistory(manifest: RuntimeReleaseManifest, context: Awaited<ReturnType<typeof readPerpsEvidenceContext>>, rows: ProductPhysicalGraph['transactions']) {
  for (const row of rows) if (row.account === manifest.contracts.PerpsEngine?.address || row.account === manifest.contracts.RiskVault?.address) {
    const tx = verifyOrderTransaction(row), engine = row.account === manifest.contracts.PerpsEngine!.address;
    const expected = context.wallets.find(w => w.role === (engine ? 'engine' : 'risk-vault'))!;
    for (const shard of [tx.before, tx.after]) if (shard.account?.storage.state.type === 'active') {
      const data = activeOrderAccount(shard, context.pins.get(row.account)!).data;
      const state = engine ? readCurrentPerpsEngine(data, manifest) : readCurrentPerpsRiskVault(data, manifest);
      perpsCheck(state.slot.wallet === null || state.slot.wallet === expected.address);
    }
  }
}
export type CurrentPerpsOperationEvidence = ProductPhysicalGraph & { schema: 'tonswap-perps-operation-evidence-v1'; releaseId: string; manifestHash: string;
  asOf: { masterchainSeqno: number; unixTime: number; blockRootHash: string }; request: { kind: CurrentPerpsEvidenceRequest['kind']; owner: string; bodyHash: string } };
export async function collectPerpsOperationEvidence(manifest: RuntimeReleaseManifest, source: ChainSource, store: PhysicalEvidenceStore,
  parsed: ReturnType<typeof readPerpsOperationRequest>, signal?: AbortSignal): Promise<CurrentPerpsOperationEvidence> {
  const p = parsed.request, c = await readPerpsEvidenceContext(manifest, source, store, parsed, signal);
  const graph = await collectProductPhysicalGraph(source, store, c.head, { owner: p.owner, target: p.sourceWallet ?? p.engine, body: parsed.body, dispatch: p.dispatch,
    pins: c.pins, completeAccounts: c.completeAccounts, includeAccounts: c.includeAccounts, allowFrozenPins: c.allowFrozenPins, reader: c.reader }, signal);
  verifyPerpsEvidenceHistory(manifest, c, graph.transactions);
  assertFreshHeadTime(c.head.utime); signal?.throwIfAborted(); return boundProductResponse<CurrentPerpsOperationEvidence>({ schema: 'tonswap-perps-operation-evidence-v1',
    releaseId: manifest.releaseId, manifestHash: manifest.manifestHash, asOf: { masterchainSeqno: c.head.seqno, unixTime: c.head.utime, blockRootHash: c.head.rootHashHex },
    request: { kind: p.kind, owner: p.owner, bodyHash: p.bodyHash }, ...graph }, p.engine);
}

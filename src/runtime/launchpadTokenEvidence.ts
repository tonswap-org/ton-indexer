import { beginCell, CellType, contractAddress, loadMessage, loadStateInit, storeStateInit } from '@ton/core';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { createJettonWalletReader } from '../data/jettonWallet';
import { verifyOrderTransaction } from '../orders/evidence';
import { createPhysicalEvidenceReader, type PhysicalEvidenceStore } from './physicalEvidence';
import { boundProductResponse, collectProductPhysicalGraph, productAddress, productCell, productDispatch, productUint,
  ProductEvidenceError, PRODUCT_EVIDENCE_LIMITS, requireProduct, type ProductDispatch, type ProductPhysicalGraph } from './productEvidence';

export type CurrentLaunchpadTokenRequest = { network: string; releaseId: string; manifestHash: string; owner: string; root: string; wallet: string;
  masterCodeHash: string; walletCodeHash: string; amountRaw: string; queryId: string; bodyBoc: string; bodyHash: string;
  stateInitBoc: string; stateInitHash: string; valueNano: string; createdAt: number; dispatch: ProductDispatch };
export function readLaunchpadTokenRequest(value: unknown, manifest: RuntimeReleaseManifest) {
  try {
    requireProduct(value && typeof value === 'object' && !Array.isArray(value)); const v = value as Record<string, unknown>;
    requireProduct(Object.keys(v).sort().join() === ['network','releaseId','manifestHash','owner','root','wallet','masterCodeHash','walletCodeHash',
      'amountRaw','queryId','bodyBoc','bodyHash','stateInitBoc','stateInitHash','valueNano','createdAt','dispatch'].sort().join());
    if (v.network !== manifest.network.slice(4) || v.releaseId !== manifest.releaseId || v.manifestHash !== manifest.manifestHash
      || v.masterCodeHash !== manifest.templates.JettonV21Minter || v.walletCodeHash !== manifest.templates.JettonV21Wallet)
      throw new ProductEvidenceError(409, 'release_mismatch');
    for (const key of ['owner','root','wallet']) productAddress(v[key]);
    const amount = productUint(v.amountRaw, 120, true), query = productUint(v.queryId, 64), dispatch = productDispatch(v.dispatch);
    productUint(v.valueNano, 120, true); requireProduct(v.valueNano === dispatch.valueNano && Number.isSafeInteger(v.createdAt) && Number(v.createdAt) > 0);
    const body = productCell(v.bodyBoc, v.bodyHash), stateInit = productCell(v.stateInitBoc, v.stateInitHash), i = stateInit.beginParse(), init = loadStateInit(i); i.endParse();
    requireProduct(init.code && init.data && init.splitDepth == null && init.special == null && (!init.libraries || init.libraries.size === 0)
      && init.code.hash().toString('hex') === v.masterCodeHash && contractAddress(0, init).toRawString() === v.root
      && beginCell().store(storeStateInit(init)).endCell().equals(stateInit));
    const data = init.data.beginParse(); requireProduct(data.loadCoins() === 0n && data.loadAddress().toRawString() === v.owner && data.loadMaybeAddress() === null);
    const metadata = data.loadRef(); data.endParse(); requireProduct(metadata.beginParse().loadUint(8) === 0);
    const s = body.beginParse(); requireProduct(s.loadUint(32) === 0x642b7d07 && s.loadUintBig(64) === query && s.loadAddress().toRawString() === v.owner && s.loadCoins() > 0n);
    const transfer = s.loadRef().beginParse(); s.endParse();
    requireProduct(transfer.loadUint(32) === 0x178d4519 && transfer.loadUintBig(64) === query && transfer.loadCoins() === amount
      && transfer.loadMaybeAddress() === null && transfer.loadAddress().toRawString() === v.owner && transfer.loadCoins() === 0n && !transfer.loadBit()); transfer.endParse();
    return { request: structuredClone(v) as CurrentLaunchpadTokenRequest, body, stateInit };
  } catch (error) { if (error instanceof ProductEvidenceError) throw error; throw new ProductEvidenceError(400, 'bad_request'); }
}
export type CurrentLaunchpadTokenEvidence = ProductPhysicalGraph & { schema: 'tonswap-launchpad-token-evidence-v1'; releaseId: string; manifestHash: string;
  asOf: { masterchainSeqno: number; unixTime: number; blockRootHash: string }; request: { owner: string; bodyHash: string } };
export async function collectLaunchpadTokenEvidence(manifest: RuntimeReleaseManifest, source: ChainSource, store: PhysicalEvidenceStore,
  parsed: ReturnType<typeof readLaunchpadTokenRequest>, signal?: AbortSignal): Promise<CurrentLaunchpadTokenEvidence> {
  signal?.throwIfAborted(); if (`ton:${source.network}` !== manifest.network) throw new ProductEvidenceError(503, 'upstream_unavailable');
  const p = parsed.request, head = await source.head({ signal }); assertFreshHeadTime(head.utime);
  const reader = createPhysicalEvidenceReader(source, store, head, { signal, newTransactions: PRODUCT_EVIDENCE_LIMITS.newTransactions });
  const response = (graph: ProductPhysicalGraph) => { assertFreshHeadTime(head.utime); signal?.throwIfAborted(); return boundProductResponse<CurrentLaunchpadTokenEvidence>({ schema: 'tonswap-launchpad-token-evidence-v1',
    releaseId: manifest.releaseId, manifestHash: manifest.manifestHash, asOf: { masterchainSeqno: head.seqno, unixTime: head.utime, blockRootHash: head.rootHashHex },
    request: { owner: p.owner, bodyHash: p.bodyHash }, ...graph }, p.root); };
  try {
    const original = verifyOrderTransaction((await reader.exact(p.owner, p.dispatch.lt, p.dispatch.hash)).evidence);
    const messages = [...original.outgoing.values()].map(cell => loadMessage(cell.beginParse())).filter(m => m.info.type === 'internal' && !m.info.bounced
      && m.info.src.toRawString() === p.owner && m.info.dest.toRawString() === p.root && m.info.value.coins.toString() === p.dispatch.valueNano && m.body.equals(parsed.body));
    if (!original.succeeded || messages.length !== 1 || !messages[0].init || !beginCell().store(storeStateInit(messages[0].init)).endCell().equals(parsed.stateInit))
      throw Error('Original creation StateInit differs');
  } catch (error) {
    if (signal?.aborted) throw error;
    return response({ coverage: { complete: false, gaps: [{ code: 'original_creation_dispatch_unavailable', account: p.owner, lt: p.dispatch.lt }] }, transactions: [] });
  }
  const wallets = createJettonWalletReader({ source, tokens: [{ master: p.root, masterCodeHash: p.masterCodeHash, walletCodeHash: p.walletCodeHash }] });
  const identity = await wallets.identity(p.root, p.owner, { at: head, signal });
  requireProduct(identity.wallet === p.wallet);
  const graph = await collectProductPhysicalGraph(source, store, head, { owner: p.owner, target: p.root, body: parsed.body, dispatch: p.dispatch,
    pins: new Map([[p.root, p.masterCodeHash]]), completeAccounts: [p.root, p.wallet], reader }, signal);
  // A refused mint may leave the canonical wallet uninitialized or frozen.
  // Every original active wallet boundary still has the exact installed code
  // and owner/master identity; current inactivity cannot invent a credit.
  for (const evidence of graph.transactions) if (evidence.account === p.wallet) {
    const original = verifyOrderTransaction(evidence);
    for (const shard of [original.before, original.after]) if (shard.account?.storage.state.type === 'active') {
      const state = shard.account.storage.state.state;
      if (state.splitDepth !== 8 || state.special != null || state.libraries && state.libraries.size > 0 || !state.code || !state.data
        || ![CellType.Ordinary, CellType.Library].includes(state.code.type) || state.code.hash().toString('hex') !== p.walletCodeHash || state.data.isExotic)
        throw new ProductEvidenceError(503, 'upstream_unavailable');
      const s = state.data.beginParse();
      s.loadCoins(); if (s.loadAddress().toRawString() !== p.owner || s.loadAddress().toRawString() !== p.root) throw new ProductEvidenceError(503, 'upstream_unavailable'); s.endParse();
    }
  }
  assertFreshHeadTime(head.utime); signal?.throwIfAborted(); return response(graph);
}

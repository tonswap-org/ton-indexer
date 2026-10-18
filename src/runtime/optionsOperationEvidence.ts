import { TupleReader, beginCell, type Slice } from '@ton/core';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { ChainHead, ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { createJettonWalletReader } from '../data/jettonWallet';
import { activeOrderAccount, orderShard } from '../orders/evidence';
import type { PhysicalEvidenceStore } from './physicalEvidence';
import { ProductEvidenceError, requireProduct, productUint, productAddress, productCell, productDispatch,
  collectProductPhysicalGraph, boundProductResponse, type ProductDispatch, type ProductPhysicalGraph } from './productEvidence';

export type CurrentOptionsEvidenceRequest = { network: string; releaseId: string; manifestHash: string;
  kind: 'buy' | 'fund' | 'withdraw' | 'payout' | 'owed'; owner: string; factory: string; vault: string; series: string | null;
  seriesId: string; queryId: string; amountRaw: string; notionalRaw: string | null; tokenId: string | null;
  sourceWallet: string | null; bodyBoc: string; bodyHash: string; valueNano: string; createdAt: number; dispatch: ProductDispatch };
const wireAddress = (s: Slice) => { requireProduct(s.preloadUint(11) === 0b10000000000); return s.loadAddress().toRawString(); };
export function readOptionsOperationRequest(value: unknown, manifest: RuntimeReleaseManifest) {
  try {
    requireProduct(value && typeof value === 'object' && !Array.isArray(value)); const x = value as Record<string, unknown>;
    requireProduct(Object.keys(x).sort().join() === ['network','releaseId','manifestHash','kind','owner','factory','vault','series','seriesId','queryId',
      'amountRaw','notionalRaw','tokenId','sourceWallet','bodyBoc','bodyHash','valueNano','createdAt','dispatch'].sort().join());
    requireProduct(['buy','fund','withdraw','payout','owed'].includes(String(x.kind)));
    if (x.network !== manifest.network.slice(4) || x.releaseId !== manifest.releaseId || x.manifestHash !== manifest.manifestHash
      || x.factory !== manifest.contracts.OptionFactory?.address || x.vault !== manifest.contracts.OptionVault?.address)
      throw new ProductEvidenceError(409, 'release_mismatch');
    productAddress(x.owner); productAddress(x.factory); productAddress(x.vault); if (x.series !== null) productAddress(x.series);
    const seriesId = productUint(x.seriesId, 64), query = productUint(x.queryId, 64), amount = productUint(x.amountRaw, 120, x.kind !== 'payout');
    productUint(x.valueNano, 120, true); const dispatch = productDispatch(x.dispatch);
    requireProduct(Number.isSafeInteger(x.createdAt) && Number(x.createdAt) > 0);
    // The saved value is a send budget. The original emitted value can include
    // wallet fee deduction; only dispatch.valueNano matches the physical wire.
    requireProduct(BigInt(dispatch.valueNano) <= BigInt(String(x.valueNano)));
    const body = productCell(x.bodyBoc, x.bodyHash), s = body.beginParse(); let target: string;
    if (x.kind === 'buy' || x.kind === 'fund') {
      target = productAddress(x.sourceWallet); requireProduct(x.tokenId === null);
      const notional = x.kind === 'buy' ? productUint(x.notionalRaw, 120, true) : (requireProduct(x.notionalRaw === null), 0n);
      requireProduct(s.loadUint(32) === 0x0f8a7ea5 && s.loadUintBig(64) === query && s.loadCoins() === amount
        && wireAddress(s) === x.vault && wireAddress(s) === x.owner && !s.loadMaybeRef() && s.loadCoins() > 0n);
      const referenced = s.loadBit(), payload = referenced ? s.loadRef() : beginCell().storeSlice(s).endCell(); if (referenced) s.endParse();
      const p = payload.beginParse(); requireProduct(p.loadUint(32) === (x.kind === 'buy' ? 0x4f564259 : 0x4f564644)
        && p.loadUintBig(64) === query && p.loadUintBig(64) === seriesId);
      if (x.kind === 'buy') requireProduct(p.loadCoins() === notional); p.endParse();
    } else {
      requireProduct(x.sourceWallet === null && x.notionalRaw === null);
      if (x.kind === 'owed') {
        target = String(x.vault); requireProduct(x.series === null && seriesId === 0n && x.tokenId === null
          && s.loadUint(32) === 0x434c4d4a && s.loadUintBig(64) === query && s.loadUint(8) === 0 && wireAddress(s) === x.owner);
      } else if (x.kind === 'withdraw') {
        target = String(x.vault); requireProduct(x.tokenId === null && s.loadUint(32) === 0x4f535757
          && s.loadUintBig(64) === query && s.loadUintBig(64) === seriesId && s.loadCoins() === amount);
      } else {
        target = String(x.factory); const token = productUint(x.tokenId, 64), op = s.loadUint(32);
        requireProduct(op === 0x46455843 || op === 0x4f464558);
        if (op === 0x4f464558) s.loadUintBig(64); // Exercise query differs from the saved purchase escrow query.
        requireProduct(s.loadUintBig(64) === seriesId && s.loadUintBig(64) === token);
        requireProduct(op === 0x46455843 ? amount === 0n : s.loadCoins() === amount && amount > 0n);
      }
      s.endParse();
    }
    return { request: structuredClone(x) as CurrentOptionsEvidenceRequest, body, target };
  } catch (error) { if (error instanceof ProductEvidenceError) throw error; throw new ProductEvidenceError(400, 'bad_request'); }
}
export type CurrentOptionsOperationEvidence = ProductPhysicalGraph & { schema: 'tonswap-options-operation-evidence-v1'; releaseId: string;
  manifestHash: string; asOf: { masterchainSeqno: number; unixTime: number; blockRootHash: string };
  request: { kind: CurrentOptionsEvidenceRequest['kind']; owner: string; bodyHash: string } };
export async function readOptionsEvidenceContext(manifest: RuntimeReleaseManifest, source: ChainSource,
  parsed: ReturnType<typeof readOptionsOperationRequest>, signal?: AbortSignal, at?: ChainHead) {
  const unavailable = () => new ProductEvidenceError(503, 'upstream_unavailable');
  signal?.throwIfAborted(); if (`ton:${source.network}` !== manifest.network) throw unavailable();
  const { request } = parsed, head = at ?? await source.head({ signal }); assertFreshHeadTime(head.utime);
  const pins = new Map([[request.factory, manifest.contracts.OptionFactory!.codeHash], [request.vault, manifest.contracts.OptionVault!.codeHash]]);
  for (const [address, hash] of pins) {
    const state = await source.getAccountState(address, { at: head, signal }); if (!state.shardAccountBoc) throw unavailable();
    const active = activeOrderAccount(orderShard(state.shardAccountBoc, address).shard, hash);
    if (address === request.vault) {
      const storage = active.data.beginParse();
      if (storage.loadAddress().toRawString() !== manifest.contracts.Governance?.address) throw unavailable();
      storage.loadBit(); const peers = storage.loadRef().beginParse();
      storage.loadRef(); storage.loadRef(); storage.loadRef(); storage.endParse();
      if (peers.loadAddress().toRawString() !== manifest.contracts.FeeRouter?.address
        || peers.loadAddress().toRawString() !== manifest.contracts.Treasury?.address
        || peers.loadMaybeAddress()?.toRawString() !== request.factory) throw unavailable();
      peers.endParse();
    }
  }
  const factory = await source.runGetMethod(request.factory, 'get_factory', [], { at: head, signal });
  if (!factory || ![0,1].includes(factory.exitCode) || factory.stack.length !== 4) throw unavailable();
  const f = new TupleReader(factory.stack); if (f.readAddress().toRawString() !== manifest.contracts.Governance?.address || ![0n,-1n].includes(f.readBigNumber())) throw unavailable();
  const peers = f.readCell().beginParse(); f.readCell(); if (f.remaining) throw unavailable();
  if (peers.loadAddress().toRawString() !== request.vault || peers.loadMaybeAddress()?.toRawString() !== manifest.contracts.OptionSeriesManager?.address) throw unavailable();
  if (peers.loadRef().hash().toString('hex') !== manifest.templates.ShoutOption || peers.loadRef().hash().toString('hex') !== manifest.templates.OutperformanceOption) throw unavailable(); peers.endParse();
  let child: string | null = null;
  if (request.kind !== 'owed') {
    const series = await source.runGetMethod(request.factory, 'series_info', [{ type:'int', value: BigInt(request.seriesId) }], { at: head, signal });
    if (!series || ![0,1].includes(series.exitCode) || series.stack.length !== 1 || series.stack[0].type !== 'cell') throw unavailable();
    const terms = series.stack[0].cell.beginParse().loadRef().beginParse(); terms.loadAddress();
    child = terms.loadAddress().toRawString(); const kind = terms.loadUint(16); terms.loadUint(32); terms.loadCoins(); terms.loadUint(32); terms.loadUint(32); terms.loadCoins(); terms.loadRef(); terms.endParse();
    if (![1,2].includes(kind) || request.series !== null && request.series !== child) throw new ProductEvidenceError(400, 'bad_request');
    pins.set(child, kind === 1 ? manifest.templates.ShoutOption : manifest.templates.OutperformanceOption);
  }
  const token = manifest.tokens.find(t => t.symbol === 'T3'); if (!token || token.root !== manifest.contracts.T3Hub?.address) throw unavailable();
  const walletReader = createJettonWalletReader({ source, tokens: [{ master: token.root, masterCodeHash: token.masterCodeHash, walletCodeHash: token.walletCodeHash }] });
  const ownerWallet = await walletReader.identity(token.root, request.owner, { at: head, signal });
  const vaultWallet = await walletReader.identity(token.root, request.vault, { at: head, signal });
  if (request.sourceWallet !== null && request.sourceWallet !== ownerWallet.wallet) throw new ProductEvidenceError(400, 'bad_request');
  return { head, pins, ownerWallet, vaultWallet, completeAccounts: [request.factory, request.vault, ...(child ? [child] : []), ownerWallet.wallet, vaultWallet.wallet] };
}
export async function collectOptionsOperationEvidence(manifest: RuntimeReleaseManifest, source: ChainSource, store: PhysicalEvidenceStore,
  parsed: ReturnType<typeof readOptionsOperationRequest>, signal?: AbortSignal): Promise<CurrentOptionsOperationEvidence> {
  const { request } = parsed, { head, pins, completeAccounts } = await readOptionsEvidenceContext(manifest, source, parsed, signal);
  // Wallet execution and any subsequent failure are physical facts even when
  // their latest account is frozen. Client decoders enforce each wallet ABI.
  const graph = await collectProductPhysicalGraph(source, store, head, { owner: request.owner, target: parsed.target,
    body: parsed.body, dispatch: request.dispatch, pins, completeAccounts }, signal);
  assertFreshHeadTime(head.utime); signal?.throwIfAborted();
  return boundProductResponse<CurrentOptionsOperationEvidence>({ schema:'tonswap-options-operation-evidence-v1', releaseId:manifest.releaseId, manifestHash:manifest.manifestHash,
    asOf:{masterchainSeqno:head.seqno,unixTime:head.utime,blockRootHash:head.rootHashHex}, request:{kind:request.kind,owner:request.owner,bodyHash:request.bodyHash}, ...graph }, request.factory);
}

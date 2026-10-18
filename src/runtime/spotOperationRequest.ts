import { Address, Cell, beginCell, type Slice } from '@ton/core';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import { parseOrderTerms, type OrderTerms } from '../orders/state';

type RequestIdentity = { network: string; releaseId: string; manifestHash: string; owner: string; pool: string };
export type CurrentDirectSpotRequest = RequestIdentity & {
  kind: 'direct'; payRoot: string; receiveRoot: string; sourceWallet: string;
  valueNano: string; bodyBoc: string; bodyHash: string;
};
export type CurrentOrderCreateSpotRequest = RequestIdentity & {
  kind: 'order-create'; factory: string; order: string; nonce: string;
  inputRoot: string; termsBoc: string; termsHash: string;
};
export type SpotOrderFunding = { sourceWallet: string; valueNano: string; bodyBoc: string; bodyHash: string; lt: string; hash: string };
export type CurrentOrderSettlementSpotRequest = Omit<CurrentOrderCreateSpotRequest, 'kind'> & {
  kind: 'order-settlement'; funding: SpotOrderFunding | null;
};
export type CurrentSpotRequest = CurrentDirectSpotRequest | CurrentOrderCreateSpotRequest | CurrentOrderSettlementSpotRequest;
type Market = RuntimeReleaseManifest['spotMarkets'][number];
type Token = RuntimeReleaseManifest['tokens'][number];
export type ParsedDirectSpotOperationRequest = {
  request: CurrentDirectSpotRequest; body: Cell; payload: Cell; market: Market;
  payToken: Token; receiveToken: Token; queryId: string; amountRaw: string; minimumRaw: string; deadline: number;
};
export type ParsedOrderCreateSpotOperationRequest = {
  request: CurrentOrderCreateSpotRequest; terms: OrderTerms; termsCell: Cell; market: Market; inputToken: Token;
};
export type ParsedOrderSettlementSpotOperationRequest = Omit<ParsedOrderCreateSpotOperationRequest, 'request'> & {
  request: CurrentOrderSettlementSpotRequest; fundingBody: Cell | null;
};
export type ParsedSpotOperationRequest = ParsedDirectSpotOperationRequest | ParsedOrderCreateSpotOperationRequest | ParsedOrderSettlementSpotOperationRequest;

export class SpotEvidenceError extends Error {
  constructor(readonly status: 400 | 409 | 503, readonly code: 'bad_request' | 'release_mismatch' | 'upstream_unavailable') {
    super(status === 400 ? 'The Spot operation request is invalid.' : status === 409
      ? 'The Spot operation belongs to another release.' : 'Current Spot evidence is unavailable.');
  }
}
function requireRequest(ok: unknown): asserts ok {
  if (!ok) throw new SpotEvidenceError(400, 'bad_request');
}
function address(value: unknown): string {
  requireRequest(typeof value === 'string' && /^0:[0-9a-f]{64}$/.test(value));
  requireRequest(Address.parseRaw(value).toRawString() === value);
  return value;
}
function wireAddress(slice: Slice): string {
  // addr_std, no anycast, workchain zero. Do not normalize another wire form.
  requireRequest(slice.preloadUint(11) === 0b10000000000);
  return slice.loadAddress().toRawString();
}
function uint(value: unknown, bits: number, positive = false): bigint {
  requireRequest(typeof value === 'string' && /^(0|[1-9][0-9]{0,36})$/.test(value));
  const n = BigInt(value);
  requireRequest(n < 1n << BigInt(bits) && (!positive || n > 0n));
  return n;
}
function originalCell(boc: unknown, hash: unknown): Cell {
  requireRequest(typeof boc === 'string' && boc.length > 0 && boc.length <= 128 * 1024
    && typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash));
  const bytes = Buffer.from(boc, 'base64');
  requireRequest(bytes.toString('base64') === boc);
  const roots = Cell.fromBoc(bytes);
  requireRequest(roots.length === 1 && !roots[0].isExotic);
  const cell = roots[0];
  // These bounded linear request graphs have one canonical cell ordering.
  // Permit both standard index/CRC options, but no extra bytes or unused cells.
  requireRequest([false, true].some(idx => [false, true].some(crc32 => cell.toBoc({ idx, crc32 }).equals(bytes))));
  requireRequest(cell.hash().toString('hex') === hash);
  return cell;
}

/** Validate the user's exact current wire intent. Current code, canonical wallet,
 * child derivation and physical transaction proof remain the collector's work. */
export function readSpotOperationRequest(value: unknown, manifest: RuntimeReleaseManifest): ParsedSpotOperationRequest {
  try {
    requireRequest(value && typeof value === 'object' && !Array.isArray(value));
    const x = value as Record<string, unknown>;
    requireRequest(x.kind === 'direct' || x.kind === 'order-create' || x.kind === 'order-settlement');
    const common = ['kind', 'network', 'releaseId', 'manifestHash', 'owner', 'pool'];
    const fields = x.kind === 'direct'
      ? ['payRoot', 'receiveRoot', 'sourceWallet', 'valueNano', 'bodyBoc', 'bodyHash']
      : ['factory', 'order', 'nonce', 'inputRoot', 'termsBoc', 'termsHash', ...(x.kind === 'order-settlement' ? ['funding'] : [])];
    requireRequest(Object.keys(x).sort().join() === [...common, ...fields].sort().join());
    if (x.network !== manifest.network.slice(4) || x.releaseId !== manifest.releaseId || x.manifestHash !== manifest.manifestHash)
      throw new SpotEvidenceError(409, 'release_mismatch');
    const owner = address(x.owner), pool = address(x.pool);
    const market = manifest.spotMarkets.find(item => item.pool === pool);
    requireRequest(market);
    const t3 = manifest.tokens.find(token => token.symbol === 'T3');
    const paired = manifest.tokens.find(token => token.symbol === market.symbol);
    requireRequest(t3 && paired && t3.root === manifest.contracts.T3Hub?.address && t3.root !== paired.root);

    if (x.kind === 'direct') {
      const payRoot = address(x.payRoot), receiveRoot = address(x.receiveRoot);
      address(x.sourceWallet); uint(x.valueNano, 120, true);
      requireRequest((payRoot === t3.root && receiveRoot === paired.root) || (payRoot === paired.root && receiveRoot === t3.root));
      const payToken = payRoot === t3.root ? t3 : paired, receiveToken = receiveRoot === t3.root ? t3 : paired;
      const body = originalCell(x.bodyBoc, x.bodyHash), transfer = body.beginParse();
      requireRequest(transfer.loadUint(32) === 0x0f8a7ea5);
      const queryId = transfer.loadUintBig(64), amount = transfer.loadCoins();
      requireRequest(amount > 0n && wireAddress(transfer) === pool && wireAddress(transfer) === owner && !transfer.loadMaybeRef());
      requireRequest(transfer.loadCoins() > 0n);
      const referenced = transfer.loadBit();
      const payload = referenced ? transfer.loadRef() : beginCell().storeSlice(transfer).endCell();
      if (referenced) transfer.endParse();
      requireRequest(!payload.isExotic && payload.refs.length === 0);
      const swap = payload.beginParse();
      requireRequest(swap.loadUint(32) === 0x53575033);
      const minimum = swap.loadCoins(), deadline = swap.loadUint(32);
      requireRequest(minimum > 0n && deadline > 0 && wireAddress(swap) === owner && wireAddress(swap) === owner
        && !swap.loadBit() && swap.loadCoins() === 0n && swap.loadCoins() === 0n && !swap.loadMaybeRef());
      swap.endParse();
      return { request: structuredClone(x) as CurrentDirectSpotRequest, body, payload, market, payToken, receiveToken,
        queryId: queryId.toString(), amountRaw: amount.toString(), minimumRaw: minimum.toString(), deadline };
    }

    address(x.factory); address(x.order); uint(x.nonce, 64);
    if (x.factory !== manifest.contracts.SpotOrderFactory?.address) throw new SpotEvidenceError(409, 'release_mismatch');
    const inputRoot = address(x.inputRoot);
    requireRequest(inputRoot === t3.root || inputRoot === paired.root);
    const inputToken = inputRoot === t3.root ? t3 : paired;
    const termsCell = originalCell(x.termsBoc, x.termsHash), terms = parseOrderTerms(termsCell);
    requireRequest(terms.pool.toRawString() === pool && terms.inputMaster.toRawString() === inputRoot
      && terms.recipient.toRawString() === owner && terms.sellIndex === (inputRoot === t3.root ? 0 : 1));
    if (x.kind === 'order-settlement') {
      let fundingBody: Cell | null = null;
      if (x.funding !== null) {
        requireRequest(x.funding && typeof x.funding === 'object' && !Array.isArray(x.funding));
        const f = x.funding as Record<string, unknown>;
        requireRequest(Object.keys(f).sort().join() === ['sourceWallet', 'valueNano', 'bodyBoc', 'bodyHash', 'lt', 'hash'].sort().join());
        address(f.sourceWallet); uint(f.valueNano, 120, true); uint(f.lt, 64, true);
        requireRequest(typeof f.hash === 'string' && /^[0-9a-f]{64}$/.test(f.hash));
        fundingBody = originalCell(f.bodyBoc, f.bodyHash); const b = fundingBody.beginParse();
        requireRequest(b.loadUint(32) === 0x0f8a7ea5); b.loadUintBig(64);
        requireRequest(b.loadCoins() === terms.amountIn && wireAddress(b) === x.order && wireAddress(b) === owner
          && !b.loadMaybeRef() && b.loadCoins() === 0n);
        if (b.loadBit()) { const payload = b.loadRef(); requireRequest(!payload.isExotic && payload.bits.length === 0 && payload.refs.length === 0); }
        b.endParse();
      }
      return { request: structuredClone(x) as CurrentOrderSettlementSpotRequest, fundingBody, terms, termsCell, market, inputToken };
    }
    return { request: structuredClone(x) as CurrentOrderCreateSpotRequest, terms, termsCell, market, inputToken };
  } catch (error) {
    if (error instanceof SpotEvidenceError) throw error;
    throw new SpotEvidenceError(400, 'bad_request');
  }
}

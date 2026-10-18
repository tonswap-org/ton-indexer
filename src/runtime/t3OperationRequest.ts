import { Address, Cell, beginCell } from '@ton/core';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';

type RequestIdentity = { network: string; releaseId: string; manifestHash: string; owner: string; hub: string; queryId: string;
  amountRaw: string; recipient: string; minimumRaw: string; bodyBoc: string; bodyHash: string };
export type CurrentT3Request = RequestIdentity & (
  { kind: 'mint'; collateralRoot: string; input: 0 | 1 | 2; sourceWallet: string; valueNano: string; submittedAt: number }
  | { kind: 'redeem'; wallet: string; single: boolean; outputToken: 0 | 1 | 2; createdAt: number });
export class T3EvidenceError extends Error {
  constructor(readonly status: 400 | 409 | 503, readonly code: 'bad_request' | 'release_mismatch' | 'upstream_unavailable') {
    super(status === 400 ? 'The T3 operation request is invalid.' : status === 409 ? 'The T3 operation belongs to another release.' : 'Current T3 evidence is unavailable.');
  }
}
const requireRequest = (ok: unknown) => { if (!ok) throw new T3EvidenceError(400, 'bad_request'); };
function address(value: unknown): string {
  requireRequest(typeof value === 'string'); const parsed = Address.parse(value as string);
  requireRequest(parsed.workChain === 0 && parsed.toRawString() === value); return value as string;
}
function uint(value: unknown, bits: number, positive = false) {
  requireRequest(typeof value === 'string' && /^(0|[1-9][0-9]{0,35})$/.test(value));
  const parsed = BigInt(value as string); requireRequest(parsed < 1n << BigInt(bits) && (!positive || parsed > 0n)); return parsed;
}
export function readT3OperationRequest(value: unknown, manifest: RuntimeReleaseManifest): { request: CurrentT3Request; body: Cell; intent: Cell } {
  try {
    requireRequest(value && typeof value === 'object' && !Array.isArray(value));
    const x = value as Record<string, unknown>, common = ['network', 'releaseId', 'manifestHash', 'owner', 'hub', 'queryId', 'amountRaw', 'recipient', 'minimumRaw', 'bodyBoc', 'bodyHash', 'kind'];
    requireRequest(x.kind === 'mint' || x.kind === 'redeem');
    const fields = x.kind === 'mint' ? ['collateralRoot', 'input', 'sourceWallet', 'valueNano', 'submittedAt'] : ['wallet', 'single', 'outputToken', 'createdAt'];
    requireRequest(Object.keys(x).sort().join() === [...common, ...fields].sort().join());
    if (x.network !== manifest.network.slice(4) || x.releaseId !== manifest.releaseId || x.manifestHash !== manifest.manifestHash || x.hub !== manifest.contracts.T3Hub?.address)
      throw new T3EvidenceError(409, 'release_mismatch');
    address(x.owner); address(x.recipient); address(x.hub);
    const query = uint(x.queryId, 64), amount = uint(x.amountRaw, 120, true), minimum = uint(x.minimumRaw, 120);
    requireRequest(typeof x.bodyBoc === 'string' && x.bodyBoc.length > 0 && x.bodyBoc.length <= 128 * 1024 && typeof x.bodyHash === 'string' && /^[0-9a-f]{64}$/.test(x.bodyHash));
    const bytes = Buffer.from(x.bodyBoc as string, 'base64'); requireRequest(bytes.toString('base64') === x.bodyBoc);
    const roots = Cell.fromBoc(bytes); requireRequest(roots.length === 1 && !roots[0].isExotic);
    const body = roots[0]; requireRequest(body.hash().toString('hex') === x.bodyHash);
    const s = body.beginParse(), op = s.loadUint(32); requireRequest(s.loadUintBig(64) === query && s.loadCoins() === amount);
    let intent: Cell;
    if (x.kind === 'mint') {
      requireRequest(op === 0x0f8a7ea5 && s.loadAddress().toRawString() === x.hub && s.loadMaybeAddress()?.toRawString() === x.owner && !s.loadMaybeRef());
      s.loadCoins(); const ref = s.loadBit(); intent = ref ? s.loadRef() : beginCell().storeSlice(s).endCell(); if (ref) s.endParse();
      address(x.sourceWallet); address(x.collateralRoot); uint(x.valueNano, 120, true);
      requireRequest([0, 1, 2].includes(x.input as number) && manifest.tokens.find(t => t.symbol === ['USDT', 'USDC', 'KUSD'][x.input as number])?.root === x.collateralRoot);
    } else {
      requireRequest(op === 0x595f07bc && s.loadAddress().toRawString() === x.owner); const custom = s.loadMaybeRef(); s.endParse(); requireRequest(custom); intent = custom!;
      address(x.wallet); requireRequest(typeof x.single === 'boolean' && [0, 1, 2].includes(x.outputToken as number));
    }
    requireRequest(!intent.isExotic && intent.refs.length === 0); const terms = intent.beginParse();
    requireRequest(terms.loadUint(32) === (x.kind === 'mint' ? 0x54334d4e : 0x54335244));
    if (x.kind === 'redeem') {
      requireRequest(terms.loadBit() === x.single && terms.loadUint(2) === x.outputToken && !terms.loadBit());
      requireRequest(x.single || (x.outputToken === 0 && minimum === 0n));
    }
    requireRequest(terms.loadCoins() === minimum && terms.loadAddress().toRawString() === x.recipient); terms.endParse();
    const time = x.kind === 'mint' ? x.submittedAt : x.createdAt;
    requireRequest(Number.isSafeInteger(time) && (time as number) >= 0);
    return { request: structuredClone(x) as CurrentT3Request, body, intent };
  } catch (error) { if (error instanceof T3EvidenceError) throw error; throw new T3EvidenceError(400, 'bad_request'); }
}

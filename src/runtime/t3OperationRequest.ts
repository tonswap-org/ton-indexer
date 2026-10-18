import { Address, Cell, beginCell } from '@ton/core';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';

type RequestIdentity = { network: string; releaseId: string; manifestHash: string; owner: string; hub: string; queryId: string;
  amountRaw: string; recipient: string; minimumRaw: string; bodyBoc: string; bodyHash: string };
type Dispatch = { lt:string; hash:string };
export type T3PairDeposit = { dispatch:Dispatch|null; queryId: string; amountRaw: string; bodyBoc: string; bodyHash: string; collateralRoot: string; input: 0 | 1; sourceWallet: string; valueNano: string };
type Deposit = { collateralRoot: string; input: 0 | 1 | 2; sourceWallet: string; valueNano: string; submittedAt: number };
export type CurrentT3Request = RequestIdentity & (
  Deposit & ({ kind: 'mint' } | { kind: 'swap'; outputToken: 0 | 1 | 2; dispatch:Dispatch|null } | { kind: 'pair'; counterpart: T3PairDeposit; dispatch:Dispatch|null })
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
  requireRequest(typeof value === 'string' && /^(0|[1-9][0-9]{0,36})$/.test(value));
  const parsed = BigInt(value as string); requireRequest(parsed < 1n << BigInt(bits) && (!positive || parsed > 0n)); return parsed;
}
export function readT3OperationRequest(value: unknown, manifest: RuntimeReleaseManifest): { request: CurrentT3Request; body: Cell; intent: Cell } {
  try {
    requireRequest(value && typeof value === 'object' && !Array.isArray(value));
    const x = value as Record<string, unknown>, common = ['network', 'releaseId', 'manifestHash', 'owner', 'hub', 'queryId', 'amountRaw', 'recipient', 'minimumRaw', 'bodyBoc', 'bodyHash', 'kind'];
    requireRequest(['mint', 'pair', 'swap', 'redeem'].includes(x.kind as string));
    const fields = x.kind !== 'redeem' ? ['collateralRoot', 'input', 'sourceWallet', 'valueNano', 'submittedAt', ...(x.kind === 'pair' ? ['counterpart','dispatch'] : x.kind === 'swap' ? ['outputToken','dispatch'] : [])] : ['wallet', 'single', 'outputToken', 'createdAt'];
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
    if (x.kind !== 'redeem') {
      requireRequest(op === 0x0f8a7ea5 && s.loadAddress().toRawString() === x.hub && s.loadMaybeAddress()?.toRawString() === x.owner && !s.loadMaybeRef());
      s.loadCoins(); const ref = s.loadBit(); intent = ref ? s.loadRef() : beginCell().storeSlice(s).endCell(); if (ref) s.endParse();
      address(x.sourceWallet); address(x.collateralRoot); uint(x.valueNano, 120, true);
      requireRequest([0, 1, 2].includes(x.input as number) && manifest.tokens.find(t => t.symbol === ['USDT', 'USDC', 'KUSD'][x.input as number])?.root === x.collateralRoot);
    } else {
      requireRequest(op === 0x595f07bc && s.loadAddress().toRawString() === x.owner); const custom = s.loadMaybeRef(); s.endParse(); requireRequest(custom); intent = custom!;
      address(x.wallet); requireRequest(typeof x.single === 'boolean' && [0, 1, 2].includes(x.outputToken as number));
    }
    requireRequest(!intent.isExotic && intent.refs.length === 0); const terms = intent.beginParse();
    requireRequest(terms.loadUint(32) === ({ mint: 0x54334d4e, pair: 0x5433504d, swap: 0x54335357, redeem: 0x54335244 } as const)[x.kind as CurrentT3Request['kind']]);
    if (x.kind === 'swap') requireRequest([0, 1, 2].includes(x.outputToken as number) && x.input !== x.outputToken && terms.loadUint(2) === x.outputToken && !terms.loadBit());
    if (x.kind === 'redeem') {
      requireRequest(terms.loadBit() === x.single && terms.loadUint(2) === x.outputToken && !terms.loadBit());
      requireRequest(x.single || (x.outputToken === 0 && minimum === 0n));
    }
    requireRequest(terms.loadCoins() === minimum && terms.loadAddress().toRawString() === x.recipient); terms.endParse();
    if(x.kind==='pair'||x.kind==='swap'){requireRequest(minimum>0n);readDispatch(x.dispatch);}
    const time = x.kind !== 'redeem' ? x.submittedAt : x.createdAt;
    if (x.kind === 'pair') {
      const c = x.counterpart as Record<string, unknown>;
      requireRequest(c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).sort().join() === ['queryId','amountRaw','bodyBoc','bodyHash','collateralRoot','input','sourceWallet','valueNano','dispatch'].sort().join());
      requireRequest([0, 1].includes(x.input as number) && c.input === 1 - (x.input as number) && x.owner === x.recipient);
      const counterpart = readPairDeposit(c, x, manifest);
      requireRequest(counterpart.intent.equals(intent) && c.bodyHash !== x.bodyHash);
    }
    requireRequest(Number.isSafeInteger(time) && (time as number) >= 0);
    return { request: structuredClone(x) as CurrentT3Request, body, intent };
  } catch (error) { if (error instanceof T3EvidenceError) throw error; throw new T3EvidenceError(400, 'bad_request'); }
}

/** A paired request retains both exact original transfers. The common minimum
 * and recipient are encoded in each original intent; no body is rewritten. */
function readPairDeposit(c: Record<string, unknown>, x: Record<string, unknown>, manifest: RuntimeReleaseManifest) {
  readDispatch(c.dispatch); address(c.sourceWallet); address(c.collateralRoot); uint(c.valueNano, 120, true);
  const query = uint(c.queryId, 64), amount = uint(c.amountRaw, 120, true);
  requireRequest(manifest.tokens.find(t => t.symbol === ['USDT', 'USDC'][c.input as number])?.root === c.collateralRoot);
  requireRequest(typeof c.bodyBoc === 'string' && c.bodyBoc.length > 0 && c.bodyBoc.length <= 128 * 1024);
  const bytes = Buffer.from(c.bodyBoc as string, 'base64'); requireRequest(bytes.toString('base64') === c.bodyBoc);
  const roots = Cell.fromBoc(bytes); requireRequest(roots.length === 1 && !roots[0].isExotic);
  const body = roots[0]; requireRequest(body.hash().toString('hex') === c.bodyHash);
  const s = body.beginParse(); requireRequest(s.loadUint(32) === 0x0f8a7ea5 && s.loadUintBig(64) === query && s.loadCoins() === amount && s.loadAddress().toRawString() === x.hub && s.loadMaybeAddress()?.toRawString() === x.owner && !s.loadMaybeRef());
  s.loadCoins(); const ref = s.loadBit(), intent = ref ? s.loadRef() : beginCell().storeSlice(s).endCell(); if (ref) s.endParse();
  return { body, intent };
}
export function t3DepositRequests(parsed: ReturnType<typeof readT3OperationRequest>) {
  const p = parsed.request;
  if (p.kind !== 'pair') return [parsed];
  const request = { ...p, ...p.counterpart } as CurrentT3Request;
  const body = Cell.fromBase64(request.bodyBoc);
  return [{ request, body, intent: parsed.intent }, parsed];
}

function readDispatch(value:unknown) { if(value===null)return; const d=value as Dispatch;requireRequest(d&&typeof d==='object'&&!Array.isArray(d)&&Object.keys(d).sort().join()==='hash,lt'&&typeof d.hash==='string'&&/^[0-9a-f]{64}$/.test(d.hash)&&!/^0+$/.test(d.hash));uint(d.lt,64,true); }

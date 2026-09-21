import { Address, Cell, TupleItem, parseTuple, serializeTuple } from '@ton/core';
import { createHash } from 'node:crypto';

export const ADMISSION_GAS_MAX = 1_000_000;
export const ADMISSION_TIMEOUT_MS = 5_000;
export const ADMISSION_STARTUP_MS = 610_000;
export const ADMISSION_INPUT_BYTES = 256 * 1024;
export const ADMISSION_OUTPUT_BYTES = 8 * 1024 * 1024;
export type AdmissionErrorCode = 'admission_unavailable' | 'admission_busy' | 'admission_timeout' |
  'admission_invalid_request' | 'admission_invalid_proof' | 'admission_invalid_context' | 'admission_worker_failure';
export class AdmissionError extends Error {
  constructor(readonly code: AdmissionErrorCode) { super(code); this.name = 'AdmissionError'; }
}
export interface AdmissionIdentity { engine: string; codeHash: string; configSha256: string }
export interface AdmissionExecution {
  method: 'open_order_preflight' | 'close_order_preflight';
  block: { workchain: number; shard: string; seqno: number; rootHash: string; fileHash: string };
  shardBlock: { workchain: number; shard: string; seqno: number; rootHash: string; fileHash: string };
  masterTime: number; shardTime: number; shardLt: string; globalVersion: number;
  codeHash: string; dataHash: string; configHash: string; contextHash: string; proofDigest: string;
  trustedConfigSha256: string; gasLimit: number; outcome: 'accepted' | 'denied' | 'gas_exhausted' | 'vm_error';
}
export interface AdmissionResult { exitCode: number; gasUsed: number; stack: TupleItem[]; execution: AdmissionExecution }
export interface AdmissionRequest { wire: string; method: AdmissionExecution['method']; argumentsHash: string; payloadHash: bigint; evaluatedAt: number }
const fail = (code: AdmissionErrorCode): never => { throw new AdmissionError(code); };
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const bytes = (value: unknown, maximum: number, exact?: number): Buffer => {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return fail('admission_invalid_context');
  const buffer = Buffer.from(value, 'base64');
  if (buffer.length > maximum || (exact !== undefined && buffer.length !== exact)) return fail('admission_invalid_context');
  return buffer;
};
const integer = (value: unknown, minimum: number, maximum: number): number => {
  const parsed = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return fail('admission_invalid_context');
  return parsed;
};
const record = (v: unknown): Record<string, any> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return fail('admission_invalid_context');
  return v as Record<string, any>;
};
export const isAdmissionMethod = (method: string): method is AdmissionExecution['method'] => method === 'open_order_preflight' || method === 'close_order_preflight';
export function makeAdmissionRequest(identity: AdmissionIdentity, method: string, args: TupleItem[], now = Date.now()): AdmissionRequest {
  if (!isAdmissionMethod(method) || !/^[a-f0-9]{64}$/.test(identity.codeHash)) return fail('admission_invalid_request');
  const open = method === 'open_order_preflight', payloadIndex = open ? 2 : 1;
  if (args.length !== (open ? 6 : 5) || args[0].type !== 'slice' || args[payloadIndex].type !== 'cell' ||
      args[payloadIndex + 1].type !== 'int' || args[payloadIndex + 2].type !== 'cell' || args[payloadIndex + 3].type !== 'int' ||
      (open && args[1].type !== 'int')) return fail('admission_invalid_request');
  const evaluated = (args[payloadIndex + 3] as { type: 'int'; value: bigint }).value;
  if (evaluated <= 0n || evaluated > 0xffffffffn || Number(evaluated) > now / 1000 + 3 || now / 1000 - Number(evaluated) > 30) return fail('admission_invalid_request');
  const stack = args.map(item => item.type === 'int' ? { '@type': 'tvm.stackEntryNumber', number: { '@type': 'tvm.numberDecimal', number: String(item.value) } } :
    item.type === 'cell' ? { '@type': 'tvm.stackEntryCell', cell: { '@type': 'tvm.cell', bytes: item.cell.toBoc().toString('base64') } } :
    item.type === 'slice' ? { '@type': 'tvm.stackEntrySlice', slice: { '@type': 'tvm.slice', bytes: item.cell.toBoc().toString('base64') } } : fail('admission_invalid_request'));
  const wire = JSON.stringify({ '@type': 'smc.runGetMethodVerified', account_address: { '@type': 'accountAddress', account_address: Address.parse(identity.engine).toRawString() },
    expected_code_hash: Buffer.from(identity.codeHash, 'hex').toString('base64'), method, stack });
  if (Buffer.byteLength(wire) > ADMISSION_INPUT_BYTES) return fail('admission_invalid_request');
  return { wire, method, argumentsHash: serializeTuple(args).hash().toString('hex'), payloadHash: BigInt('0x' + (args[payloadIndex] as { type: 'cell'; cell: Cell }).cell.hash().toString('hex')), evaluatedAt: Number(evaluated) };
}
export function decodeNativeBlock(value: unknown, master: boolean): AdmissionExecution['block'] {
  const b = record(value);
  if (b['@type'] !== 'ton.blockIdExt' || b.workchain !== (master ? -1 : 0) || typeof b.shard !== 'string' || !/^-?\d+$/.test(b.shard) ||
      (master && b.shard !== '-9223372036854775808')) return fail('admission_invalid_context');
  const rootHash = bytes(b.root_hash, 32, 32).toString('hex'), fileHash = bytes(b.file_hash, 32, 32).toString('hex');
  if (/^0+$/.test(rootHash) || /^0+$/.test(fileHash)) return fail('admission_invalid_context');
  return { workchain: b.workchain, shard: b.shard, seqno: integer(b.seqno, 1, 0x7fffffff), rootHash, fileHash };
}
export function decodeAdmissionReadiness(identity: AdmissionIdentity, value: unknown, now = Date.now()): void {
  const r = record(value);
  if (r['@type'] !== 'smc.verifiedAdmissionReady') return fail('admission_unavailable');
  decodeNativeBlock(r.block_id, true);
  const master = integer(r.master_utime, 1, 0xffffffff), shard = integer(r.shard_utime, 1, 0xffffffff);
  if (shard > master || [master, shard].some(t => t > now / 1000 + 3 || now / 1000 - t > 30) ||
      bytes(r.code_hash,32,32).toString('hex') !== identity.codeHash) return fail('admission_invalid_context');
}
export function decodeAdmissionResult(identity: AdmissionIdentity, request: AdmissionRequest, value: unknown, now = Date.now()): AdmissionResult {
  const r = record(value);
  if (r['@type'] === 'error') {
    const message = typeof r.message === 'string' ? r.message : '';
    if (message.startsWith('LITE_SERVER_NETWORK')) return fail('admission_unavailable');
    if (message.startsWith('ADMISSION_INPUT:')) return fail('admission_invalid_request');
    if (message.startsWith('ADMISSION_CONTEXT:') || message.startsWith('ADMISSION_RESULT:') || message.startsWith('ADMISSION_EFFECT:')) return fail('admission_invalid_context');
    return fail('admission_invalid_proof');
  }
  if (r['@type'] !== 'smc.verifiedRunResult') return fail('admission_worker_failure');
  const block = decodeNativeBlock(r.block_id, true), shardBlock = decodeNativeBlock(r.shard_block_id, false);
  const masterTime = integer(r.master_utime, 1, 0xffffffff), shardTime = integer(r.shard_utime, 1, 0xffffffff);
  if ([masterTime, shardTime, request.evaluatedAt].some(t => t > now / 1000 + 3 || now / 1000 - t > 30) ||
      shardTime > masterTime || shardTime < request.evaluatedAt || shardTime - request.evaluatedAt > 30) return fail('admission_invalid_context');
  const codeHash = bytes(r.code_hash, 32, 32).toString('hex'), dataHash = bytes(r.data_hash, 32, 32).toString('hex'), configHash = bytes(r.config_hash, 32, 32).toString('hex');
  if (codeHash !== identity.codeHash || integer(r.gas_limit, 1, ADMISSION_GAS_MAX) !== ADMISSION_GAS_MAX) return fail('admission_invalid_context');
  const context = bytes(r.context, 4 * 1024 * 1024), argumentsBytes = bytes(r.arguments, ADMISSION_INPUT_BYTES);
  const argumentCells = Cell.fromBoc(argumentsBytes);
  if (argumentCells.length !== 1 || argumentCells[0].hash().toString('hex') !== request.argumentsHash) return fail('admission_invalid_context');
  const proof = ['account_state','account_proof','shard_proof','config_state_proof','config_proof'].map(key => bytes(r[key], 4 * 1024 * 1024));
  if (proof.some(p => !p.length) || proof.reduce((n, b) => n + b.length, 0) > 4 * 1024 * 1024) return fail('admission_invalid_proof');
  // A TVM out-of-gas result can include the cost of the instruction that crossed
  // its hard limit. Preserve the measured counter; successful runs stay <=1M.
  const gasUsed = integer(r.gas_used, 0, Number.MAX_SAFE_INTEGER), exitCode = integer(r.exit_code, -0x80000000, 0x7fffffff);
  if (!Array.isArray(r.stack) || r.stack.length > 16) return fail('admission_invalid_context');
  const stack: TupleItem[] = r.stack.map((entry: unknown) => {
    const e = record(entry), n = record(e.number);
    if (e['@type'] !== 'tvm.stackEntryNumber' || n['@type'] !== 'tvm.numberDecimal' || typeof n.number !== 'string' || !/^-?\d{1,78}$/.test(n.number)) return fail('admission_invalid_context');
    const value = BigInt(n.number); if (value < -(1n << 256n) || value >= 1n << 256n) return fail('admission_invalid_context');
    return { type: 'int', value };
  });
  if (exitCode === 0) {
    const numbers = stack.map(s => (s as { type: 'int'; value: bigint }).value);
    if (r.data_unchanged !== true || r.actions_empty !== true || numbers.length !== 5 || ![-1n,0n].includes(numbers[0]) || numbers[1] !== BigInt(shardTime) || numbers[2] !== request.payloadHash || gasUsed > ADMISSION_GAS_MAX) return fail('admission_invalid_context');
  }
  const shardLt = String(r.shard_lt); if (!/^\d{1,20}$/.test(shardLt) || BigInt(shardLt) >= 1n << 64n) return fail('admission_invalid_context');
  const outcome = exitCode === -14 ? 'gas_exhausted' : exitCode !== 0 ? 'vm_error' : (stack[0] as { type: 'int'; value: bigint }).value === -1n ? 'accepted' : 'denied';
  return { exitCode, gasUsed, stack, execution: { method: request.method, block, shardBlock, masterTime, shardTime, shardLt,
    globalVersion: integer(r.global_version, 4, 16), codeHash, dataHash, configHash, contextHash: digest(context),
    proofDigest: digest(JSON.stringify([block, shardBlock, ...proof.map(digest)])), trustedConfigSha256: identity.configSha256,
    gasLimit: ADMISSION_GAS_MAX, outcome } };
}

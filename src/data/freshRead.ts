import { Address, Cell, type TupleItem } from '@ton/core';
import { matchesPublicRpcNetwork } from '../api/rpcNetwork';
import type { Network } from '../models';
import type { AccountStateResponse, TonBlockIdExt } from './dataSource';
import { assertAccountTransactionPointer } from './accountState';

export type FreshReadCall =
  | { kind: 'account'; address: string }
  | { kind: 'getter'; address: string; method: string; args: TupleItem[] };
export type FreshReadResult =
  | { kind: 'account'; address: string; state: AccountStateResponse }
  | { kind: 'getter'; address: string; exitCode: number; stack: TupleItem[] };
export type FreshReadBatch = {
  network: Network;
  readContext: { source: 'lite' | 'http4'; head: TonBlockIdExt & { utime?: number }; queriedAt: number };
  results: FreshReadResult[];
};

export class FreshReadUnavailableError extends Error {
  constructor() { super('Fresh chain read unavailable.'); this.name = 'FreshReadUnavailableError'; }
}

type SourceBlock = { workchain: number; shard: string; seqno: number; rootHash: Buffer | string; fileHash: Buffer | string };

function hashBytes(value: Buffer | string): Buffer {
  if (Buffer.isBuffer(value) && value.length === 32) return value;
  if (typeof value === 'string') {
    if (/^[a-fA-F0-9]{64}$/.test(value)) return Buffer.from(value, 'hex');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length === 32 && bytes.toString('base64') === value) return bytes;
  }
  throw new FreshReadUnavailableError();
}

export function freshMasterchainBlock(block: SourceBlock): TonBlockIdExt {
  if (!block || block.workchain !== -1 || block.shard !== '-9223372036854775808'
    || !Number.isSafeInteger(block.seqno) || block.seqno < 0) throw new FreshReadUnavailableError();
  return { workchain: block.workchain, shard: block.shard, seqno: block.seqno,
    rootHashHex: hashBytes(block.rootHash).toString('hex'), fileHashHex: hashBytes(block.fileHash).toString('hex') };
}

export function assertFreshNetwork(network: Network, init: { workchain?: number; rootHash: Buffer | string; fileHash: Buffer | string }): void {
  if (!init) throw new FreshReadUnavailableError();
  const identity = { init: { workchain: init.workchain ?? -1,
    root_hash: hashBytes(init.rootHash).toString('base64'), file_hash: hashBytes(init.fileHash).toString('base64') } };
  if (network !== 'localnet' && !matchesPublicRpcNetwork(identity, network)) throw new FreshReadUnavailableError();
}

export function assertFreshBlock(actual: SourceBlock, expected: TonBlockIdExt): void {
  const normalized = freshMasterchainBlock(actual);
  if ((['workchain', 'shard', 'seqno', 'rootHashHex', 'fileHashHex'] as const).some(key => normalized[key as keyof TonBlockIdExt] !== expected[key as keyof TonBlockIdExt]))
    throw new FreshReadUnavailableError();
}

function assertAccount(state: AccountStateResponse): void {
  if (!state || typeof state.balance !== 'string' || !/^(0|[1-9]\d*)$/.test(state.balance)
    || !['active', 'uninitialized', 'frozen'].includes(state.accountState ?? '')) throw new FreshReadUnavailableError();
  for (const boc of [state.codeBoc, state.dataBoc]) {
    if (boc !== null && boc !== undefined) {
      if (typeof boc !== 'string' || Cell.fromBoc(Buffer.from(boc, 'base64')).length !== 1) throw new FreshReadUnavailableError();
    }
  }
  if (state.accountState === 'active' && (!state.codeBoc || !state.dataBoc)) throw new FreshReadUnavailableError();
  assertAccountTransactionPointer(state.lastTxLt, state.lastTxHash);
}

/** A fresh provider must return one complete observation, never a merge of different heads. */
export function assertFreshReadBatch(batch: FreshReadBatch, calls: FreshReadCall[], network: Network, startedAt: number): void {
  if (!batch || batch.network !== network || !batch.readContext
    || !['lite', 'http4'].includes(batch.readContext.source)
    || !Number.isSafeInteger(batch.readContext.queriedAt) || batch.readContext.queriedAt < startedAt
    || batch.readContext.queriedAt > Date.now() || batch.results?.length !== calls.length) throw new FreshReadUnavailableError();
  const head = batch.readContext.head;
  freshMasterchainBlock({ ...head, rootHash: head.rootHashHex, fileHash: head.fileHashHex });
  for (const [index, result] of batch.results.entries()) {
    const call = calls[index];
    if (!result || result.kind !== call.kind || result.address !== Address.parse(call.address).toRawString())
      throw new FreshReadUnavailableError();
    if (result.kind === 'account') assertAccount(result.state);
    else if (!Number.isSafeInteger(result.exitCode) || !Array.isArray(result.stack)) throw new FreshReadUnavailableError();
  }
}

export async function executeFreshCalls(calls: FreshReadCall[], read: (call: FreshReadCall) => Promise<FreshReadResult>): Promise<FreshReadResult[]> {
  const results = new Array<FreshReadResult>(calls.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, calls.length) }, async () => {
    while (index < calls.length) {
      const current = index++;
      results[current] = await read(calls[current]);
    }
  }));
  return results;
}

import { Address, type TupleItem } from '@ton/core';
import { matchesPublicRpcNetwork } from '../api/rpcNetwork';
import type { Network } from '../models';
import type { AccountStateResponse, TonBlockIdExt } from './dataSource';
import { assertAccountTransactionPointer } from './accountState';
import { hasSingleRootFreshBoc } from './freshBocValidation';

export type FreshReadCall =
  | { kind: 'account'; address: string }
  | { kind: 'getter'; address: string; method: string; args: TupleItem[] };
export type FreshReadResult =
  | { kind: 'account'; address: string; state: AccountStateResponse }
  | { kind: 'getter'; address: string; exitCode: number; stack: TupleItem[] };
export type FreshReadBatch = {
  network: Network;
  readContext: { source: 'lite' | 'http4'; head: TonBlockIdExt; queriedAt: number };
  results: FreshReadResult[];
};

export class FreshReadUnavailableError extends Error {
  constructor(cause?: unknown) { super('Fresh chain read unavailable.', { cause }); this.name = 'FreshReadUnavailableError'; }
}

export function assertFreshReadActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FreshReadUnavailableError(signal.reason);
}

/** Cancel retry waits without abandoning an already dispatched transport query. */
export async function freshReadDelay(ms: number, signal?: AbortSignal): Promise<void> {
  assertFreshReadActive(signal);
  await new Promise<void>((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      reject(new FreshReadUnavailableError(signal?.reason));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
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
  if (Object.keys(expected).some(key => normalized[key as keyof TonBlockIdExt] !== expected[key as keyof TonBlockIdExt]))
    throw new FreshReadUnavailableError();
}

function assertAccount(state: AccountStateResponse): void {
  if (!state || typeof state.balance !== 'string' || !/^(0|[1-9]\d*)$/.test(state.balance)
    || !['active', 'uninitialized', 'frozen'].includes(state.accountState ?? '')) throw new FreshReadUnavailableError();
  for (const boc of [state.codeBoc, state.dataBoc]) {
    if (boc !== null && boc !== undefined) {
      if (typeof boc !== 'string' || !hasSingleRootFreshBoc(boc)) throw new FreshReadUnavailableError();
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

export async function executeFreshCalls(calls: FreshReadCall[], read: (call: FreshReadCall, signal: AbortSignal) => Promise<FreshReadResult>, signal?: AbortSignal): Promise<FreshReadResult[]> {
  assertFreshReadActive(signal);
  const results = new Array<FreshReadResult>(calls.length);
  const owned = new AbortController();
  let index = 0;
  let failed = false;
  let failure: unknown;
  const fail = (error: unknown) => {
    if (failed) return;
    failed = true; failure = error; owned.abort(error);
  };
  const abort = () => fail(new FreshReadUnavailableError(signal?.reason));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    // Workers catch locally: rejection must not release this operation's
    // ownership while siblings can still dispatch work or overlap fallback.
    await Promise.all(Array.from({ length: Math.min(4, calls.length) }, async () => {
      while (!failed && index < calls.length) {
        const current = index++;
        try {
          results[current] = await read(calls[current], owned.signal);
          assertFreshReadActive(owned.signal);
        } catch (error) { fail(error); }
      }
    }));
    if (failed) throw failure;
    return results;
  } finally { signal?.removeEventListener('abort', abort); }
}

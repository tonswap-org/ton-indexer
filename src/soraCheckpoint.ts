import type { Config } from './config';

const U64_MASK = 0xffff_ffff_ffff_ffffn;
const XXH64_PRIME_1 = 11400714785074694791n;
const XXH64_PRIME_2 = 14029467366897019727n;
const XXH64_PRIME_3 = 1609587929392839161n;
const XXH64_PRIME_4 = 9650029242287828579n;
const XXH64_PRIME_5 = 2870177450012600261n;

export type ResolvedTonTrustedCheckpoint = {
  mcSeqno: number;
  mcBlockHashHex: string;
  source: 'env' | 'rpc';
};

type RpcResponse<T> = {
  result?: T;
  error?: {
    code?: number;
    message?: string;
  };
};

const normalizeHex32 = (value: string | undefined) => {
  if (!value) return null;
  const trimmed = value.trim();
  return /^0x[0-9a-fA-F]{64}$/.test(trimmed) ? trimmed.toLowerCase() : null;
};

const normalizePositiveU32 = (value: number | undefined) => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > 0xffff_ffff) {
    return null;
  }
  return value;
};

const rotl64 = (value: bigint, bits: bigint) =>
  ((value << bits) | (value >> (64n - bits))) & U64_MASK;

const readU64Le = (bytes: Uint8Array, offset: number) => {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value |= BigInt(bytes[offset + index] ?? 0) << BigInt(index * 8);
  }
  return value;
};

const round64 = (acc: bigint, lane: bigint) => {
  let next = (acc + lane * XXH64_PRIME_2) & U64_MASK;
  next = rotl64(next, 31n);
  return (next * XXH64_PRIME_1) & U64_MASK;
};

const mergeRound64 = (acc: bigint, lane: bigint) => {
  let next = acc ^ round64(0n, lane);
  next = (next * XXH64_PRIME_1 + XXH64_PRIME_4) & U64_MASK;
  return next;
};

const avalanche64 = (value: bigint) => {
  let next = value ^ (value >> 33n);
  next = (next * XXH64_PRIME_2) & U64_MASK;
  next ^= next >> 29n;
  next = (next * XXH64_PRIME_3) & U64_MASK;
  next ^= next >> 32n;
  return next & U64_MASK;
};

const xxhash64 = (input: Uint8Array, seed: bigint) => {
  let offset = 0;
  let hash = 0n;

  if (input.length >= 32) {
    let v1 = (seed + XXH64_PRIME_1 + XXH64_PRIME_2) & U64_MASK;
    let v2 = (seed + XXH64_PRIME_2) & U64_MASK;
    let v3 = seed & U64_MASK;
    let v4 = (seed - XXH64_PRIME_1) & U64_MASK;

    while (offset <= input.length - 32) {
      v1 = round64(v1, readU64Le(input, offset));
      offset += 8;
      v2 = round64(v2, readU64Le(input, offset));
      offset += 8;
      v3 = round64(v3, readU64Le(input, offset));
      offset += 8;
      v4 = round64(v4, readU64Le(input, offset));
      offset += 8;
    }

    hash =
      (rotl64(v1, 1n) + rotl64(v2, 7n) + rotl64(v3, 12n) + rotl64(v4, 18n)) & U64_MASK;
    hash = mergeRound64(hash, v1);
    hash = mergeRound64(hash, v2);
    hash = mergeRound64(hash, v3);
    hash = mergeRound64(hash, v4);
  } else {
    hash = (seed + XXH64_PRIME_5) & U64_MASK;
  }

  hash = (hash + BigInt(input.length)) & U64_MASK;

  while (offset <= input.length - 8) {
    const lane = round64(0n, readU64Le(input, offset));
    hash ^= lane;
    hash = (rotl64(hash, 27n) * XXH64_PRIME_1 + XXH64_PRIME_4) & U64_MASK;
    offset += 8;
  }

  if (offset <= input.length - 4) {
    const lane =
      BigInt(
        input[offset] |
          ((input[offset + 1] ?? 0) << 8) |
          ((input[offset + 2] ?? 0) << 16) |
          ((input[offset + 3] ?? 0) << 24)
      ) & 0xffff_ffffn;
    hash ^= (lane * XXH64_PRIME_1) & U64_MASK;
    hash = (rotl64(hash, 23n) * XXH64_PRIME_2 + XXH64_PRIME_3) & U64_MASK;
    offset += 4;
  }

  while (offset < input.length) {
    hash ^= (BigInt(input[offset]) * XXH64_PRIME_5) & U64_MASK;
    hash = (rotl64(hash, 11n) * XXH64_PRIME_1) & U64_MASK;
    offset += 1;
  }

  return avalanche64(hash);
};

const u64ToLeHex = (value: bigint) => {
  const out = Buffer.alloc(8);
  let next = value & U64_MASK;
  for (let index = 0; index < 8; index += 1) {
    out[index] = Number(next & 0xffn);
    next >>= 8n;
  }
  return out.toString('hex');
};

function twox128Hex(input: string) {
  const bytes = Buffer.from(input, 'utf8');
  return `0x${u64ToLeHex(xxhash64(bytes, 0n))}${u64ToLeHex(xxhash64(bytes, 1n))}`;
}

const SORA_TON_CHECKPOINT_STORAGE_KEY =
  twox128Hex('Sccp') + twox128Hex('TonTrustedCheckpointState').slice(2);

function parseCheckpointBytes(hexValue: string): ResolvedTonTrustedCheckpoint {
  const normalized = typeof hexValue === 'string' ? hexValue.trim() : '';
  if (!/^0x[0-9a-fA-F]+$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error('SORA trusted checkpoint storage payload is not valid hex.');
  }
  const bytes = Buffer.from(normalized.slice(2), 'hex');
  if (bytes.length === 0) {
    throw new Error('SORA trusted checkpoint storage is empty.');
  }
  const bare =
    bytes.length === 36 ? bytes : bytes.length === 37 && bytes[0] === 1 ? bytes.subarray(1) : null;
  if (!bare || bare.length !== 36) {
    throw new Error('SORA trusted checkpoint storage payload has an unexpected SCALE layout.');
  }
  return {
    mcSeqno: bare.readUInt32LE(0),
    mcBlockHashHex: `0x${bare.subarray(4).toString('hex')}`,
    source: 'rpc'
  };
}

export class SoraTonCheckpointResolver {
  private readonly config: Pick<
    Config,
    | 'soraRpcEndpoint'
    | 'soraRpcTimeoutMs'
    | 'soraCheckpointCacheTtlMs'
    | 'soraTonTrustedCheckpointSeqno'
    | 'soraTonTrustedCheckpointHash'
  >;
  private cache: { value: ResolvedTonTrustedCheckpoint; expiresAt: number } | null = null;

  constructor(
    config: Pick<
      Config,
      | 'soraRpcEndpoint'
      | 'soraRpcTimeoutMs'
      | 'soraCheckpointCacheTtlMs'
      | 'soraTonTrustedCheckpointSeqno'
      | 'soraTonTrustedCheckpointHash'
    >
  ) {
    this.config = config;
  }

  async resolveTonTrustedCheckpoint(): Promise<ResolvedTonTrustedCheckpoint> {
    const staticSeqno = normalizePositiveU32(this.config.soraTonTrustedCheckpointSeqno);
    const staticHash = normalizeHex32(this.config.soraTonTrustedCheckpointHash);
    if ((staticSeqno === null) !== (staticHash === null)) {
      throw new Error(
        'SORA TON trusted checkpoint env override requires both seqno and hash to be configured.'
      );
    }
    if (staticSeqno !== null && staticHash) {
      return {
        mcSeqno: staticSeqno,
        mcBlockHashHex: staticHash,
        source: 'env'
      };
    }

    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      return this.cache.value;
    }

    const endpoint = this.config.soraRpcEndpoint?.trim();
    if (!endpoint) {
      throw new Error(
        'Automatic SORA TON checkpoint resolution is unavailable. Configure SORA_RPC_HTTP_ENDPOINT or pass the checkpoint explicitly.'
      );
    }

    const finalizedHead = await this.rpcCall<string>(endpoint, 'chain_getFinalizedHead', []);
    if (!normalizeHex32(finalizedHead)) {
      throw new Error('SORA RPC returned an invalid finalized head hash.');
    }
    const storage = await this.rpcCall<string | null>(endpoint, 'state_getStorage', [
      SORA_TON_CHECKPOINT_STORAGE_KEY,
      finalizedHead
    ]);
    if (storage === null) {
      throw new Error('SORA TON trusted checkpoint is not configured on-chain.');
    }
    const resolved = parseCheckpointBytes(storage);
    const ttlMs =
      typeof this.config.soraCheckpointCacheTtlMs === 'number' &&
      Number.isFinite(this.config.soraCheckpointCacheTtlMs) &&
      this.config.soraCheckpointCacheTtlMs > 0
        ? Math.trunc(this.config.soraCheckpointCacheTtlMs)
        : 10_000;
    this.cache = { value: resolved, expiresAt: now + ttlMs };
    return resolved;
  }

  private async rpcCall<T>(endpoint: string, method: string, params: unknown[]): Promise<T> {
    const timeoutMs =
      typeof this.config.soraRpcTimeoutMs === 'number' &&
      Number.isFinite(this.config.soraRpcTimeoutMs) &&
      this.config.soraRpcTimeoutMs > 0
        ? Math.trunc(this.config.soraRpcTimeoutMs)
        : 10_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 1,
          jsonrpc: '2.0',
          method,
          params
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`SORA RPC HTTP ${response.status}`);
      }
      const payload = (await response.json()) as RpcResponse<T>;
      if (payload.error) {
        throw new Error(
          `SORA RPC ${method} failed${payload.error.code !== undefined ? ` (${payload.error.code})` : ''}: ${payload.error.message ?? 'unknown error'}`
        );
      }
      return payload.result as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`SORA RPC ${method} timed out.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

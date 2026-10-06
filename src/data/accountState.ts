/** Current chain account cursors are an exact uint64 LT and 256-bit hash pair. */
export function canonicalAccountHash(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid account transaction hash.');
  if (/^[a-fA-F0-9]{64}$/.test(value)) return Buffer.from(value, 'hex').toString('base64');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) throw new Error('Invalid account transaction hash.');
  return value;
}

export function assertAccountTransactionPointer(lt: unknown, hash: unknown): void {
  if (lt === undefined && hash === undefined) return;
  if (typeof lt !== 'string' || !/^(0|[1-9]\d*)$/.test(lt) || BigInt(lt) > 0xffffffffffffffffn)
    throw new Error('Invalid account transaction logical time.');
  const bytes = Buffer.from(canonicalAccountHash(hash), 'base64');
  if ((lt === '0') !== bytes.equals(Buffer.alloc(32))) throw new Error('Invalid zero account transaction pointer.');
}

export function parseAccountTransactionPointer(value: unknown): { lastTxLt?: string; lastTxHash?: string } {
  if (value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing account transaction pointer.');
  const pointer = value as { lt?: unknown; hash?: unknown };
  assertAccountTransactionPointer(pointer.lt, pointer.hash);
  // An object must carry both fields; an explicit null is the sole absent pointer.
  if (typeof pointer.lt !== 'string') throw new Error('Missing account transaction pointer.');
  return { lastTxLt: pointer.lt, lastTxHash: canonicalAccountHash(pointer.hash) };
}

import fs from 'node:fs';
import { isAbsolute } from 'node:path';

const SECRET_NAMES = ['DATABASE_URL', 'DATA_ENCRYPTION_KEY', 'INDEXER_API_KEY',
  'TON_RPC_API_KEY', 'COINGECKO_API_KEY', 'VAPID_PRIVATE_KEY'] as const;
type SecretName = typeof SECRET_NAMES[number];
const MAX_SECRET_BYTES = 64 * 1024;
const IDENTITY = ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const;

function readFile(name: SecretName, path: string): string {
  const failure = () => new Error(`${name}_FILE must select a stable private UTF-8 file of 1..65536 bytes owned by this process user.`);
  if (!isAbsolute(path) || path.includes('\0')) throw failure();
  let fd: number | undefined;
  let bytes: Buffer | undefined;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd, { bigint: true });
    const uid = process.getuid?.();
    if (!before.isFile() || uid === undefined || before.uid !== BigInt(uid) || before.nlink !== 1n ||
      (before.mode & 0o077n) !== 0n || before.size < 1n || before.size > BigInt(MAX_SECRET_BYTES)) throw failure();
    bytes = Buffer.alloc(MAX_SECRET_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(path, { bigint: true });
    if (length !== Number(before.size) || !named.isFile() ||
      !IDENTITY.every(field => before[field] === after[field] && before[field] === named[field])) throw failure();
    // Keep a UTF-8 BOM as data; source selection must not normalize secret bytes.
    const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
    if (value.includes('\0')) throw failure();
    return value;
  } catch {
    throw failure();
  } finally {
    bytes?.fill(0);
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { throw failure(); }
    }
  }
}

export function readSecretText(env: NodeJS.ProcessEnv, name: SecretName, required: true): string;
export function readSecretText(env: NodeJS.ProcessEnv, name: SecretName, required?: false): string | undefined;
export function readSecretText(env: NodeJS.ProcessEnv, name: SecretName, required = false): string | undefined {
  if (!SECRET_NAMES.includes(name)) throw new Error('Unsupported platform secret setting.');
  const inline = env[name], path = env[`${name}_FILE`];
  if ((inline !== undefined && typeof inline !== 'string') || (path !== undefined && typeof path !== 'string')) {
    throw new Error(`${name} and ${name}_FILE must be strings when configured.`);
  }
  if (inline !== undefined && path !== undefined) throw new Error(`Configure only one of ${name} or ${name}_FILE.`);
  if (inline === undefined && path === undefined) {
    if (required) throw new Error(`Configure ${name} or ${name}_FILE.`);
    return undefined;
  }
  const value = path !== undefined ? readFile(name, path) : inline!;
  if (!value.length || value.includes('\0') || Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES) {
    throw new Error(`${name} must contain 1..65536 UTF-8 bytes without NUL.`);
  }
  return value;
}

export function readDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return readSecretText(env, 'DATABASE_URL', true);
}

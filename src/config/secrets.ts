import * as fs from 'node:fs';
import { isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';

type SecretName = 'INDEXER_DATABASE_URL' | 'INDEXER_EDGE_KEY' | 'INDEXER_ADMIN_TOKEN';
const MAX_SECRET_BYTES = 64 * 1024;

/** Resolve exactly one explicit source. Never put resolved values back into env. */
export function readSecretText(env: NodeJS.ProcessEnv, name: SecretName): string | undefined {
  const inline = env[name];
  const file = env[`${name}_FILE`];
  if (inline !== undefined && file !== undefined) throw new Error(`Configure only one ${name} source.`);
  if (inline === undefined && file === undefined) return undefined;
  if (file === undefined) {
    if (!inline?.length) throw new Error(`The ${name} secret is empty.`);
    if (Buffer.byteLength(inline, 'utf8') > MAX_SECRET_BYTES || inline.includes('\0')) {
      throw new Error(`The ${name} secret is invalid or too large.`);
    }
    return inline;
  }
  const fail = () => new Error(`The ${name}_FILE secret could not be read safely.`);
  if (!isAbsolute(file) || file.includes('\0')) throw fail();
  let fd: number | undefined;
  let bytes: Buffer | undefined;
  let value: string;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd, { bigint: true });
    const uid = process.getuid?.();
    if (!before.isFile() || before.nlink !== 1n || uid === undefined || before.uid !== BigInt(uid)
      || (before.mode & 0o077n) !== 0n || before.size > BigInt(MAX_SECRET_BYTES)) throw fail();
    bytes = Buffer.alloc(MAX_SECRET_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (read === 0) break;
      length += read;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(file, { bigint: true });
    if (length !== Number(before.size) || length > MAX_SECRET_BYTES || !named.isFile()
      || !(['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const)
        .every(key => before[key] === after[key] && before[key] === named[key])) throw fail();
    // Do not silently replace malformed bytes or discard a BOM from key material.
    value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
    if (value.includes('\0')) throw fail();
  } catch {
    throw fail();
  } finally {
    bytes?.fill(0);
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { throw fail(); }
    }
  }
  if (value.length === 0) throw new Error(`The ${name}_FILE secret is empty.`);
  return value;
}

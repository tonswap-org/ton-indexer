import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export type LiteserverPeer = { host: string; port: number; publicKey: Buffer };
const invalid = (detail: string): never => { throw new Error(`Invalid LITESERVER_POOL configuration: ${detail}`); };
function peer(host: unknown, port: unknown, key: unknown): LiteserverPeer {
  if (typeof host !== 'string' || !host || !/^[a-zA-Z0-9.:[\]-]+$/.test(host)) return invalid('invalid host');
  if (!Number.isSafeInteger(port) || Number(port) < 1 || Number(port) > 65535) return invalid('invalid port');
  if (typeof key !== 'string') return invalid('missing public key');
  const publicKey = Buffer.from(key, 'base64');
  if (publicKey.length !== 32 || publicKey.toString('base64') !== key) return invalid('public key must be canonical base64 for 32 bytes');
  return { host, port: Number(port), publicKey };
}

/** Reviewed local configuration only: startup must never discover peers over HTTP. */
export function loadLiteserverPool(value: string | undefined): LiteserverPeer[] {
  if (!value?.trim()) return invalid('set LITESERVER_POOL_MAINNET, LITESERVER_POOL_TESTNET or LITESERVER_POOL_LOCALNET');
  value = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return invalid('URLs are forbidden; use an absolute local file or an inline peer list');
  let peers: LiteserverPeer[];
  if (isAbsolute(value)) {
    let data: unknown;
    try { data = JSON.parse(readFileSync(value, 'utf8')); } catch { return invalid('cannot read the local global-config JSON'); }
    const rows = (data as { liteservers?: unknown })?.liteservers;
    if (!Array.isArray(rows)) return invalid('missing liteservers array');
    peers = rows.map(row => {
      if (!row || !Number.isInteger(row.ip) || row.ip < -2147483648 || row.ip > 4294967295) return invalid('invalid IPv4 integer');
      const address = row.ip >>> 0;
      return peer([address >>> 24, (address >>> 16) & 255, (address >>> 8) & 255, address & 255].join('.'), row.port, row.id?.key);
    });
  } else {
    peers = value.split(',').map(entry => {
      const match = /^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+):(\d+):([^:]+)$/.exec(entry.trim());
      if (!match) return invalid('expected host:port:base64key or an absolute local path');
      return peer(match[1], Number(match[2]), match[3]);
    });
  }
  if (!peers.length) return invalid('empty peer list');
  const unique = new Map(peers.map(row => [`${row.host}:${row.port}:${row.publicKey.toString('hex')}`, row]));
  return [...unique.values()];
}

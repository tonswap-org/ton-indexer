import { canonicalLedgerAddress, canonicalLedgerHash } from './normalize';
import type { LedgerEvent } from './types';

export type PublicationInputs = {
  accounts: Array<{ account: string; headLt: string | null; headHash: string | null }>;
  bindings: Record<string, boolean>;
};
export type PublicationDecision = { publish: true } | {
  publish: false; reason: 'account_missing' | 'account_behind' | 'binding_unresolved'; accounts: string[]; bindings: string[];
};
export function decidePublication(previous: PublicationInputs | null, next: PublicationInputs): PublicationDecision {
  if (!previous) return { publish: true };
  const current = new Map(next.accounts.map(row => [row.account, row]));
  const missing = previous.accounts.filter(row => !current.has(row.account)).map(row => row.account).sort();
  if (missing.length) return { publish: false, reason: 'account_missing', accounts: missing, bindings: [] };
  const behind = previous.accounts.filter(row => {
    const value = current.get(row.account)!;
    if (row.headLt === null) return false;
    return value.headLt === null || BigInt(value.headLt) < BigInt(row.headLt) ||
      (value.headLt === row.headLt && value.headHash !== row.headHash);
  }).map(row => row.account).sort();
  if (behind.length) return { publish: false, reason: 'account_behind', accounts: behind, bindings: [] };
  const bindings = Object.keys(previous.bindings).filter(key => previous.bindings[key] && next.bindings[key] !== true).sort();
  return bindings.length ? { publish: false, reason: 'binding_unresolved', accounts: [], bindings } : { publish: true };
}
export function countConfirmedRegressions(previous: LedgerEvent[], next: LedgerEvent[]): number {
  const current = new Map(next.map(event => [event.id, event]));
  return previous.filter(event => event.settlement?.status === 'confirmed' && current.get(event.id)?.settlement?.status !== 'confirmed').length;
}

/** The boolean-map column has a closed, versioned representation. Diagnostic
 * current/* entries NEVER authorize publication. published/* entries belong to
 * exactly the generation marker and advance only in complete()'s transaction.
 * No plain-map, unknown-key, or missing-checkpoint compatibility is supported. */
export function encodeBindings(current: Record<string, boolean>, published: { generation: string; bindings: Record<string, boolean> } | null): Record<string, boolean> {
  const result: Record<string, boolean> = { 'format/owner-publication-v1': true };
  for (const [key, value] of Object.entries(current)) result[`current/${key}`] = value;
  if (published) {
    result[`generation/${published.generation}`] = true;
    for (const [key, value] of Object.entries(published.bindings)) result[`published/${key}`] = value;
  }
  return result;
}
export function decodeBindings(value: Record<string, boolean> | undefined): {
  current: Record<string, boolean>; published: { generation: string; bindings: Record<string, boolean> } | null;
} | null {
  if (!value || value['format/owner-publication-v1'] !== true) return null;
  const current: Record<string, boolean> = {}, bindings: Record<string, boolean> = {};
  let generation: string | null = null;
  for (const [key, flag] of Object.entries(value)) {
    if (typeof flag !== 'boolean') return null;
    if (key === 'format/owner-publication-v1') continue;
    if (key.startsWith('current/') && key.length > 8) current[key.slice(8)] = flag;
    else if (key.startsWith('published/') && key.length > 10) bindings[key.slice(10)] = flag;
    else if (/^generation\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key) && flag && generation === null) generation = key.slice(11);
    else return null;
  }
  if (!generation && Object.keys(bindings).length) return null;
  return { current, published: generation ? { generation, bindings } : null };
}

/** Exact immutable historical proof identity; unrelated observations cannot
 * satisfy a previously resolved archive binding. */
export function archiveBindingKey(account: string, lt: string, hash: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(lt) || BigInt(lt) > 0xffffffffffffffffn) throw new Error('Invalid archive LT');
  return `archive:${JSON.stringify([canonicalLedgerAddress(account), lt, canonicalLedgerHash(hash)])}`;
}
export function parseArchiveBindingKey(key: string): { account: string; lt: string; hash: string } | null {
  if (!key.startsWith('archive:')) return null;
  try {
    const value = JSON.parse(key.slice(8));
    if (!Array.isArray(value) || value.length !== 3 || value.some(item => typeof item !== 'string') ||
      archiveBindingKey(value[0], value[1], value[2]) !== key) return null;
    return { account: value[0], lt: value[1], hash: value[2] };
  } catch { return null; }
}

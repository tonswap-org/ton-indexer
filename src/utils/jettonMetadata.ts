import { createHash } from 'node:crypto';
import { Cell, Dictionary } from '@ton/core';
import type { JettonMetadata } from '../models';

const FIELDS = ['name', 'description', 'image', 'symbol', 'decimals', 'uri'] as const;
/** Display metadata is optional, untrusted text, never accounting precision. */
export function metadataText(value: unknown): string | undefined {
  return typeof value === 'string' && !value.includes('\0') && value.length <= 8192 ? value : undefined;
}
function snake(cell: Cell, prefix: boolean): string | undefined {
  const chunks: Buffer[] = [];
  let size = 0;
  for (let depth = 0; depth < 64; depth++) {
    const s = cell.beginParse();
    if (prefix) {
      if (s.remainingBits < 8 || s.loadUint(8) !== 0) return undefined;
      prefix = false;
    }
    if (s.remainingBits % 8 || s.remainingRefs > 1) return undefined;
    size += s.remainingBits / 8;
    if (size > 8192) return undefined;
    chunks.push(s.loadBuffer(s.remainingBits / 8));
    if (!s.remainingRefs) return metadataText(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    cell = s.loadRef();
  }
  return undefined;
}
export function parseJettonMetadata(content: { beginParse: () => any }): JettonMetadata {
  try {
    const s = content.beginParse();
    if (s.remainingBits < 8) return {};
    const tag = s.loadUint(8);
    if (tag === 1) {
      const uri = snake(s.asCell(), false);
      return uri === undefined ? {} : { uri };
    }
    if (tag !== 0) return {};
    const dict = s.loadDict(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell());
    if (s.remainingBits || s.remainingRefs) return {};
    const result: JettonMetadata = {};
    for (const field of FIELDS) {
      const valueCell = dict.get(createHash('sha256').update(field).digest());
      if (!valueCell) continue;
      let value: string | undefined;
      try { value = snake(valueCell, true); } catch { continue; }
      if (value === undefined) continue;
      if (field === 'decimals') {
        if (/^(0|[1-9][0-9]{0,2})$/.test(value) && Number(value) <= 255) result.decimals = Number(value);
      } else result[field] = value;
    }
    return result;
  } catch { return {}; }
}

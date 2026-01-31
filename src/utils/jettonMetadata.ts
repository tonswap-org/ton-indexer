import { createHash } from 'node:crypto';
import { Dictionary } from 'ton-core';
import { JettonMetadata } from '../models';

const KEY_FIELDS = ['name', 'description', 'image', 'symbol', 'decimals', 'uri'] as const;

const keyHash = (key: string) => createHash('sha256').update(key).digest();

const readSnakeString = (cell: { beginParse: () => any }): string => {
  return cell.beginParse().loadStringTail();
};

export const parseJettonMetadata = (content: { beginParse: () => any }): JettonMetadata => {
  const slice = content.beginParse();
  if (slice.remainingBits < 8) return {};

  const tag = slice.loadUint(8);
  if (tag === 0x01) {
    const uri = slice.loadStringTail();
    return { uri };
  }

  if (tag === 0x00) {
    const dict = slice.loadDict(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell());
    const meta: JettonMetadata = {};

    for (const field of KEY_FIELDS) {
      const key = keyHash(field);
      const valueCell = dict.get(key);
      if (!valueCell) continue;
      const value = readSnakeString(valueCell);
      if (field === 'decimals') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          meta.decimals = parsed;
        }
      } else if (field === 'symbol') {
        meta.symbol = value;
      } else if (field === 'name') {
        meta.name = value;
      } else if (field === 'description') {
        meta.description = value;
      } else if (field === 'image') {
        meta.image = value;
      } else if (field === 'uri') {
        meta.uri = value;
      }
    }

    return meta;
  }

  // Unknown format: attempt to read as string tail.
  try {
    const uri = slice.loadStringTail();
    return { uri };
  } catch {
    return {};
  }
};

import { readFileSync } from 'node:fs';

export type OpcodeSets = {
  swap: Set<number>;
  lpDeposit: Set<number>;
  lpWithdraw: Set<number>;
  jettonTransfer: Set<number>;
  jettonNotify: Set<number>;
};

const safeParseHex = (value: string): number | null => {
  try {
    return Number.parseInt(value, 16);
  } catch {
    return null;
  }
};

export const loadOpcodes = (path?: string): OpcodeSets => {
  const sets: OpcodeSets = {
    swap: new Set([0x53574150]), // OP_SWAP
    lpDeposit: new Set([0x41444c51, 0x49504f53]), // OP_ADD_LIQ, OP_INCREASE_POSITION
    lpWithdraw: new Set([0x524d4c51, 0x44504f53]), // OP_REMOVE_LIQ, OP_DECREASE_POSITION
    jettonTransfer: new Set([0x0f8a7ea5]),
    jettonNotify: new Set([0x7362d09c]),
  };

  if (!path) return sets;
  try {
    const raw = readFileSync(path, 'utf8');
    const data = JSON.parse(raw) as Record<string, Record<string, string>>;

    for (const contract of Object.values(data)) {
      for (const [name, value] of Object.entries(contract)) {
        const parsed = safeParseHex(value);
        if (parsed === null || Number.isNaN(parsed)) continue;
        if (name.includes('OP_SWAP')) sets.swap.add(parsed);
        if (name.includes('OP_ADD_LIQ') || name.includes('OP_INCREASE_POSITION') || name.includes('OP_POOL_SEED_DEPOSIT')) {
          sets.lpDeposit.add(parsed);
        }
        if (name.includes('OP_REMOVE_LIQ') || name.includes('OP_DECREASE_POSITION')) {
          sets.lpWithdraw.add(parsed);
        }
        if (name.includes('OP_JETTON_TRANSFER')) sets.jettonTransfer.add(parsed);
        if (name.includes('OP_JETTON_TRANSFER_NOTIFICATION')) sets.jettonNotify.add(parsed);
      }
    }
  } catch {
    // Keep defaults if file missing or invalid.
  }

  return sets;
};

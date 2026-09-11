import { Cell, type TupleItem } from '@ton/core';
import { keccak_256 } from '@noble/hashes/sha3';
import type { RawMessage } from '../data/dataSource';
import { bodyCell } from './wire';
export const SCCP_BURN = 0x4f80d7e1,
  SCCP_BURN_NOTIFY = 0x6b2e76a4,
  SCCP_MINT = 0x23e4c1a0,
  SCCP_BURNED = 0x1fd0ab62;
const end = (s: ReturnType<Cell['beginParse']>) => {
  if (s.remainingBits || s.remainingRefs)
    throw new Error('Trailing SCCP message');
};
const recipientValid = (domain: number, value: bigint) =>
  domain >= 0 &&
  domain <= 5 &&
  value > 0n &&
  (![1, 2, 5].includes(domain) || value < 1n << 160n);
export const hex256 = (value: bigint) =>
  `0x${value.toString(16).padStart(64, '0')}`;
export function sccpBurnRequest(message?: RawMessage) {
  try {
    const c = bodyCell(message);
    if (!c) return null;
    const s = c.beginParse();
    if (s.loadUint(32) !== SCCP_BURN) return null;
    const queryId = s.loadUintBig(64).toString(),
      amountRaw = s.loadCoins().toString(),
      destinationDomain = s.loadUint(32),
      recipient = s.loadUintBig(256),
      response = s.loadMaybeAddress()?.toRawString() ?? null;
    end(s);
    if (
      amountRaw === '0' ||
      destinationDomain === 4 ||
      !recipientValid(destinationDomain, recipient)
    )
      return null;
    return {
      queryId,
      amountRaw,
      destinationDomain,
      recipient32: hex256(recipient),
      response,
    };
  } catch {
    return null;
  }
}
export function sccpBurnNotification(message?: RawMessage) {
  try {
    const c = bodyCell(message);
    if (!c) return null;
    const s = c.beginParse();
    if (s.loadUint(32) !== SCCP_BURN_NOTIFY) return null;
    const queryId = s.loadUintBig(64).toString(),
      amountRaw = s.loadCoins().toString(),
      owner = s.loadAddress().toRawString(),
      details = s.loadRef().beginParse(),
      destinationDomain = details.loadUint(32),
      recipient = details.loadUintBig(256),
      response = s.loadMaybeAddress()?.toRawString() ?? null;
    end(s);
    end(details);
    if (
      amountRaw === '0' ||
      destinationDomain === 4 ||
      !recipientValid(destinationDomain, recipient)
    )
      return null;
    return {
      queryId,
      amountRaw,
      owner,
      destinationDomain,
      recipient32: hex256(recipient),
      response,
    };
  } catch {
    return null;
  }
}
export function sccpMintRequest(message?: RawMessage) {
  try {
    const c = bodyCell(message);
    if (!c) return null;
    const s = c.beginParse();
    if (s.loadUint(32) !== SCCP_MINT) return null;
    const queryId = s.loadUintBig(64).toString(),
      sourceDomain = s.loadUint(32),
      nonce = s.loadUintBig(64).toString(),
      amountRaw = s.loadCoins().toString(),
      recipient = s.loadUintBig(256),
      response = s.loadMaybeAddress()?.toRawString() ?? null;
    end(s);
    if (
      amountRaw === '0' ||
      sourceDomain < 0 ||
      sourceDomain > 5 ||
      sourceDomain === 4 ||
      recipient === 0n
    )
      return null;
    return {
      queryId,
      sourceDomain,
      nonce,
      amountRaw,
      recipient32: hex256(recipient),
      response,
    };
  } catch {
    return null;
  }
}
export function sccpMessageId(
  sourceDomain: number,
  destinationDomain: number,
  nonce: string,
  soraAssetId: string,
  amountRaw: string,
  recipient32: string,
) {
  if (
    !Number.isInteger(sourceDomain) ||
    sourceDomain < 0 ||
    sourceDomain > 5 ||
    !Number.isInteger(destinationDomain) ||
    destinationDomain < 0 ||
    destinationDomain > 5 ||
    !/^(0|[1-9][0-9]*)$/.test(nonce) ||
    BigInt(nonce) >= 1n << 64n ||
    !/^(0|[1-9][0-9]*)$/.test(amountRaw) ||
    !/^0x[0-9a-f]{64}$/.test(soraAssetId) ||
    !/^0x[0-9a-f]{64}$/.test(recipient32)
  )
    throw new Error('Non-canonical SCCP payload identity');
  const prefix = Buffer.from('sccp:burn:v1'),
    b = Buffer.alloc(97);
  b[0] = 1;
  b.writeUInt32LE(sourceDomain, 1);
  b.writeUInt32LE(destinationDomain, 5);
  b.writeBigUInt64LE(BigInt(nonce), 9);
  Buffer.from(soraAssetId.slice(2), 'hex').copy(b, 17);
  let amount = BigInt(amountRaw);
  if (amount < 0n || amount >= 1n << 128n)
    throw new Error('SCCP amount outside u128');
  for (let i = 0; i < 16; i++) {
    b[49 + i] = Number(amount & 255n);
    amount >>= 8n;
  }
  Buffer.from(recipient32.slice(2), 'hex').copy(b, 65);
  return `0x${Buffer.from(keccak_256(Buffer.concat([prefix, b]))).toString('hex')}`;
}
export function sccpConfig(stack: TupleItem[]) {
  try {
    if (stack.length === 1 && stack[0].type === 'tuple') stack = stack[0].items;
    if (stack.length !== 6) return null;
    const address = (i: number, maybe = false) => {
      const item = stack[i];
      if (maybe && item.type === 'null') return null;
      if (
        !['cell', 'slice', 'builder'].includes(item.type) ||
        !('cell' in item)
      )
        throw new Error('SCCP address');
      const s = item.cell.beginParse(),
        a = maybe ? s.loadMaybeAddress() : s.loadAddress();
      end(s);
      return a?.toRawString() ?? null;
    };
    const governor = address(0),
      verifier = address(1, true);
    const ints = [2, 3, 4, 5].map((i) => {
      const item = stack[i];
      if (
        item.type !== 'int' ||
        item.value < 0n ||
        item.value >= 1n << BigInt(i === 2 ? 256 : 64)
      )
        throw new Error('SCCP integer');
      return item.value;
    });
    if (!governor) return null;
    return {
      governor,
      verifier,
      soraAssetId: hex256(ints[0]),
      nonce: ints[1].toString(),
    };
  } catch {
    return null;
  }
}

import { Cell } from '@ton/core';

export const NATIVE_FUNDING = 0x434e4657;
export const NATIVE_REFUND = 0x434e5246;

export type NativeFundingContext = {
  correlationId: string;
  refundKind: 0 | 1;
  moduleId: number;
  refundTo: string;
};

/** Current journal context has no opcode and no additional reference. */
export function decodeNativeFundingContext(original: Cell): NativeFundingContext {
  const cursor = original.beginParse();
  const correlationId = cursor.loadUintBig(64).toString(), refundKind = cursor.loadUint(8), moduleId = cursor.loadUint(32);
  const refundTo = cursor.loadAddress().toRawString();
  cursor.endParse();
  if (!((refundKind === 0 && moduleId === 0) || (refundKind === 1 && moduleId > 0)))
    throw new Error('Invalid journal native funding context.');
  return { correlationId, refundKind: refundKind as 0 | 1, moduleId, refundTo };
}

/** Routing metadata only. Neither this context nor its label proves authority or settlement. */
export function decodeNativeFundingBody(original: Cell): { businessBody: Cell; funding: NativeFundingContext | null } {
  if (original.bits.length < 32 || original.beginParse().preloadUint(32) !== NATIVE_FUNDING)
    return { businessBody: original, funding: null };
  if (original.isExotic) throw new Error('Native funding requires an ordinary cell.');
  const cursor = original.beginParse(); cursor.loadUint(32);
  const correlationId = cursor.loadUintBig(64).toString();
  const refundKind = cursor.loadUint(8), moduleId = cursor.loadUint(32);
  const refundTo = cursor.loadAddress().toRawString(), businessBody = cursor.loadRef();
  cursor.endParse();
  if (!((refundKind === 0 && moduleId === 0) || (refundKind === 1 && moduleId > 0)) ||
      businessBody.isExotic || businessBody.bits.length < 32 ||
      [NATIVE_FUNDING, NATIVE_REFUND].includes(businessBody.beginParse().preloadUint(32)))
    throw new Error('Invalid native funding envelope.');
  return { businessBody, funding: { correlationId, refundKind: refundKind as 0 | 1, moduleId, refundTo } };
}

/** A typed native return names routing only; actual value and transaction prove the cash movement. */
export function decodeNativeFundingRefund(original: Cell): Omit<NativeFundingContext, 'refundTo'> {
  const cursor = original.beginParse();
  if (cursor.loadUint(32) !== NATIVE_REFUND) throw new Error('Expected native funding refund.');
  const correlationId = cursor.loadUintBig(64).toString(), refundKind = cursor.loadUint(8), moduleId = cursor.loadUint(32);
  cursor.endParse();
  if (!((refundKind === 0 && moduleId === 0) || (refundKind === 1 && moduleId > 0)))
    throw new Error('Invalid native refund context.');
  return { correlationId, refundKind: refundKind as 0 | 1, moduleId };
}

/** Full TVM12+ bounce only; callers must also prove bounced=true and the original physical send. */
export function decodeNativeFundingBounce(original: Cell) {
  const cursor = original.beginParse();
  if (cursor.loadUint(32) !== 0xfffffffe) throw new Error('Expected full native funding rich bounce.');
  const body = cursor.loadRef(), info = cursor.loadRef().beginParse();
  info.loadCoins();
  if (info.loadBit()) info.loadRef();
  info.loadUintBig(64); info.loadUint(32); info.endParse();
  cursor.loadUint(8); cursor.loadInt(32);
  if (cursor.loadBit()) { cursor.loadUint(32); cursor.loadUint(32); }
  cursor.endParse();
  const decoded = decodeNativeFundingBody(body);
  if (!decoded.funding) throw new Error('Rich bounce does not contain funded business body.');
  return { ...decoded, originalBody: body };
}

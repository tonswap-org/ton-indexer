import { Cell } from '@ton/core';
export const SCCP_BURNED_NOTIFICATION_OPCODE = 0x1fd0ab62;
export type TonSccpBurnedNotification = {
  queryId: bigint;
  messageId: bigint;
  nonce: bigint;
};

export const parseSccpBurnedNotification = (
  body: string | undefined,
  declaredOpcode: number | undefined,
): TonSccpBurnedNotification | null => {
  if (!body) {
    if (declaredOpcode === SCCP_BURNED_NOTIFICATION_OPCODE) {
      throw new Error('SCCP burned notification body is missing.');
    }
    return null;
  }
  let roots: Cell[];
  try {
    roots = Cell.fromBoc(Buffer.from(body, 'base64'));
  } catch {
    if (declaredOpcode === SCCP_BURNED_NOTIFICATION_OPCODE) {
      throw new Error('SCCP burned notification body is not a valid BOC.');
    }
    return null;
  }
  if (roots.length !== 1) {
    if (declaredOpcode === SCCP_BURNED_NOTIFICATION_OPCODE) {
      throw new Error(
        'SCCP burned notification must contain exactly one root cell.',
      );
    }
    return null;
  }
  const slice = roots[0].beginParse();
  if (slice.remainingBits < 32) {
    if (declaredOpcode === SCCP_BURNED_NOTIFICATION_OPCODE) {
      throw new Error('SCCP burned notification opcode is truncated.');
    }
    return null;
  }
  const opcode = slice.loadUint(32);
  if (opcode !== SCCP_BURNED_NOTIFICATION_OPCODE) {
    if (declaredOpcode === SCCP_BURNED_NOTIFICATION_OPCODE) {
      throw new Error(
        'SCCP burned notification opcode metadata does not match its body.',
      );
    }
    return null;
  }
  if (declaredOpcode !== undefined && declaredOpcode !== opcode) {
    throw new Error(
      'SCCP burned notification opcode metadata does not match its body.',
    );
  }
  try {
    const notification = {
      queryId: slice.loadUintBig(64),
      messageId: slice.loadUintBig(256),
      nonce: slice.loadUintBig(64),
    };
    if (slice.remainingBits !== 0 || slice.remainingRefs !== 0) {
      throw new Error('trailing data');
    }
    return notification;
  } catch {
    throw new Error('SCCP burned notification body has a non-canonical shape.');
  }
};

export function parseSccpBurnRecord(cell: Cell) {
  try {
    const slice = cell.beginParse(),
      burnInitiator = slice.loadAddress().toRawString(),
      destDomain = slice.loadUintBig(32),
      recipient32 = slice.loadUintBig(256),
      amount = slice.loadCoins(),
      nonce = slice.loadUintBig(64);
    if (slice.remainingBits || slice.remainingRefs)
      throw new Error('trailing data');
    return { burnInitiator, destDomain, recipient32, amount, nonce };
  } catch {
    throw new Error(
      'get_sccp_burn_record returned a non-canonical record cell.',
    );
  }
}

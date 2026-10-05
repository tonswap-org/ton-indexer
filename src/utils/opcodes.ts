export type OpcodeSets = {
  swap: Set<number>;
  lpDeposit: Set<number>;
  lpWithdraw: Set<number>;
  jettonTransfer: Set<number>;
  jettonNotify: Set<number>;
};

/** Current wire operations from contracts/dlmm/pool.tolk and
 * contracts/shared/jetton/jetton_types.tolk. Classification is part of this
 * decoder's code; release configuration cannot add meanings to opcodes. */
export const OPCODES = Object.freeze({
  SWAP_EXACT_IN: 0x44535750,
  SWAP_FORWARD: 0x53574150,
  ADD_LIQUIDITY_FORWARD: 0x444c4144,
  ADD_LIQUIDITY: 0x44414444,
  ADD_LIQUIDITY_FOR: 0x444c4146,
  REMOVE_LIQUIDITY: 0x44524d56,
  JETTON_TRANSFER: 0x0f8a7ea5,
  JETTON_TRANSFER_NOTIFICATION: 0x7362d09c,
});

export const loadOpcodes = (): OpcodeSets => ({
  swap: new Set([OPCODES.SWAP_FORWARD, OPCODES.SWAP_EXACT_IN]),
  lpDeposit: new Set([OPCODES.ADD_LIQUIDITY_FORWARD, OPCODES.ADD_LIQUIDITY, OPCODES.ADD_LIQUIDITY_FOR]),
  lpWithdraw: new Set([OPCODES.REMOVE_LIQUIDITY]),
  jettonTransfer: new Set([OPCODES.JETTON_TRANSFER]),
  jettonNotify: new Set([OPCODES.JETTON_TRANSFER_NOTIFICATION]),
});

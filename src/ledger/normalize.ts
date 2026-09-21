import { Address, Cell } from '@ton/core';
import { createHash } from 'node:crypto';
import type { RawMessage, RawTransaction } from '../data/dataSource';
import type { Network } from '../models';
import type { OpcodeSets } from '../utils/opcodes';
import { classifyTransaction } from '../utils/txClassifier';
import type { LedgerAsset, LedgerEvent, LedgerMovement } from './types';
import { decodeNativeFundingBody } from './nativeFunding';

export const canonicalLedgerAddress = (value: string) =>
  Address.parse(value).toRawString();
export const canonicalLedgerHash = (value: string) => {
  const normalized = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/=+$/, '');
  const bytes = /^[a-f\d]{64}$/i.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(normalized, 'base64');
  if (
    bytes.length !== 32 ||
    (!/^[a-f\d]{64}$/i.test(value) &&
      bytes.toString('base64').replace(/=+$/, '') !== normalized)
  ) {
    throw new Error('Invalid ledger transaction hash');
  }
  return bytes.toString('base64');
};
const atomic = (value: unknown): value is string =>
  typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
const addressOrUndefined = (value?: string) => {
  try {
    return value ? canonicalLedgerAddress(value) : undefined;
  } catch {
    return undefined;
  }
};
export type ResolveJetton = (wallet: string) => Promise<LedgerAsset | null>;

export async function normalizeLedgerEvent(
  network: Network,
  address: string,
  raw: RawTransaction,
  opcodes: OpcodeSets,
  resolveJetton: ResolveJetton = async () => null
): Promise<LedgerEvent> {
  const account = canonicalLedgerAddress(address);
  if (
    !atomic(raw.lt) ||
    BigInt(raw.lt) <= 0n ||
    BigInt(raw.lt) > 0xffffffffffffffffn ||
    !Number.isSafeInteger(raw.utime) ||
    raw.utime < 0
  ) {
    throw new Error('Invalid ledger transaction identity or time');
  }
  // Ledger generations contain terminal physical transactions. A missing or
  // contradictory provider outcome is a decoding gap, never an inferred failure.
  if ((raw.status !== 'success' && raw.status !== 'failed') ||
      raw.success !== (raw.status === 'success')) {
    throw new Error('Ledger transaction requires a consistent terminal outcome status');
  }
  const status = raw.status;
  const hash = canonicalLedgerHash(raw.hash);
  const nativeEvidence = {
    transactionStatus: status,
    transactions: [{ account, lt: raw.lt, hash, utime: raw.utime }] as [import('./types').LedgerEvidenceRef],
  };
  const tx = { ...raw, hash };
  const indexed = classifyTransaction(account, tx, opcodes);
  const id = createHash('sha256')
    .update(`${network}:${account}:${tx.lt}:${hash}`)
    .digest('hex');
  const native: LedgerAsset = {
    kind: 'native',
    id: `${network}:native`,
    symbol: 'GRAM',
    decimals: 9,
  };
  const issues = new Set<string>();
  const movements: LedgerMovement[] = [];
  const add = (movement: Omit<LedgerMovement, 'id'>) =>
    movements.push({ id: `${id}:${movements.length}`, ...movement });

  const messages: {
    msg: RawMessage;
    direction: 'in' | 'out';
    index: number;
  }[] = [
    ...(tx.inMessage
      ? [{ msg: tx.inMessage, direction: 'in' as const, index: -1 }]
      : []),
    ...tx.outMessages.map((msg, index) => ({
      msg,
      direction: 'out' as const,
      index,
    })),
  ];
  for (const { msg, direction, index } of messages) {
    const source = addressOrUndefined(msg.source);
    const destination = addressOrUndefined(msg.destination);
    // External messages have no native transfer; an absent value is not zero.
    if (msg.value !== undefined) {
      if (!atomic(msg.value)) issues.add('invalid_native_amount');
      else if (msg.value !== '0') {
        add({
          direction,
          asset: native,
          amountRaw: msg.value,
          source,
          destination,
          evidence: {
            ...nativeEvidence,
            kind: 'native_message',
            messageIndex: index,
            opcode: msg.op,
          },
        });
      }
    }
    if (!msg.body) {
      if (msg.op && msg.op !== 0) issues.add('message_body_missing');
      continue;
    }
    let cell: Cell;
    try {
      const cells = Cell.fromBoc(Buffer.from(msg.body, 'base64'));
      if (cells.length !== 1) throw new Error('one root required');
      cell = cells[0];
      if (msg.op !== undefined && cell.bits.length >= 32 && cell.beginParse().preloadUint(32) !== msg.op)
        throw new Error('Message opcode contradicts original body');
    } catch {
      issues.add('message_body_invalid');
      continue;
    }
    let business: Cell;
    try { business = decodeNativeFundingBody(cell).businessBody; }
    catch { issues.add('native_funding_invalid'); continue; }
    const body = business.beginParse();
    if (body.remainingBits < 32) continue;
    const opcode = body.loadUint(32);
    // A transfer request/burn instruction is not a settled token movement.
    if (opcode === 0x0f8a7ea5 || opcode === 0x595f07bc) {
      issues.add('settlement_not_decoded');
      continue;
    }
    if (opcode !== 0x7362d09c && opcode !== 0x178d4519 && opcode !== 0x4a534954)
      continue;
    if (status !== 'success') {
      issues.add('jetton_settlement_unconfirmed');
      continue;
    }
    // Notifications certify receipt at the owner. Internal transfers certify
    // receipt at a jetton wallet; emitted transfers remain pending downstream.
    if (direction !== 'in') {
      issues.add('settlement_not_decoded');
      continue;
    }
    try {
      body.loadUintBig(64);
      const amountRaw = body.loadCoins().toString();
      const from = body.loadMaybeAddress()?.toRawString();
      const wallet = opcode === 0x7362d09c ? source : account;
      let asset = wallet ? await resolveJetton(wallet) : null;
      if (opcode === 0x7362d09c && asset?.owner !== account) asset = null;
      if (!asset) issues.add('jetton_identity_unresolved');
      if (asset?.decimals === undefined)
        issues.add('jetton_decimals_unresolved');
      add({
        direction: 'in',
        asset: asset ?? {
          kind: 'unknown',
          id: `${network}:unknown:${wallet ?? account}`,
          wallet,
        },
        amountRaw,
        source: from,
        destination: account,
        evidence: {
          kind:
            opcode === 0x7362d09c
              ? 'jetton_notification'
              : 'jetton_internal_transfer',
          messageIndex: index,
          opcode,
          bodyHash: cell.hash().toString('hex'),
        },
      });
    } catch {
      issues.add('jetton_message_invalid');
    }
  }
  const totalFeesRaw = atomic(tx.totalFeesRaw) ? tx.totalFeesRaw : null;
  if (totalFeesRaw === null) issues.add('transaction_fee_unavailable');
  else if (totalFeesRaw !== '0')
    add({
      direction: 'fee',
      asset: native,
      amountRaw: totalFeesRaw,
      source: account,
      evidence: { ...nativeEvidence, kind: 'transaction_fee' },
    });
  // Current TON (TVM12+) uses the former IHR wire slot for extra_flags.
  // Flags are metadata, never nanotons. Only actual outgoing forwarding fees
  // supplement totalFees; original BOCs retain the full physical message.
  tx.outMessages.forEach((msg, index) => {
    if (msg.value === undefined) return;
    for (const [field, amount] of [
      ['forward', msg.forwardFeeRaw],
    ] as const) {
      if (amount === undefined) {
        issues.add(`outgoing_${field}_fee_unavailable`);
      } else if (!atomic(amount)) {
        issues.add(`outgoing_${field}_fee_invalid`);
      } else if (amount !== '0') {
        movements.push({
          id: `${id}:${field}:${index}`,
          direction: 'fee', asset: native, amountRaw: amount, source: account,
          evidence: { ...nativeEvidence, kind: 'message_forward_fee', messageIndex: index },
        });
      }
    }
  });
  if (indexed.kind !== 'transfer')
    issues.add(
      indexed.kind === 'unknown'
        ? 'transaction_not_decoded'
        : 'settlement_not_decoded'
    );
  // Account-local evidence cannot certify the whole wallet/jetton/protocol trace.
  if (messages.some(({ msg }) => (msg.op ?? 0) !== 0))
    issues.add('related_account_coverage_unverified');
  return {
    id,
    network,
    account,
    lt: tx.lt,
    hash,
    txId: `${tx.lt}:${hash}`,
    utime: tx.utime,
    status,
    kind: indexed.kind,
    totalFeesRaw,
    movements,
    actions: indexed.actions,
    issues: [...issues].sort(),
  };
}

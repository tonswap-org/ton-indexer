import { Address, Cell, Dictionary, beginCell } from '@ton/core';
import type {
  AccountStateResponse,
  TonDataSource,
  TransactionCursor,
} from '../data/dataSource';
import { canonicalLedgerHash } from './normalize';

export type LedgerStateSnapshot = {
  seqno: number;
  state: AccountStateResponse;
};
/** A boundary is usable only if its account last-transaction hash is exact.
 * Intermediate states require authenticated replay, never interpolation. */
export async function findTransactionState(
  source: TonDataSource,
  account: string,
  cursor: TransactionCursor
): Promise<LedgerStateSnapshot | null> {
  if (!source.getAccountStateAtSeqno || !/^[1-9][0-9]*$/.test(cursor.lt))
    return null;
  try {
    let low = 0;
    let high = (await source.getMasterchainInfo()).seqno;
    if (!Number.isSafeInteger(high) || high < 0) return null;
    let candidate: LedgerStateSnapshot | null = null;
    while (low <= high) {
      const seqno = Math.floor((low + high) / 2);
      const state = await source.getAccountStateAtSeqno(account, seqno);
      const lt = state.lastTxLt == null ? 0n : BigInt(state.lastTxLt);
      if (lt >= BigInt(cursor.lt)) {
        candidate = { seqno, state };
        high = seqno - 1;
      } else low = seqno + 1;
    }
    if (candidate && BigInt(candidate.state.lastTxLt ?? '0') > BigInt(cursor.lt) &&
        source.getAccountStateAtTransaction) {
      candidate = {
        seqno: candidate.seqno,
        state: await source.getAccountStateAtTransaction(account, cursor, candidate.seqno),
      };
    }
    if (
      candidate?.state.lastTxLt !== cursor.lt ||
      !candidate.state.lastTxHash ||
      canonicalLedgerHash(candidate.state.lastTxHash) !==
        canonicalLedgerHash(cursor.hash)
    )
      return null;
    return candidate;
  } catch {
    return null;
  }
}

export function readDlmmPositionState(
  dataBoc: string,
  owner: string,
  binId: number
) {
  const cell = Cell.fromBase64(dataBoc);
  const root = cell.beginParse();
  const tokenT = root.loadAddress().toRawString();
  const tokenX = root.loadAddress().toRawString();
  root.loadAddress();
  if (root.remainingRefs !== 4)
    throw new Error('Unrecognized DLMM state layout');
  const meta = cell.refs[3];
  if (meta.refs.length < 2) throw new Error('DLMM position dictionary missing');
  const positionContainer = meta.refs[1];
  if (positionContainer.bits.length !== 0 || positionContainer.refs.length < 2)
    throw new Error('Unrecognized DLMM position layout');
  const positionsCell = positionContainer.refs[0];
  const key = BigInt(
    `0x${beginCell().storeAddress(Address.parse(owner)).storeInt(binId, 32).endCell().hash().toString('hex')}`
  );
  const positions = positionsCell
    .beginParse()
    .loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.BigUint(256));
  return {
    tokenT,
    tokenX,
    shares: positions.get(key) ?? 0n,
    dataHash: cell.hash().toString('hex'),
  };
}

/** Terminal withdrawal state binds the business query to the exact two wallet
 * settlement nonces. Equal amounts or close timestamps are insufficient. */
export function readDlmmWithdrawalState(dataBoc: string, queryId: string) {
  const data = Cell.fromBase64(dataBoc),
    container = data.refs[3]?.refs[1];
  if (!container || container.bits.length !== 0 || container.refs.length !== 4)
    throw new Error('Withdrawal journal missing');
  const s = container.refs[2].beginParse();
  s.loadUintBig(64);
  const dict = s.loadDict(
    Dictionary.Keys.BigUint(64),
    Dictionary.Values.Cell()
  );
  if (s.remainingBits || s.remainingRefs)
    throw new Error('Trailing withdrawal journal');
  const value = dict.get(BigInt(queryId));
  if (!value) return null;
  const r = value.beginParse();
  if (
    r.remainingBits !== 516 ||
    r.remainingRefs !== 4 ||
    r.loadUint(32) !== 0x44575231
  )
    throw new Error('Unrecognized withdrawal record');
  const recordQueryId = r.loadUintBig(64).toString(),
    binId = r.loadInt(32),
    shares = r.loadUintBig(256).toString(),
    legT = r.loadUint(2),
    legX = r.loadUint(2),
    settlementTId = r.loadUintBig(64).toString(),
    settlementXId = r.loadUintBig(64).toString();
  const actors = r.loadRef().beginParse(),
    amounts = r.loadRef().beginParse(),
    sources = r.loadRef().beginParse(),
    destinations = r.loadRef().beginParse();
  const owner = actors.loadAddress().toRawString(),
    recipient = actors.loadAddress().toRawString(),
    totalT = amounts.loadCoins().toString(),
    totalX = amounts.loadCoins().toString();
  amounts.loadCoins();
  const poolWalletT = sources.loadMaybeAddress()?.toRawString() ?? null,
    poolWalletX = sources.loadMaybeAddress()?.toRawString() ?? null,
    recipientWalletT = destinations.loadMaybeAddress()?.toRawString() ?? null,
    recipientWalletX = destinations.loadMaybeAddress()?.toRawString() ?? null;
  if (
    [r, actors, amounts, sources, destinations].some(
      (slice) => slice.remainingBits || slice.remainingRefs
    ) ||
    recordQueryId !== queryId ||
    legT > 2 ||
    legX > 2
  )
    throw new Error('Invalid withdrawal record');
  return {
    queryId,
    binId,
    shares,
    legT,
    legX,
    settlementTId,
    settlementXId,
    owner,
    recipient,
    totalT,
    totalX,
    poolWalletT,
    poolWalletX,
    recipientWalletT,
    recipientWalletX,
    dataHash: data.hash().toString('hex'),
  };
}

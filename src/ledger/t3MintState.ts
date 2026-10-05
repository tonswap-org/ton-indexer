import { Address, Cell, Dictionary, beginCell } from '@ton/core';
import { decodeNativeFundingContext } from './nativeFunding';
import { t3State } from './t3Wire';

const end = (s: ReturnType<Cell['beginParse']>) => s.endParse();
export const t3MintKey = (owner: string, queryId: string) => BigInt('0x' + beginCell()
  .storeUint(0x54334d52, 32).storeAddress(Address.parse(owner))
  .storeUint(BigInt(queryId), 64).endCell().hash().toString('hex'));

/** The sole current mint journal codec; an opaque retained cell is never delivery proof. */
export function readT3MintJournal(cell: Cell) {
  const s = cell.beginParse();
  const status = s.loadUint(8), queryId = s.loadUintBig(64).toString(),
    rootQueryId = s.loadUintBig(64).toString(), amountRaw = s.loadCoins().toString(),
    recipient = s.loadMaybeAddress(), details = s.loadRef().beginParse();
  end(s);
  const destination = details.loadMaybeAddress(), requestHash = details.loadUintBig(256),
    controlBudget = details.loadCoins(), receipt = details.loadRef(), fundingCell = details.loadRef();
  end(details);
  const funding = decodeNativeFundingContext(fundingCell);
  const fundingEncoded = beginCell().storeUint(BigInt(funding.correlationId), 64)
    .storeUint(funding.refundKind, 8).storeUint(funding.moduleId, 32)
    .storeAddress(Address.parse(funding.refundTo)).endCell();
  const encoded = beginCell().storeUint(status, 8).storeUint(BigInt(queryId), 64)
    .storeUint(BigInt(rootQueryId), 64).storeCoins(BigInt(amountRaw)).storeAddress(recipient)
    .storeRef(beginCell().storeAddress(destination).storeUint(requestHash, 256)
      .storeCoins(controlBudget).storeRef(receipt).storeRef(fundingEncoded)).endCell();
  if (!cell.equals(encoded) || status > 5 ||
    (status !== 0 && (!recipient || !destination || queryId === '0' || rootQueryId === '0' || amountRaw === '0')))
    throw Error('Noncanonical current T3 mint journal');
  return { status, queryId, rootQueryId, amountRaw, recipient: recipient?.toRawString() ?? null,
    owner: destination?.toRawString() ?? null, requestHash, controlBudget, receipt, funding, cell };
}
export type T3MintJournal = ReturnType<typeof readT3MintJournal>;
export function sameT3MintTerms(a: T3MintJournal, b: T3MintJournal) {
  return a.queryId === b.queryId && a.amountRaw === b.amountRaw && a.recipient === b.recipient &&
    a.owner === b.owner && a.receipt.equals(b.receipt) &&
    a.funding.refundTo === b.funding.refundTo && a.funding.refundKind === b.funding.refundKind &&
    a.funding.moduleId === b.funding.moduleId;
}

/** Current failedMints is mandatory, even when empty. No obsolete lane reader. */
export function readT3MintState(boc: string) {
  const state = t3State(boc), payload = Cell.fromBase64(boc).refs[0],
    bounce = payload.refs[3].beginParse();
  bounce.loadMaybeAddress(); bounce.skip(64); bounce.loadCoins(); bounce.skip(64);
  const laneCell = bounce.loadRef(), lane = laneCell.beginParse();
  bounce.loadRef();
  const referral = bounce.loadRef().beginParse(); end(bounce);
  referral.skip(32); referral.loadCoins(); referral.skip(64 * 3);
  referral.loadRef(); referral.loadRef();
  const completed = referral.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
  end(referral);
  const nextRootQueryId = lane.loadUintBig(64), nextVaultQueryId = lane.loadUintBig(64),
    activePayoutSet = lane.loadUint(8), activePayoutId = lane.loadUintBig(64),
    live = readT3MintJournal(lane.loadRef()),
    failedCells = lane.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
  end(lane);
  const encoded = beginCell().storeUint(nextRootQueryId, 64).storeUint(nextVaultQueryId, 64)
    .storeUint(activePayoutSet, 8).storeUint(activePayoutId, 64)
    .storeRef(live.cell).storeDict(failedCells).endCell();
  if (!laneCell.equals(encoded) || nextRootQueryId === 0n || nextVaultQueryId === 0n || activePayoutSet > 1 ||
    (live.status !== 0 && BigInt(live.rootQueryId) >= nextRootQueryId))
    throw Error('Noncanonical current T3 mint lane');
  const failed = new Map<bigint, T3MintJournal>();
  for (const [key, cell] of failedCells) {
    const journal = readT3MintJournal(cell);
    if (journal.status !== 2 || journal.controlBudget !== 0n || !journal.owner ||
      key !== t3MintKey(journal.owner, journal.queryId) || BigInt(journal.rootQueryId) >= nextRootQueryId)
      throw Error('Invalid retained T3 mint liability');
    failed.set(key, journal);
  }
  return { ...state, nextRootQueryId, nextVaultQueryId, activePayoutSet, activePayoutId, live, failed, completed };
}

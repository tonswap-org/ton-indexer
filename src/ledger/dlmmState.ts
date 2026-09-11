import { Address, Cell, Dictionary, beginCell, type Slice, type DictionaryKeyTypes, type DictionaryKey, type DictionaryValue } from '@ton/core';

export const DLMM_SETTLEMENT_START = 0x4453000000000001n;
const end = (slice: Slice) => { if (slice.remainingBits || slice.remainingRefs) throw new Error('dlmm_state_trailing_data'); };
const hash = (value: bigint) => value.toString(16).padStart(64, '0');
const address = (slice: Slice) => slice.loadAddress().toRawString();
const completeCell = (cell: Cell, visited = new Set<string>()) => {
  if (cell.isExotic) throw new Error('dlmm_state_exotic_or_pruned');
  const id = cell.hash().toString('hex'); if (visited.has(id)) return; visited.add(id);
  for (const child of cell.refs) completeCell(child, visited);
};
const dict = <K extends DictionaryKeyTypes, V>(cell: Cell, key: DictionaryKey<K>, value: DictionaryValue<V>) => {
  const slice = cell.beginParse(), result = slice.loadDict(key, value); end(slice); return result;
};

export interface DlmmSettlementRecord {
  settlementId: string; requestHash: string; businessQueryId: string;
  predecessorId: string; successorId: string; recordedAt: number;
  kind: number; tokenSide: 0 | 1; status: number;
  amountRaw: string; forwardTonAmountRaw: string; fundedRaw: string;
  sourceWallet: string; destinationOwner: string; destinationWallet: string;
  forwardPayload: Cell; recordHash: string;
}

/** Current DSR1 encoding emitted by the deployment-qualified pool code. */
export function readDlmmSettlementRecord(cell: Cell): DlmmSettlementRecord {
  const s = cell.beginParse();
  if (s.remainingBits !== 632 || s.remainingRefs !== 3 || s.loadUint(32) !== 0x44535231) throw new Error('dlmm_settlement_layout_invalid');
  const settlementId = s.loadUintBig(64), requestHash = hash(s.loadUintBig(256)), businessQueryId = s.loadUintBig(64).toString();
  const predecessorId = s.loadUintBig(64).toString(), successorId = s.loadUintBig(64).toString(), recordedAt = s.loadIntBig(64);
  const kind = s.loadUint(8), side = s.loadUint(8), status = s.loadUint(8);
  if (settlementId < DLMM_SETTLEMENT_START || kind < 1 || kind > 8 || side > 1 || status < 1 || status > 5 || recordedAt < 0n || recordedAt > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('dlmm_settlement_fields_invalid');
  const amounts = s.loadRef().beginParse(), actors = s.loadRef().beginParse(), forwardPayload = s.loadRef();
  const amountRaw = amounts.loadCoins().toString(), forwardTonAmountRaw = amounts.loadCoins().toString(), fundedRaw = amounts.loadCoins().toString();
  const sourceWallet = address(actors), destinationOwner = address(actors), destinationWallet = address(actors);
  for (const part of [s, amounts, actors]) end(part);
  if (amountRaw === '0') throw new Error('dlmm_settlement_amount_invalid');
  return { settlementId: settlementId.toString(), requestHash, businessQueryId, predecessorId, successorId, recordedAt: Number(recordedAt),
    kind, tokenSide: side as 0 | 1, status, amountRaw, forwardTonAmountRaw, fundedRaw,
    sourceWallet, destinationOwner, destinationWallet, forwardPayload, recordHash: cell.hash().toString('hex') };
}

/** Read the single current store_state layout. Code and transaction-boundary
 * qualification belong to the caller; parsing alone is not historical proof. */
export function readDlmmMarketState(boc: string) {
  const cell = Cell.fromBase64(boc); completeCell(cell); const root = cell.beginParse();
  const tokenT = address(root), tokenX = address(root), treasury = root.loadMaybeAddress()?.toRawString() ?? null;
  const poolKind = root.loadUint(8), binSpacing = root.loadInt(32), activeBinId = root.loadInt(32), feePips = root.loadUint(32), impactCapBps = root.loadUint(16);
  if (tokenT === tokenX || root.remainingRefs !== 4) throw new Error('dlmm_pool_layout_invalid');
  const bins = root.loadRef(), observations = root.loadRef(), guard = root.loadRef(), meta = root.loadRef().beginParse(); end(root);
  if (bins.bits.length !== 512 || bins.refs.length !== 1 || observations.bits.length !== 112 || observations.refs.length !== 1 || guard.bits.length !== 416 || guard.refs.length)
    throw new Error('dlmm_pool_structures_invalid');
  const governance = meta.loadMaybeAddress()?.toRawString() ?? null, controlSeqno = meta.loadUintBig(64).toString(), lastUpdate = meta.loadUintBig(64).toString();
  const feeClaimedT = meta.loadUintBig(128).toString(), feeClaimedX = meta.loadUintBig(128).toString();
  if (meta.remainingRefs !== 4) throw new Error('dlmm_pool_metadata_invalid');
  const walletCode = meta.loadRef(), positions = meta.loadRef().beginParse(), accrual = meta.loadRef(), provenance = meta.loadRef(); end(meta);
  if (positions.remainingBits || positions.remainingRefs !== 4 || accrual.bits.length !== 8 || accrual.refs.length !== 4 || accrual.beginParse().loadUint(8) !== 0xac)
    throw new Error('dlmm_pool_positions_invalid');
  const positionsHash = positions.loadRef().hash().toString('hex'), pendingHash = positions.loadRef().hash().toString('hex'), withdrawalsCell = positions.loadRef(), withdrawalsHash = withdrawalsCell.hash().toString('hex');
  const withdrawalSlice = withdrawalsCell.beginParse(); withdrawalSlice.loadUintBig(64);
  const withdrawals = withdrawalSlice.loadDict(Dictionary.Keys.BigUint(64), Dictionary.Values.Cell()); end(withdrawalSlice);
  const withdrawalIds = new Set([...withdrawals.keys()].map(id => id.toString()));
  const journal = positions.loadRef().beginParse(); end(positions);
  if (journal.remainingRefs !== 4 || journal.loadUint(32) !== 0x44534a31) throw new Error('dlmm_journal_layout_invalid');
  const nextSettlementId = journal.loadUintBig(64), reservedT = journal.loadCoins().toString(), reservedX = journal.loadCoins().toString(), reservedNative = journal.loadCoins().toString();
  if (nextSettlementId < DLMM_SETTLEMENT_START) throw new Error('dlmm_journal_sequence_invalid');
  const records = dict(journal.loadRef(), Dictionary.Keys.BigUint(64), Dictionary.Values.Cell());
  const lanes = dict(journal.loadRef(), Dictionary.Keys.BigUint(256), Dictionary.Values.BigUint(64));
  const queues = dict(journal.loadRef(), Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
  const farmingCell = journal.loadRef(); end(journal);
  let nextCampaignId = 1n, farmEscrowT = 0n, farmEscrowX = 0n;
  if (farmingCell.bits.length || farmingCell.refs.length) {
    const farming = farmingCell.beginParse();
    if (farming.remainingRefs !== 4 || farming.loadUint(32) !== 0x44465331) throw new Error('dlmm_farming_layout_invalid');
    nextCampaignId = farming.loadUintBig(64); farmEscrowT = farming.loadCoins(); farmEscrowX = farming.loadCoins();
    const campaigns = dict(farming.loadRef(), Dictionary.Keys.BigUint(64), Dictionary.Values.Cell());
    dict(farming.loadRef(), Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    dict(farming.loadRef(), Dictionary.Keys.BigUint(256), Dictionary.Values.BigUint(256));
    dict(farming.loadRef(), Dictionary.Keys.BigUint(256), Dictionary.Values.Cell()); end(farming);
    if (nextCampaignId < 1n || [...campaigns.keys()].some(id => id < 1n || id >= nextCampaignId)) throw new Error('dlmm_farming_sequence_invalid');
  }
  const settlements = new Map<string, DlmmSettlementRecord>();
  for (const [key, value] of records) {
    const record = readDlmmSettlementRecord(value);
    if (record.settlementId !== key.toString() || key >= nextSettlementId) throw new Error('dlmm_journal_identity_invalid');
    settlements.set(record.settlementId, record);
  }
  const queuedIds = new Set<string>();
  for (const [queueKey, cell] of queues) {
    const queue = cell.beginParse();
    if (queue.remainingBits !== 128 || queue.remainingRefs) throw new Error('dlmm_queue_layout_invalid');
    const head = queue.loadUintBig(64).toString(), tail = queue.loadUintBig(64).toString();
    let current = head, last = '';
    while (current !== '0') {
      const record = settlements.get(current);
      if (!record || queuedIds.has(current) || record.status === 5 ||
        BigInt('0x' + beginCell().storeAddress(Address.parse(record.sourceWallet)).endCell().hash().toString('hex')) !== queueKey ||
        current !== head && record.status !== 1) throw new Error('dlmm_queue_membership_invalid');
      queuedIds.add(current); last = current; current = record.successorId;
    }
    const headRecord = settlements.get(head), lane = lanes.get(queueKey)?.toString();
    if (last !== tail || !headRecord || (headRecord.status === 1 ? lane !== undefined : lane !== head)) throw new Error('dlmm_queue_head_invalid');
  }
  if (queuedIds.size !== settlements.size || [...lanes.keys()].some(key => !queues.has(key))) throw new Error('dlmm_queue_coverage_invalid');
  const provenanceSlice = provenance.beginParse(), provenanceTag = provenanceSlice.loadUint(32);
  if (provenanceTag === 0x444c4450) {
    provenanceSlice.skip(321); address(provenanceSlice); end(provenanceSlice);
  } else if (provenanceTag === 0x444c4253) {
    provenanceSlice.skip(435);
    for (let i = 0; i < 3; i++) {
      const actors = provenanceSlice.loadRef().beginParse();
      actors.loadMaybeAddress(); actors.loadMaybeAddress(); end(actors);
    }
    end(provenanceSlice);
  } else throw new Error('dlmm_provenance_layout_invalid');
  // Both bootstrap and direct-deployment metadata are emitted by current code.
  // Preserve their cells without interpreting registration as verified authority.
  return { tokenT, tokenX, treasury, poolKind, binSpacing, activeBinId, feePips, impactCapBps,
    governance, controlSeqno, lastUpdate, feeClaimedT, feeClaimedX, walletCode, walletCodeHash: walletCode.hash().toString('hex'),
    nextSettlementId: nextSettlementId.toString(), reservedT, reservedX, reservedNative, settlements, lanes, queues,
    farmingHash: farmingCell.hash().toString('hex'), nextCampaignId: nextCampaignId.toString(), farmEscrowT: farmEscrowT.toString(), farmEscrowX: farmEscrowX.toString(),
    binsHash: bins.hash().toString('hex'), observationsHash: observations.hash().toString('hex'), guardHash: guard.hash().toString('hex'),
    positionsHash, pendingHash, withdrawalsHash, withdrawalIds, accrualHash: accrual.hash().toString('hex'), provenanceTag, provenanceHash: provenance.hash().toString('hex'), dataHash: cell.hash().toString('hex') };
}

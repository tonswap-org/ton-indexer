import { Address, Cell, Dictionary, beginCell, type Slice, type DictionaryKeyTypes, type DictionaryKey, type DictionaryValue } from '@ton/core';
import { readDlmmDirectSwaps } from './dlmmDirectSwapState';

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

/** Current DLRF binds a returned token leg to its original notification. A
 * replacement names its negative-finalized predecessor; query IDs alone do not
 * identify contributions. Physical delivery still requires independent proof. */
export function readDlmmLiquidityRefund(cell: Cell) {
  const s = cell.beginParse();
  if (s.remainingBits !== 950 || s.remainingRefs || s.loadUint(32) !== 0x444c5246) throw new Error('dlmm_liquidity_refund_layout_invalid');
  const businessQueryId = s.loadUintBig(64).toString(), notificationHash = hash(s.loadUintBig(256)), predecessorId = s.loadUintBig(64).toString();
  const owner = address(s), tokenRoot = address(s); end(s);
  return { businessQueryId, notificationHash, predecessorId, owner, tokenRoot };
}

/** Current DSR1 encoding emitted by the deployment-qualified pool code. */
export function readDlmmSettlementRecord(cell: Cell): DlmmSettlementRecord {
  const s = cell.beginParse();
  if (s.remainingBits !== 632 || s.remainingRefs !== 3 || s.loadUint(32) !== 0x44535231) throw new Error('dlmm_settlement_layout_invalid');
  const settlementId = s.loadUintBig(64), requestHash = hash(s.loadUintBig(256)), businessQueryId = s.loadUintBig(64).toString();
  const predecessorId = s.loadUintBig(64).toString(), successorId = s.loadUintBig(64).toString(), recordedAt = s.loadIntBig(64);
  const kind = s.loadUint(8), side = s.loadUint(8), status = s.loadUint(8);
  if (settlementId < DLMM_SETTLEMENT_START || kind < 1 || kind > 9 || side > 1 || status < 1 || status > 5 || recordedAt < 0n || recordedAt > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('dlmm_settlement_fields_invalid');
  const amounts = s.loadRef().beginParse(), actors = s.loadRef().beginParse(), forwardPayload = s.loadRef();
  const amountRaw = amounts.loadCoins().toString(), forwardTonAmountRaw = amounts.loadCoins().toString(), fundedRaw = amounts.loadCoins().toString();
  const sourceWallet = address(actors), destinationOwner = address(actors), destinationWallet = address(actors);
  for (const part of [s, amounts, actors]) end(part);
  if (amountRaw === '0') throw new Error('dlmm_settlement_amount_invalid');
  if (kind === 3) {
    const refund = readDlmmLiquidityRefund(forwardPayload);
    if (refund.businessQueryId !== businessQueryId || refund.predecessorId !== predecessorId || refund.owner !== destinationOwner)
      throw new Error('dlmm_liquidity_refund_identity_invalid');
  }
  return { settlementId: settlementId.toString(), requestHash, businessQueryId, predecessorId, successorId, recordedAt: Number(recordedAt),
    kind, tokenSide: side as 0 | 1, status, amountRaw, forwardTonAmountRaw, fundedRaw,
    sourceWallet, destinationOwner, destinationWallet, forwardPayload, recordHash: cell.hash().toString('hex') };
}

/** Read exact current constructor and store_state forms. These are selected by
 * their explicit journal shape, never by catching a failed layout parser. Code
 * and transaction-boundary qualification belong to the caller. */
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
  if (meta.remainingRefs !== 3 && meta.remainingRefs !== 4) throw new Error('dlmm_pool_metadata_invalid');
  const walletCode = meta.loadRef(), positions = meta.loadRef().beginParse(), accrual = meta.loadRef(), provenance = meta.remainingRefs ? meta.loadRef() : null; end(meta);
  if (positions.remainingBits || positions.remainingRefs !== 4 || accrual.bits.length !== 8 || accrual.refs.length !== 4 || accrual.beginParse().loadUint(8) !== 0xac)
    throw new Error('dlmm_pool_positions_invalid');
  const positionCell = positions.loadRef(), pendingCell = positions.loadRef(), withdrawalsCell = positions.loadRef(), journalCell = positions.loadRef(); end(positions);
  const positionsHash = positionCell.hash().toString('hex'), pendingHash = pendingCell.hash().toString('hex'), withdrawalsHash = withdrawalsCell.hash().toString('hex');
  const empty = (c: Cell) => c.bits.length === 0 && c.refs.length === 0;
  const storageForm: 'constructor' | 'persisted' = empty(journalCell) ? 'constructor' : 'persisted';
  let nextSettlementId = DLMM_SETTLEMENT_START, reservedT = '0', reservedX = '0', reservedNative = '0';
  let withdrawals = Dictionary.empty(Dictionary.Keys.BigUint(64), Dictionary.Values.Cell());
  let records = Dictionary.empty(Dictionary.Keys.BigUint(64), Dictionary.Values.Cell());
  let lanes = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.BigUint(64));
  let queues = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
  let farmingCell = beginCell().endCell(), routerOperations = beginCell().endCell(), directSwapsCell = beginCell().storeDict(null).storeDict(null).endCell(), stableAmp = 0;
  const ring = observations.refs[0];
  if (storageForm === 'constructor') {
    const bs = bins.beginParse(), os = observations.beginParse();
    const zeroGrowth = bs.loadUintBig(256) === 0n && bs.loadUintBig(256) === 0n;
    const initialObservations = os.loadInt(32) === activeBinId && os.loadUintBig(64) === 0n && os.loadUint(16) === 0;
    if (!zeroGrowth || !initialObservations || !empty(bins.refs[0]) || !empty(positionCell) || !empty(pendingCell) || !empty(withdrawalsCell) ||
      accrual.refs.some(c => !empty(c)) || controlSeqno !== '0' || lastUpdate !== '0' || feeClaimedT !== '0' || feeClaimedX !== '0' ||
      empty(walletCode) || ring.bits.length || ring.refs.length !== 3)
      throw new Error('dlmm_constructor_state_invalid');
    const constructorDicts = [
      dict(ring.refs[0], Dictionary.Keys.Uint(16), Dictionary.Values.Uint(32)),
      dict(ring.refs[1], Dictionary.Keys.Uint(16), Dictionary.Values.BigUint(64)),
      dict(ring.refs[2], Dictionary.Keys.Uint(16), Dictionary.Values.BigUint(128))
    ];
    if (constructorDicts.some(d => d.size)) throw new Error('dlmm_constructor_observations_invalid');
  } else {
    if (!provenance) throw new Error('dlmm_persisted_provenance_missing');
    if (ring.bits.length || ring.refs.length !== 4) throw new Error('dlmm_observation_ring_invalid');
    const withdrawalSlice = withdrawalsCell.beginParse(); withdrawalSlice.loadUintBig(64);
    withdrawals = withdrawalSlice.loadDict(Dictionary.Keys.BigUint(64), Dictionary.Values.Cell()); end(withdrawalSlice);
    const journal = journalCell.beginParse();
    if (journal.remainingRefs !== 4 || journal.loadUint(32) !== 0x44534a31) throw new Error('dlmm_journal_layout_invalid');
    nextSettlementId = journal.loadUintBig(64); reservedT = journal.loadCoins().toString(); reservedX = journal.loadCoins().toString(); reservedNative = journal.loadCoins().toString();
    if (nextSettlementId < DLMM_SETTLEMENT_START) throw new Error('dlmm_journal_sequence_invalid');
    records = dict(journal.loadRef(), Dictionary.Keys.BigUint(64), Dictionary.Values.Cell());
    lanes = dict(journal.loadRef(), Dictionary.Keys.BigUint(256), Dictionary.Values.BigUint(64));
    queues = dict(journal.loadRef(), Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    const products = journal.loadRef().beginParse(); end(journal);
    if (products.remainingBits !== 16 || products.remainingRefs !== 3) throw new Error('dlmm_products_layout_invalid');
    stableAmp = products.loadUint(16); farmingCell = products.loadRef(); routerOperations = products.loadRef(); directSwapsCell = products.loadRef(); end(products);
    if (poolKind === 2 ? stableAmp === 0 || activeBinId !== 0 || binSpacing !== 1 : stableAmp !== 0) throw new Error('dlmm_stable_configuration_invalid');
    if (!empty(routerOperations)) dict(routerOperations, Dictionary.Keys.BigUint(64), Dictionary.Values.Cell());
  }
  const withdrawalIds = new Set([...withdrawals.keys()].map(id => id.toString()));
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
    if (record.kind === 3 && readDlmmLiquidityRefund(record.forwardPayload).tokenRoot !== (record.tokenSide === 0 ? tokenT : tokenX))
      throw new Error('dlmm_liquidity_refund_root_invalid');
    settlements.set(record.settlementId, record);
  }
  const queuedIds = new Set<string>();
  const directSwaps = readDlmmDirectSwaps(directSwapsCell, nextSettlementId, settlements);
  const requiredFunding = (record: DlmmSettlementRecord) =>
    (record.forwardTonAmountRaw !== '0' || record.forwardPayload.bits.length || record.forwardPayload.refs.length ? 160000000n : 140000000n) +
    BigInt(record.forwardTonAmountRaw) + 40000000n;
  for (const [queueKey, cell] of queues) {
    const queue = cell.beginParse();
    if (queue.remainingBits !== 128 || queue.remainingRefs) throw new Error('dlmm_queue_layout_invalid');
    const head = queue.loadUintBig(64).toString(), tail = queue.loadUintBig(64).toString();
    let current = head, last = '';
    while (current !== '0') {
      const record = settlements.get(current);
      if (!record || queuedIds.has(current) || record.status === 5 ||
        BigInt('0x' + beginCell().storeAddress(Address.parse(record.sourceWallet)).endCell().hash().toString('hex')) !== queueKey ||
        current !== head && record.status !== 1 || record.status === 1 && BigInt(record.fundedRaw) !== requiredFunding(record))
        throw new Error('dlmm_queue_membership_invalid');
      queuedIds.add(current); last = current; current = record.successorId;
    }
    const headRecord = settlements.get(head), lane = lanes.get(queueKey)?.toString();
    if (last !== tail || !headRecord || (headRecord.status === 1 ? lane !== undefined : lane !== head)) throw new Error('dlmm_queue_head_invalid');
  }
  // Funding admission owns queue membership. A bounced READY wire may retain
  // full funding outside the queue until an explicit retry; it has no lane or
  // successor and cannot block independently funded work.
  if ([...settlements.values()].some(record => !queuedIds.has(record.settlementId) &&
    (record.status !== 1 || record.successorId !== '0' || BigInt(record.fundedRaw) > requiredFunding(record))) ||
    [...lanes.keys()].some(key => !queues.has(key))) throw new Error('dlmm_queue_coverage_invalid');
  let provenanceTag: number | null = null, provenanceIsDefault = provenance === null, router: string | null = null;
  if (provenance) {
    const provenanceSlice = provenance.beginParse(); provenanceTag = provenanceSlice.loadUint(32);
    if (provenanceTag === 0x444c4450) {
      provenanceSlice.skip(321); address(provenanceSlice);
      if (provenanceSlice.remainingRefs !== 1) throw new Error('dlmm_direct_router_layout_invalid');
      const routing = provenanceSlice.loadRef().beginParse(); router = routing.loadMaybeAddress()?.toRawString() ?? null; end(routing); end(provenanceSlice);
    } else if (provenanceTag === 0x444c4253) {
      provenanceIsDefault = provenanceSlice.loadUintBig(435) === 0n;
      for (let i = 0; i < 3; i++) {
        const actors = provenanceSlice.loadRef().beginParse();
        const first = actors.loadMaybeAddress(), second = actors.loadMaybeAddress(); end(actors);
        if (i === 0) router = first?.toRawString() ?? null;
        provenanceIsDefault = provenanceIsDefault && first === null && second === null;
      }
      end(provenanceSlice);
    } else throw new Error('dlmm_provenance_layout_invalid');
  }
  // Both bootstrap and direct-deployment metadata are emitted by current code.
  // Preserve their cells without interpreting registration as verified authority.
  return { storageForm, tokenT, tokenX, treasury, router, stableAmp, routerOperationsHash: routerOperations.hash().toString('hex'), directSwaps, poolKind, binSpacing, activeBinId, feePips, impactCapBps,
    governance, controlSeqno, lastUpdate, feeClaimedT, feeClaimedX, walletCode, walletCodeHash: walletCode.hash().toString('hex'),
    nextSettlementId: nextSettlementId.toString(), reservedT, reservedX, reservedNative, settlements, lanes, queues,
    farmingHash: farmingCell.hash().toString('hex'), nextCampaignId: nextCampaignId.toString(), farmEscrowT: farmEscrowT.toString(), farmEscrowX: farmEscrowX.toString(),
    binsHash: bins.hash().toString('hex'), observationsHash: observations.hash().toString('hex'), guardHash: guard.hash().toString('hex'),
    positionsHash, pendingHash, withdrawalsHash, withdrawalIds, accrualHash: accrual.hash().toString('hex'), provenanceTag, provenanceHash: provenance?.hash().toString('hex') ?? null, provenanceIsDefault, dataHash: cell.hash().toString('hex') };
}

import { Cell, beginCell } from '@ton/core';
import type { Network } from '../models';
import type { Flow, Node, ProjectionInput } from './project';
import type { LedgerEvent, LedgerEvidenceRef } from './types';
import type { LedgerLaunchpadFixedSale, LedgerLaunchpadSale } from './launchpadModels';
import { canonicalLedgerAddress, canonicalLedgerHash } from './normalize';
import { perpsWalletAddress } from './perpsWire';
import { bodyCell, NOTIFY, TRANSFER, tokenWire } from './wire';
import { readT3RecoveryWallet } from './t3RecoveryState';
import { readFixedSaleState, type FixedSaleContribution } from './launchpadState';
import { readBondingSaleState, type BondingSaleContribution } from './launchpadBondingState';
import { readAuctionSaleState, type AuctionSaleBid } from './launchpadAuctionState';
import { launchpadCommand, fixedSaleSettlementRequestHash } from './launchpadWire';

import { readLaunchpadRequests, type LaunchpadOriginalRequest } from './launchpadRequests';
export type LaunchpadParticipationEntitlement =
  | { model: 'fixed'; before: FixedSaleContribution | null; after: FixedSaleContribution; paymentDeltaRaw: string; tokenDeltaRaw: string; priceRaw: string }
  | { model: 'bonding'; before: BondingSaleContribution | null; after: BondingSaleContribution; paymentDeltaRaw: string; tokenDeltaRaw: string; priceRaw: string }
  | { model: 'auction'; before: AuctionSaleBid | null; after: AuctionSaleBid; commitmentDeltaRaw: string; quantityDeltaRaw: string; maxPriceRaw: string };
export type LaunchpadAcceptanceEvidence = {
  purpose: 'acceptance' | 'payment-debit' | 'payment-credit'; transaction: LedgerEvidenceRef;
  beforeHash: string; afterHash: string; beforeSeqno: number; afterSeqno: number;
  balanceBeforeRaw: string | null; balanceAfterRaw: string | null;
};
export type LaunchpadParticipationMetadata = {
  network: Network; model: LedgerLaunchpadSale['model']; requestKind: 'contribution' | 'bid';
  sale: string; factory: string | null; saleId: string | null; participant: string;
  outerQueryId: string; innerQueryId: string; originalRequest: LaunchpadOriginalRequest;
  payment: { root: string; sourceWallet: string; destinationWallet: string; amountRaw: string; requestBodyHash: string; forwardPayloadHash: string };
  entitlement: LaunchpadParticipationEntitlement | null; stateEvidence: LaunchpadAcceptanceEvidence[];
  tokenDelivery: 'separate-settlement';
};
export type LaunchpadParticipationOperation = {
  anchor: Node; kind: 'launchpad_participation'; queryId: string; confirmed: boolean;
  evidence: LedgerEvidenceRef[]; issue?: string; settlement: NonNullable<LedgerEvent['settlement']>;
};
export type LaunchpadReceiptFor = (node: Node, index: number) => Node | null;
const address = (value?: string | null) => { try { return value ? canonicalLedgerAddress(value) : null; } catch { return null; } };
const ok = (node: Node) => node.raw.success && (!node.raw.status || node.raw.status === 'success') && !node.raw.inMessage?.bounced;
export const launchpadEvidenceRef = (node: Node): LedgerEvidenceRef => ({ account: node.account, lt: node.raw.lt, hash: canonicalLedgerHash(node.raw.hash), utime: node.raw.utime });
const unique = (nodes: Node[]) => [...new Map(nodes.map(node => [node.id, node])).values()];
const one = <T>(items: T[]) => items.length === 1 ? items[0] : null;
const requireEvidence: (condition: unknown, issue: string) => asserts condition = (condition, issue) => { if (!condition) throw Error(issue); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const except = (object: object, fields: string[]) => Object.fromEntries(Object.entries(object).filter(([key]) => !fields.includes(key)));
const sameOtherEntries = <T>(before: Map<string, T>, after: Map<string, T>, changed: string) =>
  [...before].every(([key, value]) => key === changed || same(value, after.get(key))) && [...after.keys()].every(key => key === changed || before.has(key));
type Identity = {
  dataHash: string; saleId: string; registry: { factory: string | null }; paymentRouting: { tokenRoot: string; wallet: string; walletCodeHash: string };
};
async function archiveBoundary(input: ProjectionInput, node: Node, codeHash: string) {
  requireEvidence(ok(node) && node.raw.prevTransactionLt && node.raw.prevTransactionHash && node.raw.prevTransactionLt !== '0', 'launchpad_state_unavailable');
  const before = await input.stateAt(node.account, node.raw.prevTransactionLt, node.raw.prevTransactionHash), after = await input.stateAt(node.account, node.raw.lt, node.raw.hash);
  for (const [snapshot, lt, hash] of [[before, node.raw.prevTransactionLt, node.raw.prevTransactionHash], [after, node.raw.lt, node.raw.hash]] as const)
    requireEvidence(snapshot?.state.dataBoc && snapshot.state.codeBoc && snapshot.state.accountState === 'active' && snapshot.state.lastTxLt === lt &&
      snapshot.state.lastTxHash && canonicalLedgerHash(snapshot.state.lastTxHash) === canonicalLedgerHash(hash) &&
      Number.isSafeInteger(snapshot.seqno) && snapshot.seqno >= 0 && Cell.fromBase64(snapshot.state.codeBoc).hash().toString('hex') === codeHash,
      'launchpad_state_or_code_unverified');
  requireEvidence(before!.seqno <= after!.seqno, 'launchpad_archive_order_unverified');
  return { before: before!, after: after! };
}
export async function readLaunchpadBoundary<T extends Identity>(input: ProjectionInput, node: Node, sale: LedgerLaunchpadSale, parse: (boc: string) => T) {
  requireEvidence(node.account === sale.address, 'launchpad_sale_identity_unverified');
  const snapshots = await archiveBoundary(input, node, sale.saleCodeHash), before = parse(snapshots.before.state.dataBoc!), after = parse(snapshots.after.state.dataBoc!);
  for (const state of [before, after]) requireEvidence(state.registry.factory === sale.factory && state.paymentRouting.tokenRoot === sale.paymentRoot &&
    state.paymentRouting.wallet === sale.paymentWallet && state.paymentRouting.walletCodeHash === sale.paymentWalletCode.hash().toString('hex') &&
    perpsWalletAddress(sale.paymentWalletCode, sale.paymentRoot, sale.address) === sale.paymentWallet, 'launchpad_historical_identity_unverified');
  requireEvidence(['saleId', 'deploymentSalt', 't3Root', 't3WalletCodeHash', 'registry', 'paymentRouting', 'saleRouting', 'config']
    .every(key => same((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key])), 'launchpad_configuration_changed_during_acceptance');
  return { before, after, evidence: { transaction: launchpadEvidenceRef(node), beforeHash: before.dataHash, afterHash: after.dataHash,
    beforeSeqno: snapshots.before.seqno, afterSeqno: snapshots.after.seqno } };
}
export const readFixedLaunchpadBoundary = (input: ProjectionInput, node: Node, sale: LedgerLaunchpadFixedSale) => readLaunchpadBoundary(input, node, sale, readFixedSaleState);
export async function qualifyLaunchpadWallet(input: ProjectionInput, node: Node, sale: LedgerLaunchpadSale, expectedOwner: string) {
  const snapshot = await input.stateAt(node.account, node.raw.lt, node.raw.hash), asset = input.wallets.get(node.account);
  requireEvidence(asset?.owner === expectedOwner && asset.master === sale.paymentRoot && perpsWalletAddress(sale.paymentWalletCode, sale.paymentRoot, expectedOwner) === node.account &&
    snapshot?.state.accountState === 'active' && snapshot.state.codeBoc && snapshot.state.dataBoc && snapshot.state.lastTxLt === node.raw.lt && snapshot.state.lastTxHash &&
    Number.isSafeInteger(snapshot.seqno) && snapshot.seqno >= 0 && canonicalLedgerHash(snapshot.state.lastTxHash) === canonicalLedgerHash(node.raw.hash) &&
    Cell.fromBase64(snapshot.state.codeBoc).hash().toString('hex') === sale.paymentWalletCode.hash().toString('hex'), 'launchpad_wallet_identity_or_code_unverified');
  const state = readT3RecoveryWallet(snapshot.state.dataBoc);
  requireEvidence(state.owner === expectedOwner && state.root === sale.paymentRoot, 'launchpad_wallet_data_identity_unverified');
  return { snapshot, state };
}
async function walletBalanceBoundary(input: ProjectionInput, node: Node, sale: LedgerLaunchpadSale, owner: string, delta: bigint, purpose: 'payment-debit' | 'payment-credit'): Promise<LaunchpadAcceptanceEvidence> {
  await qualifyLaunchpadWallet(input, node, sale, owner);
  const snapshots = await archiveBoundary(input, node, sale.paymentWalletCode.hash().toString('hex'));
  const before = readT3RecoveryWallet(snapshots.before.state.dataBoc!), after = readT3RecoveryWallet(snapshots.after.state.dataBoc!);
  requireEvidence(before.owner === owner && after.owner === owner && before.root === sale.paymentRoot && after.root === sale.paymentRoot &&
    BigInt(after.balanceRaw) - BigInt(before.balanceRaw) === delta, 'launchpad_payment_balance_delta_unverified');
  return { purpose, transaction: launchpadEvidenceRef(node), beforeHash: before.dataHash, afterHash: after.dataHash,
    beforeSeqno: snapshots.before.seqno, afterSeqno: snapshots.after.seqno, balanceBeforeRaw: before.balanceRaw, balanceAfterRaw: after.balanceRaw };
}
function initiatingRequest(input: ProjectionInput, nodes: Node[], flow: Flow, receiptFor: LaunchpadReceiptFor) {
  const match = one(nodes.flatMap(node => node.account === input.owner && node.event && ok(node) ? node.raw.outMessages.flatMap((message, messageIndex) =>
    receiptFor(node, messageIndex)?.id === flow.source.id && address(message.source) === input.owner && address(message.destination) === flow.source.account && !message.bounced
      ? [{ node, messageIndex }] : []) : []));
  requireEvidence(match, 'launchpad_original_owner_request_unverified');
  const identity = one(readLaunchpadRequests(input, match.node).filter(request => request.originalRequest.messageIndex === match.messageIndex &&
    request.sourceWallet === flow.source.account && request.sale === flow.recipientAsset.owner && request.outerQueryId === flow.wire.queryId));
  requireEvidence(identity, 'launchpad_original_owner_request_unverified');
  return { anchor: match.node, originalRequest: identity.originalRequest };
}
function exactNotification(input: ProjectionInput, flow: Flow, sale: LedgerLaunchpadSale, receiptFor: LaunchpadReceiptFor) {
  const match = one(flow.recipient.raw.outMessages.flatMap((message, index) => {
    const wire = tokenWire(message), node = receiptFor(flow.recipient, index);
    return address(message.source) === sale.paymentWallet && address(message.destination) === sale.address && !message.bounced &&
      node?.account === sale.address && ok(node) && wire?.op === NOTIFY && wire.queryId === flow.wire.queryId && wire.amountRaw === flow.wire.amountRaw &&
      wire.owner === input.owner && wire.senderWallet === flow.source.account && wire.forward.hash().equals(flow.wire.forward.hash()) && BigInt(node.raw.lt) > BigInt(flow.recipient.raw.lt)
      ? [node] : [];
  }));
  requireEvidence(match, 'launchpad_acceptance_notification_unverified'); return match;
}
function beneficiaryChanges(before: { claimed: boolean; rewardWallet: string | null; refundWallet: string | null } | null, after: { claimed: boolean; rewardWallet: string | null; refundWallet: string | null }, owner: string, reward: string | null, refund: string | null) {
  requireEvidence(!before?.claimed && !after.claimed && after.rewardWallet === (reward ?? owner) && after.refundWallet === (refund ?? owner) &&
    (!before?.rewardWallet || before.rewardWallet === after.rewardWallet) && (!before?.refundWallet || before.refundWallet === after.refundWallet), 'launchpad_participant_beneficiary_unverified');
}
type FeeRecord = { settlementId:string; amountRaw:string; route:number; kind:number; recipientOwner:string; sourceWallet:string; destinationWallet:string;
  forwardTonAmountRaw:string; forwardPayloadBoc:string; forwardPayloadHash:string; requestHash:string; predecessorId:string; status:number; deliveryReservedRaw:string; finalizeReservedRaw:string; tokenRoot?:string };
type FeeState = { metrics:{feeBps:number;feeRecipient:string|null}; journal:{entries:Map<string,FeeRecord>;nextSettlementId:string;currentPaymentId:string;currentSaleId:string;
  tailPaymentId:string;tailSaleId:string;reservedPaymentRaw:string;reservedSaleRaw:string} };
function feeJournal(before:FeeState,after:FeeState,sale:LedgerLaunchpadSale,amount:bigint) {
  const fee=amount*BigInt(before.metrics.feeBps)/10000n,b=before.journal,a=after.journal;
  if(fee===0n){requireEvidence(same(except(b,['entries']),except(a,['entries']))&&same([...b.entries],[...a.entries]),'launchpad_zero_fee_journal_changed');return;}
  const added=[...a.entries.values()].filter(entry=>!b.entries.has(entry.settlementId)),record=one(added),recipient=before.metrics.feeRecipient;
  const payload=sale.model==='auction'?Cell.EMPTY:beginCell().storeUint(0x4c504645,32).endCell();
  requireEvidence(record&&recipient&&record.settlementId===b.nextSettlementId&&record.amountRaw===fee.toString()&&record.route===1&&record.kind===1&&
    record.recipientOwner===recipient&&record.sourceWallet===sale.paymentWallet&&record.destinationWallet===perpsWalletAddress(sale.paymentWalletCode,sale.paymentRoot,recipient)&&
    (sale.model==='fixed'?record.tokenRoot===undefined:record.tokenRoot===sale.paymentRoot)&&record.forwardTonAmountRaw==='0'&&record.forwardPayloadHash===payload.hash().toString('hex')&&
    record.requestHash===fixedSaleSettlementRequestHash(sale.address,record)&&record.predecessorId===b.tailPaymentId&&
    a.entries.size===b.entries.size+1&&[...b.entries].every(([id,value])=>same(value,a.entries.get(id)))&&
    BigInt(a.nextSettlementId)===BigInt(b.nextSettlementId)+1n&&a.tailPaymentId===record.settlementId&&a.currentSaleId===b.currentSaleId&&a.tailSaleId===b.tailSaleId&&
    a.reservedSaleRaw===b.reservedSaleRaw&&BigInt(a.reservedPaymentRaw)-BigInt(b.reservedPaymentRaw)===fee,'launchpad_contribution_fee_liability_unverified');
  const start=sale.model==='auction'?'140000000':'160000000';
  requireEvidence(record.status===2 ? b.tailPaymentId==='0'&&b.currentPaymentId==='0'&&a.currentPaymentId===record.settlementId&&record.deliveryReservedRaw==='0'&&record.finalizeReservedRaw==='40000000'
    : record.status===1&&a.currentPaymentId===b.currentPaymentId&&((record.deliveryReservedRaw==='0'&&record.finalizeReservedRaw==='0')||(record.deliveryReservedRaw===start&&record.finalizeReservedRaw==='40000000')),
    'launchpad_contribution_fee_lane_unverified');
}
function appendedFill(before:{fillsHash:string;fills:{hash:string}[]}|null,after:{fills:{tokenAmountRaw:string;paymentAmountRaw:string;hash:string;previousHash:string|null}[]},tokens:bigint,amount:bigint) {
  const head=after.fills[0],old=before?.fills??[];
  requireEvidence(head&&head.tokenAmountRaw===tokens.toString()&&head.paymentAmountRaw===amount.toString()&&
    head.previousHash===(old.length?before!.fillsHash:null)&&after.fills.length===old.length+1&&after.fills.slice(1).every((entry,index)=>same(entry,old[index])),
    'launchpad_participant_fill_chain_unverified');
}
function fixedEntitlement(boundary: Awaited<ReturnType<typeof readFixedLaunchpadBoundary>>, sale:LedgerLaunchpadFixedSale, owner: string, amount: bigint, command: Extract<NonNullable<ReturnType<typeof launchpadCommand>>, {kind:'contribute'}>): LaunchpadParticipationEntitlement {
  const b = boundary.before, a = boundary.after, before = b.contributions.get(owner) ?? null, after = a.contributions.get(owner), price = BigInt(b.config.priceRaw);
  requireEvidence(after && !b.metrics.finalized && !a.metrics.finalized && price > 0n && amount > 0n && amount % price === 0n, 'launchpad_contribution_entitlement_unverified');
  const tokens = amount / price;
  beneficiaryChanges(before, after, owner, command.rewardWallet, command.refundWallet);
  requireEvidence(BigInt(after.paymentAmountRaw) - BigInt(before?.paymentAmountRaw ?? '0') === amount &&
    BigInt(after.tokenAmountRaw) - BigInt(before?.tokenAmountRaw ?? '0') === tokens && sameOtherEntries(b.contributions, a.contributions, owner) &&
    BigInt(a.metrics.totalRaisedRaw) - BigInt(b.metrics.totalRaisedRaw) === amount && BigInt(a.metrics.outstandingRaisedRaw) - BigInt(b.metrics.outstandingRaisedRaw) === amount &&
    BigInt(a.metrics.totalSoldRaw) - BigInt(b.metrics.totalSoldRaw) === tokens && BigInt(a.metrics.totalFeesRaw) - BigInt(b.metrics.totalFeesRaw) === amount * BigInt(b.metrics.feeBps) / 10000n &&
    same(except(b.metrics, ['totalRaisedRaw','outstandingRaisedRaw','totalSoldRaw','totalFeesRaw']), except(a.metrics, ['totalRaisedRaw','outstandingRaisedRaw','totalSoldRaw','totalFeesRaw'])), 'launchpad_contribution_delta_unverified');
  feeJournal(b,a,sale,amount);
  return {model:'fixed',before,after,paymentDeltaRaw:amount.toString(),tokenDeltaRaw:tokens.toString(),priceRaw:price.toString()};
}

function bondingEntitlement(boundary:Awaited<ReturnType<typeof readBondingBoundary>>,sale:Extract<LedgerLaunchpadSale,{model:'bonding'}>,owner:string,amount:bigint,command:Extract<NonNullable<ReturnType<typeof launchpadCommand>>,{kind:'contribute'}>):LaunchpadParticipationEntitlement {
  const b=boundary.before,a=boundary.after,before=b.contributions.get(owner)??null,after=a.contributions.get(owner),price=BigInt(b.metrics.currentPriceRaw);
  requireEvidence(after&&!b.metrics.finalized&&!a.metrics.finalized&&price>0n&&amount>0n&&amount%price===0n,'launchpad_bonding_entitlement_unverified');
  const tokens=amount/price,denominator=BigInt(b.config.slopeDenominatorRaw),numerator=BigInt(b.config.slopeNumeratorRaw),sold=BigInt(a.metrics.totalSoldRaw);
  requireEvidence(denominator>0n,'launchpad_bonding_price_unverified');
  const nextPrice=BigInt(b.config.basePriceRaw)+numerator*sold/denominator;
  beneficiaryChanges(before,after,owner,command.rewardWallet,command.refundWallet);appendedFill(before,after,tokens,amount);
  requireEvidence(BigInt(after.paymentAmountRaw)-BigInt(before?.paymentAmountRaw??'0')===amount&&BigInt(after.tokenAmountRaw)-BigInt(before?.tokenAmountRaw??'0')===tokens&&sameOtherEntries(b.contributions,a.contributions,owner)&&
    BigInt(a.metrics.totalRaisedRaw)-BigInt(b.metrics.totalRaisedRaw)===amount&&sold-BigInt(b.metrics.totalSoldRaw)===tokens&&
    a.metrics.lastPriceRaw===b.metrics.currentPriceRaw&&a.metrics.currentPriceRaw===nextPrice.toString()&&nextPrice<=9223372036854775807n&&
    BigInt(a.metrics.totalFeesRaw)-BigInt(b.metrics.totalFeesRaw)===amount*BigInt(b.metrics.feeBps)/10000n&&same(b.referral,a.referral)&&
    same(except(b.metrics,['totalRaisedRaw','totalSoldRaw','lastPriceRaw','currentPriceRaw','totalFeesRaw']),except(a.metrics,['totalRaisedRaw','totalSoldRaw','lastPriceRaw','currentPriceRaw','totalFeesRaw'])),
    'launchpad_bonding_delta_unverified');feeJournal(b,a,sale,amount);
  return {model:'bonding',before,after,paymentDeltaRaw:amount.toString(),tokenDeltaRaw:tokens.toString(),priceRaw:price.toString()};
}
function auctionEntitlement(boundary:Awaited<ReturnType<typeof readAuctionBoundary>>,sale:Extract<LedgerLaunchpadSale,{model:'auction'}>,owner:string,amount:bigint,command:Extract<NonNullable<ReturnType<typeof launchpadCommand>>,{kind:'bid'}>,utime:number):LaunchpadParticipationEntitlement {
  const b=boundary.before,a=boundary.after,before=b.bids.get(owner)??null,after=a.bids.get(owner),quantity=BigInt(command.quantityRaw),price=BigInt(command.maxPriceRaw);
  const interval=BigInt(b.config.priceDecayInterval),start=BigInt(b.config.startPriceRaw),reserve=BigInt(b.config.reservePriceRaw),tick=BigInt(b.config.tickSizeRaw),elapsed=BigInt(utime)-BigInt(b.config.startTime);
  requireEvidence(interval>0n&&tick>0n&&start>=reserve&&reserve>0n,'launchpad_auction_price_unverified');
  const decayed=start-(elapsed>0n?elapsed/interval*tick:0n),currentPrice=decayed<reserve?reserve:decayed;
  requireEvidence(after&&!b.metrics.finalized&&!a.metrics.finalized&&amount>0n&&quantity>0n&&price>=currentPrice&&price*quantity===amount&&(!before||before.maxPriceRaw===command.maxPriceRaw),'launchpad_bid_entitlement_unverified');
  beneficiaryChanges(before,after,owner,command.rewardWallet,command.refundWallet);appendedFill(before,after,quantity,amount);
  requireEvidence(after.maxPriceRaw===command.maxPriceRaw&&BigInt(after.commitmentRaw)-BigInt(before?.commitmentRaw??'0')===amount&&
    BigInt(after.quantityRaw)-BigInt(before?.quantityRaw??'0')===quantity&&sameOtherEntries(b.bids,a.bids,owner)&&
    BigInt(a.metrics.totalCommittedRaw)-BigInt(b.metrics.totalCommittedRaw)===amount&&BigInt(a.metrics.totalQuantityRaw)-BigInt(b.metrics.totalQuantityRaw)===quantity&&
    BigInt(a.metrics.totalFeesRaw)-BigInt(b.metrics.totalFeesRaw)===amount*BigInt(b.metrics.feeBps)/10000n&&same(b.referral,a.referral)&&
    b.pendingTransfersHash===a.pendingTransfersHash&&same(b.lastBounce,a.lastBounce)&&
    same(except(b.metrics,['totalCommittedRaw','totalQuantityRaw','totalFeesRaw']),except(a.metrics,['totalCommittedRaw','totalQuantityRaw','totalFeesRaw'])),
    'launchpad_bid_delta_unverified');feeJournal(b,a,sale,amount);
  return {model:'auction',before,after,commitmentDeltaRaw:amount.toString(),quantityDeltaRaw:quantity.toString(),maxPriceRaw:price.toString()};
}
const readBondingBoundary=(input:ProjectionInput,node:Node,sale:LedgerLaunchpadSale)=>readLaunchpadBoundary(input,node,sale,readBondingSaleState);
const readAuctionBoundary=(input:ProjectionInput,node:Node,sale:LedgerLaunchpadSale)=>readLaunchpadBoundary(input,node,sale,readAuctionSaleState);

function participationRequest(input:ProjectionInput,nodes:Node[],flow:Flow,sale:LedgerLaunchpadSale,receiptFor:LaunchpadReceiptFor) {
  requireEvidence(flow.sourceAsset.owner===input.owner&&flow.recipientAsset.owner===sale.address&&flow.sourceAsset.master===sale.paymentRoot&&flow.recipientAsset.master===sale.paymentRoot&&flow.recipient.account===sale.paymentWallet,
    'launchpad_original_payment_identity_unverified');
  const command = launchpadCommand({body:flow.wire.forward.toBoc().toString('base64')}), request = tokenWire(flow.source.raw.inMessage), requestBody = bodyCell(flow.source.raw.inMessage);
  requireEvidence((sale.model === 'auction' ? command?.kind === 'bid' : command?.kind === 'contribute') && request?.op === TRANSFER && requestBody && request.queryId === flow.wire.queryId && request.amountRaw === flow.wire.amountRaw &&
    request.owner === sale.address && request.forward.hash().equals(flow.wire.forward.hash()), 'launchpad_original_payment_request_unverified');
  const original = initiatingRequest(input,nodes,flow,receiptFor);
  const metadata:LaunchpadParticipationMetadata={network:input.network,model:sale.model,requestKind:command!.kind==='bid'?'bid':'contribution',sale:sale.address,factory:sale.factory,saleId:null,participant:input.owner,
    outerQueryId:flow.wire.queryId,innerQueryId:command!.queryId,originalRequest:original.originalRequest,
    payment:{root:sale.paymentRoot,sourceWallet:flow.source.account,destinationWallet:flow.recipient.account,amountRaw:flow.wire.amountRaw,requestBodyHash:requestBody.hash().toString('hex'),forwardPayloadHash:flow.wire.forward.hash().toString('hex')},
    entitlement:null,stateEvidence:[],tokenDelivery:'separate-settlement'};
  return {original,command:command!,metadata};
}
export async function proveLaunchpadContribution(input: ProjectionInput, nodes: Node[], flow: Flow, sale: LedgerLaunchpadSale, receiptFor: LaunchpadReceiptFor) {
  requireEvidence(flow.confirmed && flow.sourceAsset.owner === input.owner && flow.recipientAsset.owner === sale.address && flow.sourceAsset.master === sale.paymentRoot &&
    flow.recipientAsset.master === sale.paymentRoot && flow.recipient.account === sale.paymentWallet, 'launchpad_original_payment_unverified');
  const {original,command,metadata}=participationRequest(input,nodes,flow,sale,receiptFor);
  const node=exactNotification(input,flow,sale,receiptFor),proof=[original.anchor,flow.source,flow.recipient,node];
  requireEvidence(proof.every(member => input.chains.get(member.account)?.historyComplete), 'launchpad_participation_history_incomplete');
  const amount = BigInt(flow.wire.amountRaw);
  let state:Awaited<ReturnType<typeof readFixedLaunchpadBoundary>>|Awaited<ReturnType<typeof readBondingBoundary>>|Awaited<ReturnType<typeof readAuctionBoundary>>,entitlement:LaunchpadParticipationEntitlement;
  if(sale.model==='fixed'&&command?.kind==='contribute'){state=await readFixedLaunchpadBoundary(input,node,sale);entitlement=fixedEntitlement(state,sale,input.owner,amount,command);}
  else if(sale.model==='bonding'&&command?.kind==='contribute'){state=await readBondingBoundary(input,node,sale);entitlement=bondingEntitlement(state,sale,input.owner,amount,command);}
  else if(sale.model==='auction'&&command?.kind==='bid'){state=await readAuctionBoundary(input,node,sale);entitlement=auctionEntitlement(state,sale,input.owner,amount,command,node.raw.utime);}
  else throw Error('launchpad_model_command_mismatch');
  const debit = await walletBalanceBoundary(input,flow.source,sale,input.owner,-amount,'payment-debit'), credit = await walletBalanceBoundary(input,flow.recipient,sale,sale.address,amount,'payment-credit');
  metadata.saleId=state.before.saleId;metadata.entitlement=entitlement;
  metadata.stateEvidence=[debit,credit,{purpose:'acceptance',...state.evidence,balanceBeforeRaw:null,balanceAfterRaw:null}];
  return {anchor:original.anchor,node,flow,state,metadata,proof};
}

export async function proveFixedContribution(input:ProjectionInput,nodes:Node[],flow:Flow,sale:LedgerLaunchpadFixedSale,receiptFor:LaunchpadReceiptFor) {
  const proof=await proveLaunchpadContribution(input,nodes,flow,sale,receiptFor);
  requireEvidence(proof.metadata.entitlement?.model==='fixed'&&proof.state.before.layout==='fixed-v1'&&proof.state.after.layout==='fixed-v1','launchpad_fixed_entitlement_unverified');
  return {...proof,state:{...proof.state,before:proof.state.before,after:proof.state.after}};
}

export async function decodeLaunchpadContributions(input: ProjectionInput, nodes: Node[], flows: Flow[], receiptFor: LaunchpadReceiptFor, attach: (a:Node,b:Node)=>void) {
  const operations: LaunchpadParticipationOperation[] = [], usedFlows = new Set<string>();
  for (const flow of flows) {
    const sale = input.launchpadSales?.get(flow.recipientAsset.owner ?? '');
    if (!sale || flow.sourceAsset.owner !== input.owner) continue;
    const command = launchpadCommand({body:flow.wire.forward.toBoc().toString('base64')}); if (command?.kind !== 'contribute' && command?.kind !== 'bid') continue;
    let request:ReturnType<typeof participationRequest>;
    try { request=participationRequest(input,nodes,flow,sale,receiptFor); }
    catch { continue; }
    let evidenceNodes=[request.original.anchor,flow.source,flow.recipient],metadata=request.metadata,confirmed=false,issue:string|undefined;
    try {
      const proof=await proveLaunchpadContribution(input,nodes,flow,sale,receiptFor);metadata=proof.metadata;evidenceNodes=proof.proof;confirmed=true;
      usedFlows.add(flow.id);
      for(const movement of flow.source.event?.movements??[])if(movement.id===`${flow.id}:out`)movement.purpose='launchpad_participation';
    } catch(error) { issue=error instanceof Error&&error.message.startsWith('launchpad_')?error.message:'launchpad_participation_evidence_invalid'; }
    for(const member of evidenceNodes)if(member.event)attach(request.original.anchor,member);
    const evidence=unique(evidenceNodes).map(launchpadEvidenceRef);
    operations.push({anchor:request.original.anchor,kind:'launchpad_participation',queryId:metadata.outerQueryId,confirmed,evidence,issue,
      settlement:{status:confirmed?'confirmed':'incomplete',protocol:'launchpad',operation:'launchpad_participation',queryId:metadata.outerQueryId,launchpadParticipation:metadata,evidence}});
  }
  return {operations,usedFlows};
}

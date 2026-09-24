import { Cell, Dictionary, beginCell, type Slice } from '@ton/core';

const end = (s: Slice) => { if (s.remainingBits || s.remainingRefs) throw Error('routed_state_tail'); };
const raw = (s: Slice) => s.loadAddress().toRawString();
const maybeRaw = (s: Slice) => s.loadMaybeAddress()?.toRawString() ?? null;
const hex = (s: Slice) => s.loadUintBig(256).toString(16).padStart(64, '0');
const id = (s: Slice) => s.loadUintBig(64).toString();
const coins = (s: Slice) => s.loadCoins().toString();
function ordinary(cell: Cell, visited = new Set<string>()): void {
  if (cell.isExotic) throw Error('routed_state_exotic');
  const key = cell.hash().toString('hex'); if (visited.has(key)) return; visited.add(key);
  cell.refs.forEach(ref => ordinary(ref, visited));
}
function dictCell(cell: Cell): void { const s=cell.beginParse(); s.loadMaybeRef(); end(s); }
const u64Cells = (s: Slice) => s.loadDict(Dictionary.Keys.BigUint(64),Dictionary.Values.Cell());
const u256Cells = (s: Slice) => s.loadDict(Dictionary.Keys.BigUint(256),Dictionary.Values.Cell());
const u256Values = (s: Slice) => s.loadDict(Dictionary.Keys.BigUint(256),Dictionary.Values.BigUint(256));
const hexKey = (value: bigint) => value.toString(16).padStart(64,'0');
export const ROUTER_SETTLEMENT_START = 0xc000000000000000n;

export function dlmmRouterSettlementLayoutHash(): string {
  const b=beginCell().storeUint(0x52534a41,32);
  [64,256,256,124,124,124,8,8,8,8,64,64].forEach(size=>b.storeUint(size,16));
  [0x544c5231,0x424c4b31,0x534c4e31,0x53515131,0x52505331,0x52504631,0x43544631].forEach(tag=>b.storeUint(tag,32));
  return b.storeCoins(400_000_000n).storeCoins(220_000_000n).storeCoins(620_000_000n).storeCoins(80_000_000n)
    .storeUint(0x52504341,32).endCell().hash().toString('hex');
}
export interface RouterSettlementRecord {
  settlementId:string;requestHash:string;groupKey:string;amountRaw:string;fundedRaw:string;finalizeFundedRaw:string;controlFundedRaw:string;
  kind:number;legIndex:number;status:number;controlInFlight:number;recordedAt:number;nextSourceSettlementId:string;
  sourceWallet:string;destinationOwner:string;destinationWallet:string;controlRefundDestination:string|null;
  forwardTonAmountRaw:string;forwardPayload:Cell;recordHash:string;
}
export function readDlmmRouterSettlementRecord(cell:Cell):RouterSettlementRecord {
  const s=cell.beginParse();
  const settlementId=id(s),requestHash=hex(s),groupKey=hex(s),amountRaw=coins(s),kind=s.loadUint(8),legIndex=s.loadUint(8),status=s.loadUint(8),controlInFlight=s.loadUint(8);
  const recordedAt=s.loadIntBig(64),nextSourceSettlementId=id(s);
  if(s.remainingRefs!==4)throw Error('routed_record_layout');
  const source=s.loadRef().beginParse(),destination=s.loadRef().beginParse(),funding=s.loadRef().beginParse(),forward=s.loadRef().beginParse();end(s);
  const sourceWallet=raw(source),controlRefundDestination=maybeRaw(source);end(source);
  const destinationOwner=raw(destination),destinationWallet=raw(destination);end(destination);
  const fundedRaw=coins(funding),finalizeFundedRaw=coins(funding),controlFundedRaw=coins(funding);end(funding);
  const forwardTonAmountRaw=coins(forward),forwardPayload=forward.loadRef();end(forward);
  if(BigInt(settlementId)<ROUTER_SETTLEMENT_START||!amountRaw||amountRaw==='0'||![1,2,3,4,5,6,7,8,10,11,12,13,15].includes(kind)||
    status<1||status>6||controlInFlight>1||recordedAt<0n||recordedAt>BigInt(Number.MAX_SAFE_INTEGER))throw Error('routed_record_fields');
  return {settlementId,requestHash,groupKey,amountRaw,fundedRaw,finalizeFundedRaw,controlFundedRaw,kind,legIndex,status,controlInFlight,
    recordedAt:Number(recordedAt),nextSourceSettlementId,sourceWallet,destinationOwner,destinationWallet,controlRefundDestination,forwardTonAmountRaw,forwardPayload,recordHash:cell.hash().toString('hex')};
}
export interface RouterSettlementGroup {
  kind:number;businessId:string;snapshotHash:string;intentHash:string;pendingLegs:number;totalLegs:number;finalized:number;
  nativeRequired:string;nativeFunded:string;completionData:Cell;nativeActions:Cell;replayState:Cell;groupHash:string;
}
export function readDlmmRouterSettlementGroup(cell:Cell):RouterSettlementGroup {
  const s=cell.beginParse();
  const kind=s.loadUint(8),businessId=id(s),snapshotHash=hex(s),intentHash=hex(s),pendingLegs=s.loadUint(8),totalLegs=s.loadUint(8),finalized=s.loadUint(8);
  const nativeRequired=coins(s),nativeFunded=coins(s),completionData=s.loadRef(),nativeActions=s.loadRef(),replayState=s.loadRef();end(s);
  const replay=replayState.beginParse();coins(replay);coins(replay);const inFlight=replay.loadUint(8),awaitingSurplus=replay.loadUint(8);maybeRaw(replay);end(replay);
  if(kind<1||kind>10||pendingLegs>totalLegs||finalized>2||inFlight>1||awaitingSurplus>1)throw Error('routed_group_fields');
  return {kind,businessId,snapshotHash,intentHash,pendingLegs,totalLegs,finalized,nativeRequired,nativeFunded,completionData,nativeActions,replayState,groupHash:cell.hash().toString('hex')};
}
export interface RouterSwapReceipt {firstSettlementId:string;groupKey:string;notification:Cell}
export function readDlmmRouterSwapReceipt(cell:Cell):RouterSwapReceipt {
  const s=cell.beginParse(),firstSettlementId=id(s),groupKey=hex(s),notification=s.loadRef();end(s);
  if(BigInt(firstSettlementId)<ROUTER_SETTLEMENT_START)throw Error('routed_swap_receipt_id');
  return {firstSettlementId,groupKey,notification};
}

/** Exact first-release RTR1/extras5/RSJ8 custody path. Archive code and account
 * authentication are performed by the graph before these business facts qualify. */
export function readDlmmRouterState(boc:string) {
  const cell=Cell.fromBase64(boc);ordinary(cell);const root=cell.beginParse();
  if(root.remainingBits!==32||root.remainingRefs!==4||root.loadUint(32)!==0x52545231)throw Error('routed_storage_layout');
  const registry=root.loadRef().beginParse(),routes=root.loadRef(),pending=root.loadRef(),extras=root.loadRef().beginParse();end(root);
  const governance=raw(registry),enabled=registry.loadUint(8),withdrawalsOnly=registry.loadUint(8);registry.loadRef();end(registry);
  if(enabled>1||withdrawalsOnly>1)throw Error('routed_registry_fields');dictCell(routes);dictCell(pending);
  if(extras.loadUint(8)!==5)throw Error('routed_extras_version');
  const riskController=maybeRaw(extras),riskSourceId=extras.loadUint(32);
  const policy=extras.loadRef(),stableAmps=extras.loadRef(),orders=extras.loadRef(),tail=extras.loadRef().beginParse();end(extras);dictCell(stableAmps);
  const policySlice=policy.beginParse();maybeRaw(policySlice);maybeRaw(policySlice);maybeRaw(policySlice);policySlice.skip(40);const policyJournal=policySlice.loadRef().beginParse();end(policySlice);policyJournal.skip(576);end(policyJournal);
  const order=orders.beginParse();order.loadRef();[order.loadRef(),order.loadRef(),order.loadRef()].forEach(dictCell);if(order.loadUintBig(64)===0n)throw Error('routed_order_counter');end(order);
  const twap=tail.loadRef().beginParse(),tokenRoutes=tail.loadRef(),swap=tail.loadRef().beginParse(),durable=tail.loadRef().beginParse();end(tail);dictCell(tokenRoutes);
  [twap.loadRef(),twap.loadRef(),twap.loadRef()].forEach(dictCell);
  const creationSlice=twap.loadRef().beginParse();
  const twapCreationCells=creationSlice.loadDict(Dictionary.Keys.BigUint(256),Dictionary.Values.Cell());
  const automationIdentityCells=u64Cells(creationSlice);end(creationSlice);
  const twapCreationReceipts=new Map<string,{planId:string;notificationHash:string;payloadHash:string;status:number;settledSlices:number;amountIn:string;remainingIn:string;amountOut:string;refundedIn:string}>();
  for(const[key,value]of twapCreationCells){const c=value.beginParse(),planId=id(c),notificationHash=hex(c),payloadHash=hex(c),status=c.loadUint(8),settledSlices=c.loadUint(16),a=c.loadRef().beginParse();end(c);
    const amountIn=coins(a),remainingIn=coins(a),amountOut=coins(a),refundedIn=coins(a);end(a);
    if(status>3||settledSlices>10||BigInt(amountIn)<=0n||BigInt(remainingIn)+BigInt(refundedIn)>BigInt(amountIn)||
      ((status===1||status===2)&&remainingIn!=='0')||(status===1&&(planId==='0'||settledSlices===0||amountOut==='0'))||
      (planId==='0'&&(status!==2&&status!==3||settledSlices!==0||amountOut!=='0')))throw Error('routed_twap_creation_receipt');
    twapCreationReceipts.set(hexKey(key),{planId,notificationHash,payloadHash,status,settledSlices,amountIn,remainingIn,amountOut,refundedIn});}
  const automationOwners=new Map<string,{owner:string;queryId:string;queue:string|null}>();
  for(const[businessKey,value]of automationIdentityCells){const identity=value.beginParse(),owner=identity.loadAddress(),queryId=identity.loadUintBig(64),queue=identity.loadMaybeAddress();end(identity);
    const domain=businessKey & (7n<<61n),businessId=businessKey & ((1n<<61n)-1n);
    if(businessId===0n||(domain!==(1n<<61n)&&domain!==(1n<<62n))||(domain===(1n<<61n)&&!queue))throw Error('routed_automation_identity');
    if(queryId>0n){
      const key=beginCell().storeUint(0x54574146,32).storeAddress(owner).storeUint(queryId,64).endCell().hash().toString('hex');
      const receipt=twapCreationReceipts.get(key);
      if(domain!==(1n<<62n)||!queue||!receipt||receipt.planId!==businessId.toString())throw Error('routed_twap_creation_identity');
    }
    automationOwners.set(businessKey.toString(),{owner:owner.toRawString(),queryId:queryId.toString(),queue:queue?.toRawString()??null});}
  for(const receipt of twapCreationReceipts.values())if(receipt.planId!=='0'&&!automationOwners.has(((1n<<62n)|BigInt(receipt.planId)).toString()))throw Error('routed_twap_creation_identity');
  if(twap.loadUintBig(64)===0n)throw Error('routed_plan_counter');maybeRaw(twap);end(twap);
  dictCell(swap.loadRef());const nextUserSwapId=id(swap);if(nextUserSwapId==='0')throw Error('routed_swap_counter');end(swap);
  const telemetry=durable.loadRef(),journal=durable.loadRef().beginParse(),referral=durable.loadRef().beginParse(),walletCode=durable.loadRef();end(durable);dictCell(telemetry);
  if(walletCode.bits.length===0&&walletCode.refs.length===0)throw Error('routed_wallet_code_missing');
  if(journal.loadUint(32)!==0x52534a38)throw Error('routed_journal_version');
  const nextSettlementId=id(journal),reservedTokens=coins(journal),reservedNative=coins(journal),layoutHash=hex(journal);
  const primary=journal.loadRef().beginParse(),secondary=journal.loadRef().beginParse();end(journal);
  if(BigInt(nextSettlementId)<ROUTER_SETTLEMENT_START||layoutHash!==dlmmRouterSettlementLayoutHash())throw Error('routed_journal_layout_hash');
  const entries=u64Cells(primary),groupCells=u256Cells(primary),locks=u256Values(primary);end(primary);
  const lanes=secondary.loadDict(Dictionary.Keys.Address(),Dictionary.Values.BigUint(64)),queues=secondary.loadDict(Dictionary.Keys.Address(),Dictionary.Values.Cell());
  const receipts=secondary.loadDict(Dictionary.Keys.BigUint(256),Dictionary.Values.BigUint(64)),poolGroups=u256Values(secondary);end(secondary);
  const settlements=new Map<string,RouterSettlementRecord>(),groups=new Map<string,RouterSettlementGroup>();
  for(const [key,value]of entries){const record=readDlmmRouterSettlementRecord(value);if(record.settlementId!==key.toString()||key>=BigInt(nextSettlementId))throw Error('routed_record_identity');settlements.set(key.toString(),record);}
  for(const [key,value]of groupCells)groups.set(hexKey(key),readDlmmRouterSettlementGroup(value));
  const sourceLanes=new Map([...lanes].map(([key,value])=>[key.toRawString(),value.toString()]));
  const sourceQueues=new Map<string,{head:string;tail:string}>();for(const[key,value]of queues){const s=value.beginParse(),head=id(s),tail=id(s);end(s);if(head==='0'||tail==='0')throw Error('routed_queue_empty');sourceQueues.set(key.toRawString(),{head,tail});}
  const moduleKey=referral.loadUint(32),referralReservedNative=coins(referral),referralConfig=referral.loadRef(),referralOutbox=referral.loadRef();
  const completionDict=u256Values(referral),swapDict=u256Cells(referral);end(referral);
  const completions=new Map([...completionDict].map(([key,value])=>[hexKey(key),hexKey(value)]));
  const swapReceipts=new Map<string,RouterSwapReceipt>();for(const[key,value]of swapDict){const receipt=readDlmmRouterSwapReceipt(value);if(!groups.has(receipt.groupKey))throw Error('routed_swap_group_missing');swapReceipts.set(hexKey(key),receipt);}
  return {dataHash:cell.hash().toString('hex'),walletCodeHash:walletCode.hash().toString('hex'),walletCode,governance,enabled,withdrawalsOnly,riskController,riskSourceId,
    settlements,groups,swapReceipts,twapCreationReceipts,automationOwners,completions,reservedTokens,reservedNative,nextSettlementId,sourceLanes,sourceQueues,nextUserSwapId,layoutHash,
    businessLocks:new Map([...locks].map(([key,value])=>[hexKey(key),hexKey(value)])),executionReceipts:new Map([...receipts].map(([key,value])=>[hexKey(key),value.toString()])),
    poolGroupsByRequestTag:new Map([...poolGroups].map(([key,value])=>[hexKey(key),hexKey(value)])),moduleKey,referralReservedNative,referralConfig,referralOutbox};
}

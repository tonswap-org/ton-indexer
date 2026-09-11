import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Address, Cell, Dictionary, beginCell } from '@ton/core';
import type { RawMessage, RawTransaction } from '../data/dataSource';
import { projectOwnerLedger, type ProjectionInput, type LedgerChain } from '../ledger/project';
import { canonicalLedgerHash } from '../ledger/normalize';
import type { LedgerStateSnapshot } from '../ledger/archive';
import type { LedgerAsset } from '../ledger/types';
import { readFixedSaleState } from '../ledger/launchpadState';
import { launchpadCommand, launchpadSettlementTuple, launchpadSettlementTransfer, launchpadInternalSettlementTransfer } from '../ledger/launchpadWire';
import { TRANSFER, INTERNAL, SETTLEMENT_INTERNAL } from '../ledger/wire';
import { loadOpcodes } from '../utils/opcodes';

const fixturePath = resolve(__dirname, 'fixtures/launchpad-fixed-refund.json');
type Snapshot = LedgerStateSnapshot['state'];
type Trace = { accounts: Record<string, string>; facts: Record<string, string>; compiler: {entrypointFileName:string;codeHash:string}[];
  transactions: {phase:string;account:string;raw:RawTransaction}[];
  boundaries: {phase:string;account:string;transactionLt:string;transactionHash:string;before:Snapshot;after:Snapshot}[] };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const stateKey = (account: string, lt: string, h: string) => `${account}:${lt}:${canonicalLedgerHash(h)}`;
/** Real, unchanged untransformed contract trace; only in-memory negative cases are altered. */
export function launchpadFixture() {
  const bytes = readFileSync(fixturePath), trace = JSON.parse(bytes.toString()) as Trace, accounts = trace.accounts;
  const chains = new Map<string, LedgerChain>(), states = new Map<string, LedgerStateSnapshot>();
  for (const {account, raw} of trace.transactions) {
    if (!chains.has(account)) chains.set(account, {account, role: account === accounts.owner ? 'owner' : account === accounts.ownerPaymentWallet ? 'owned_jetton_wallet' : 'counterparty', generation: hash(account), historyComplete: true, transactions: []});
    chains.get(account)!.transactions.push(raw);
  }
  // Sandbox has no masterchain blocks. The synthetic archive seqno identifies this one captured trace,
  // while every lookup remains bound to the actual transaction LT/hash and recorded cell.
  for (const b of trace.boundaries) for (const state of [b.before, b.after]) {
    if (!state.lastTxLt || !state.lastTxHash) continue;
    const key = stateKey(b.account, state.lastTxLt, state.lastTxHash), prior = states.get(key);
    if (prior) {
      assert.equal(prior.state.codeBoc, state.codeBoc, 'Repeated archive code is identical');
      assert.equal(prior.state.dataBoc, state.dataBoc, 'Repeated archive data is identical');
    }
    states.set(key, {seqno: 1, state});
  }
  const saleSnapshot = trace.boundaries.find(b => b.account === accounts.sale && b.phase === 'refund-claim')!;
  const saleState = readFixedSaleState(saleSnapshot.before.dataBoc!), walletCode = Cell.fromBase64(saleState.paymentRouting.walletCodeBoc);
  const wallets = new Map<string, LedgerAsset>();
  for (const [wallet, owner, master] of [
    [accounts.ownerPaymentWallet, accounts.owner, accounts.paymentRoot], [accounts.paymentSaleWallet, accounts.sale, accounts.paymentRoot],
    [accounts.creatorPaymentWallet, accounts.creator, accounts.paymentRoot], [accounts.protocolPaymentWallet, accounts.protocol, accounts.paymentRoot],
    [accounts.saleWallet, accounts.sale, accounts.saleRoot],
  ]) wallets.set(wallet, {kind:'jetton',id:`testnet:jetton:${master}`,master,wallet,owner,decimals:9});
  const input: ProjectionInput = {network:'testnet',owner:accounts.owner,chains,wallets,pools:new Map(),opcodes:loadOpcodes(),
    launchpadControllers:[accounts.sale], launchpadSales:new Map([[accounts.sale,{model:'fixed',address:accounts.sale,factory:saleState.registry.factory,paymentRoot:accounts.paymentRoot,
      paymentWallet:accounts.paymentSaleWallet,paymentWalletCode:walletCode,saleCodeHash:trace.compiler.find(c=>c.entrypointFileName.endsWith('sale_fixed.tolk'))!.codeHash}]]),
    stateAt:async(account,lt,h)=>states.get(stateKey(account,lt,h))??null};
  return {input,trace,accounts,states,fixtureSha256:hash(bytes.toString())};
}
type Fixture = ReturnType<typeof launchpadFixture>;
const refund = async (f: Fixture) => {
  const projection = await projectOwnerLedger(f.input);
  return {projection,event:projection.events.find(e=>e.kind==='launchpad_refund')};
};
function saleTransaction(f:Fixture,kind:'claim'|'succeeded'|'finalized') {
  const tx=f.input.chains.get(f.accounts.sale)!.transactions.find(t=>kind==='claim' ? launchpadCommand(t.inMessage)?.kind==='claim' : launchpadSettlementTuple(t.inMessage)?.kind===kind && launchpadSettlementTuple(t.inMessage)?.queryId==='3');
  assert(tx); return tx;
}
const afterState=(f:Fixture,account:string,tx:RawTransaction)=>f.states.get(stateKey(account,tx.lt,tx.hash))!;
function changeMessage(f:Fixture,original:RawMessage,body:Cell,source=original.source) {
  let changed=0;
  for(const chain of f.input.chains.values()) for(const tx of chain.transactions) for(const m of [tx.inMessage,...tx.outMessages])
    if(m && m.body===original.body && m.createdLt===original.createdLt && m.source===original.source && m.destination===original.destination) {
      m.body=body.toBoc().toString('base64');m.op=body.beginParse().preloadUint(32);m.source=source;changed++;
    }
  assert(changed>0);
}
function tuple(kind:number,query='3',amount='4000000000',destination:string) {return beginCell().storeUint(kind,32).storeUint(BigInt(query),64).storeCoins(BigInt(amount)).storeAddress(Address.parse(destination)).endCell();}
function dropFrom(f:Fixture,account:string,lt:string) {
  const chain=f.input.chains.get(account)!;chain.transactions=chain.transactions.filter(t=>BigInt(t.lt)<BigInt(lt));
}
/** Mutated cells are negative test vectors only. Positive state is always the unchanged trace. */
function changeJournal(f:Fixture,tx:RawTransaction,changes:{status?:number;reservedPayment?:bigint;currentPayment?:bigint;tailPayment?:bigint;nextSettlement?:bigint}) {
  const snapshot=afterState(f,f.accounts.sale,tx),root=Cell.fromBase64(snapshot.state.dataBoc!),state=root.refs[3],journal=state.refs[3],j=journal.beginParse();
  const entries=j.loadDict(Dictionary.Keys.BigUint(64),Dictionary.Values.Cell()),next=j.loadUintBig(64),current=j.loadUintBig(64),currentSale=j.loadUintBig(64),tail=j.loadUintBig(64),tailSale=j.loadUintBig(64),reserve=j.loadCoins(),reserveSale=j.loadCoins();
  if(changes.status!==undefined){const record=entries.get(3n)!;const r=record.beginParse();const id=r.loadUintBig(64),request=r.loadUintBig(256),amount=r.loadCoins(),forward=r.loadCoins(),route=r.loadUint(8),kind=r.loadUint(8);r.loadUint(8);
    entries.set(3n,beginCell().storeUint(id,64).storeUint(request,256).storeCoins(amount).storeCoins(forward).storeUint(route,8).storeUint(kind,8).storeUint(changes.status,8).storeSlice(r).endCell());}
  const updated=beginCell().storeDict(entries).storeUint(changes.nextSettlement??next,64).storeUint(changes.currentPayment??current,64).storeUint(currentSale,64).storeUint(changes.tailPayment??tail,64).storeUint(tailSale,64).storeCoins(changes.reservedPayment??reserve).storeCoins(reserveSale).endCell();
  const newState=beginCell().storeBits(state.bits);for(let i=0;i<4;i++)newState.storeRef(i===3?updated:state.refs[i]);
  const newRoot=beginCell().storeBits(root.bits);for(let i=0;i<4;i++)newRoot.storeRef(i===3?newState.endCell():root.refs[i]);
  snapshot.state.dataBoc=newRoot.endCell().toBoc().toString('base64');readFixedSaleState(snapshot.state.dataBoc);
}

async function guardedTransfers() {
  const a=(n:number)=>`0:${n.toString(16).padStart(64,'0')}`,owner=a(1),ownerWallet=a(2),sale=a(3),saleWallet=a(4),master=a(5);
  const msg=(source:string,destination:string,body:Cell,createdLt:string):RawMessage=>({source,destination,body:body.toBoc().toString('base64'),op:body.beginParse().preloadUint(32),value:'200',createdLt,forwardFeeRaw:'3',ihrFeeRaw:'0',bounced:false});
  const tx=(lt:string,inMessage:RawMessage|undefined,outMessages:RawMessage[],fee:string):RawTransaction=>({lt,hash:hash(lt),utime:1750000000+Number(lt),success:true,status:'success',totalFeesRaw:fee,inMessage,outMessages});
  const asset=(wallet:string,holder:string):LedgerAsset=>({kind:'jetton',id:`testnet:jetton:${master}`,master,wallet,owner:holder,decimals:9});
  const payloads=[['CNTR',beginCell().storeUint(0x434e5452,32).storeUint(7,64).storeAddress(Address.parse(owner)).storeAddress(Address.parse(owner)).endCell(),true],
    ['PBID',beginCell().storeUint(0x50424944,32).storeUint(7,64).endCell(),true],
    ['VCLM',beginCell().storeUint(0x56434c4d,32).storeUint(7,64).storeCoins(123n).endCell(),false],['empty-refund',Cell.EMPTY,false]] as const;
  for(const[name,payload,outgoing]of payloads){
    const sourceOwner=outgoing?owner:sale,recipientOwner=outgoing?sale:owner,source=outgoing?ownerWallet:saleWallet,dest=outgoing?saleWallet:ownerWallet;
    const request=beginCell().storeUint(TRANSFER,32).storeUint(7,64).storeCoins(1234567890123456789n).storeAddress(Address.parse(recipientOwner)).storeAddress(Address.parse(sourceOwner)).storeRef(outgoing?Cell.EMPTY:beginCell().storeUint(0x4a535454,32).endCell()).storeCoins(0).storeRef(payload).endCell();
    const credit=beginCell().storeUint(outgoing?INTERNAL:SETTLEMENT_INTERNAL,32).storeUint(7,64).storeCoins(1234567890123456789n).storeAddress(Address.parse(sourceOwner)).storeAddress(Address.parse(outgoing?sourceOwner:source)).storeCoins(0).storeRef(payload).endCell();
    const requestMsg=msg(sourceOwner,source,request,'100'),creditMsg=msg(source,dest,credit,'200');
    const chains=new Map<string,LedgerChain>([[owner,{account:owner,role:'owner',generation:hash('owner'),historyComplete:true,transactions:outgoing?[tx('100',undefined,[requestMsg],'10')]:[]}],
      [source,{account:source,role:outgoing?'owned_jetton_wallet':'counterparty',generation:hash(source),historyComplete:true,transactions:[tx('200',requestMsg,[creditMsg],'5')]}],
      [dest,{account:dest,role:outgoing?'counterparty':'owned_jetton_wallet',generation:hash(dest),historyComplete:true,transactions:[tx('300',creditMsg,[],'5')]}]]);
    const input:ProjectionInput={network:'testnet',owner,chains,wallets:new Map([[ownerWallet,asset(ownerWallet,owner)],[saleWallet,asset(saleWallet,sale)]]),pools:new Map(),opcodes:loadOpcodes(),stateAt:async()=>null,launchpadControllers:[sale]};
    const projection=await projectOwnerLedger(input);assert.equal(projection.events.length,1,name);
    const e=projection.events[0];assert.notEqual(e.settlement?.status,'confirmed',name);assert(e.issues.includes('launchpad_identity_or_cash_settlement_unverified'),name);
    const cash=e.movements.filter(m=>m.asset.kind==='jetton');assert.equal(cash.length,1);assert.equal(cash[0].amountRaw,'1234567890123456789');assert.equal(cash[0].direction,outgoing?'out':'in');
    assert.equal(e.movements.filter(m=>m.direction==='fee').reduce((s,m)=>s+BigInt(m.amountRaw),0n),outgoing?21n:5n);
    assert.notEqual(e.kind,'launchpad_refund');
    // A truly unrelated generic transfer remains usable without product classification.
    if(name==='empty-refund'){input.launchpadControllers=[];const ordinary=(await projectOwnerLedger(input)).events[0];assert.equal(ordinary.settlement?.status,'confirmed');}
  }
}

export async function testLaunchpadRefunds() {
  await guardedTransfers();
  const f=launchpadFixture(),positive=await refund(f),e=positive.event;
  assert(e,'Authentic failed fixed-sale CLAM must create a refund operation');
  assert.equal(e.settlement?.status,'confirmed',JSON.stringify(e.issues));
  assert.equal(e.settlement?.launchpad?.settlementId,'3');assert.equal(e.settlement?.launchpad?.amountRaw,'4000000000');
  assert.equal(e.settlement?.launchpad?.factory,f.accounts.creator);assert.equal(e.settlement?.launchpad?.claimQueryId,'9');
  const cash=e.movements.filter(m=>m.asset.kind==='jetton');assert.equal(cash.length,1);assert.equal(cash[0].direction,'in');assert.equal(cash[0].amountRaw,'4000000000');
  assert.equal(cash[0].purpose,'launchpad_refund');assert.equal(cash[0].evidence.kind,'jetton_transfer');assert.equal(cash[0].evidence.queryId,'3');
  assert(e.settlement!.launchpad!.stateEvidence.every(v=>v.transaction.hash===canonicalLedgerHash(v.transaction.hash)));
  assert.deepEqual(e.settlement!.launchpad!.stateEvidence.map(v=>v.purpose).sort(),['contribution','delivery','finalization','refund-enqueue']);
  assert(!cash.some(m=>m.amountRaw==='960000000'),'Creator escrow is never participant refund');
  const original=positive.projection.events.find(x=>x.movements.some(m=>m.direction==='out'&&m.asset.kind==='jetton'&&m.amountRaw==='4000000000'))!;
  assert(original && original.id!==e.id);assert(original.utime<e.utime);assert.equal(original.kind,'launchpad_participation');assert.equal(original.settlement?.status,'confirmed');

  const cases:Record<string,(f:Fixture)=>void>={
    'wrong-original-source-wallet-code':f=>{const b=f.trace.boundaries.find(b=>b.phase==='contribution'&&b.account===f.accounts.ownerPaymentWallet)!;f.states.get(stateKey(b.account,b.transactionLt,b.transactionHash))!.state.codeBoc=Cell.EMPTY.toBoc().toString('base64');},
    'wrong-original-credit-wallet-code':f=>{const b=f.trace.boundaries.find(b=>b.phase==='contribution'&&b.account===f.accounts.paymentSaleWallet)!;f.states.get(stateKey(b.account,b.transactionLt,b.transactionHash))!.state.codeBoc=Cell.EMPTY.toBoc().toString('base64');},
    'missing-original-owner-request':f=>{const c=f.input.chains.get(f.accounts.owner)!;c.transactions=c.transactions.filter(t=>!t.outMessages.some(m=>m.destination===f.accounts.ownerPaymentWallet && m.op===TRANSFER));},
    'missing-original-payment':f=>{const c=f.input.chains.get(f.accounts.ownerPaymentWallet)!;c.transactions=c.transactions.filter(t=>t.inMessage?.op!==TRANSFER||launchpadSettlementTransfer(t.inMessage)?.queryId==='3'||!t.outMessages.some(m=>m.destination===f.accounts.paymentSaleWallet));},
    'missing-sale-history':f=>{f.input.chains.get(f.accounts.sale)!.historyComplete=false;},
    'missing-owner-history':f=>{f.input.chains.get(f.accounts.owner)!.historyComplete=false;},
    'missing-wallet-history':f=>{f.input.chains.get(f.accounts.ownerPaymentWallet)!.historyComplete=false;},
    'foreign-configured-factory':f=>{f.input.launchpadSales!.get(f.accounts.sale)!.factory=f.accounts.protocol;},
    'wrong-sale-code':f=>{f.input.launchpadSales!.get(f.accounts.sale)!.saleCodeHash='a'.repeat(64);},
    'wrong-wallet-code':f=>{f.input.launchpadSales!.get(f.accounts.sale)!.paymentWalletCode=Cell.EMPTY;},
    'missing-claim-before':f=>{const tx=saleTransaction(f,'claim');f.states.delete(stateKey(f.accounts.sale,tx.prevTransactionLt!,tx.prevTransactionHash!));},
    'missing-final-state':f=>{const tx=saleTransaction(f,'finalized');f.states.delete(stateKey(f.accounts.sale,tx.lt,tx.hash));},
    'foreign-wallet-owner':f=>{f.input.wallets.get(f.accounts.ownerPaymentWallet)!.owner=f.accounts.creator;},
    'wrong-dispatch-amount':f=>{const m={...saleTransaction(f,'claim').outMessages.find(m=>m.destination===f.accounts.paymentSaleWallet&&m.op===TRANSFER)!};const wire=launchpadSettlementTransfer(m)!;const body=beginCell().storeUint(TRANSFER,32).storeUint(3,64).storeCoins(3999999999n).storeAddress(Address.parse(wire.recipientOwner)).storeAddress(Address.parse(wire.responseOwner)).storeRef(beginCell().storeUint(0x4a535454,32).endCell()).storeCoins(0).storeRef(Cell.EMPTY).endCell();changeMessage(f,m,body);},
    'wrong-actual-recipient-code':f=>{const tx=f.input.chains.get(f.accounts.ownerPaymentWallet)!.transactions.find(t=>launchpadInternalSettlementTransfer(t.inMessage)?.queryId==='3')!;afterState(f,f.accounts.ownerPaymentWallet,tx).state.codeBoc=Cell.EMPTY.toBoc().toString('base64');},
    'wrong-callback-amount':f=>{const m={...saleTransaction(f,'succeeded').inMessage!};changeMessage(f,m,tuple(0x4a535543,'3','3999999999',f.accounts.ownerPaymentWallet));},
    'wrong-callback-query':f=>{const m={...saleTransaction(f,'succeeded').inMessage!};changeMessage(f,m,tuple(0x4a535543,'4','4000000000',f.accounts.ownerPaymentWallet));},
    'foreign-callback-wallet':f=>{const m={...saleTransaction(f,'succeeded').inMessage!};changeMessage(f,m,tuple(0x4a535543,'3','4000000000',f.accounts.ownerPaymentWallet),f.accounts.creatorPaymentWallet);},
    'truncated-callback':f=>{const m={...saleTransaction(f,'succeeded').inMessage!};changeMessage(f,m,beginCell().storeUint(0x4a535543,32).storeUint(3,64).endCell());},
    'duplicate-callback':f=>{const tx=saleTransaction(f,'succeeded');f.input.chains.get(f.accounts.sale)!.transactions.push({...tx,lt:(BigInt(tx.lt)+1n).toString(),hash:hash('duplicate-callback')});},
    'replay-is-not-finalized':f=>{const m={...saleTransaction(f,'finalized').inMessage!};changeMessage(f,m,tuple(0x4a535250,'3','4000000000',f.accounts.ownerPaymentWallet));},
    'delivered-without-finalization':f=>{const tx=saleTransaction(f,'finalized');dropFrom(f,f.accounts.sale,tx.lt);},
    'null-factory-does-not-prove-finalized-sale':f=>{f.input.launchpadSales!.get(f.accounts.sale)!.factory=null;},
    'terminal-status-without-reserve-release':f=>{const tx=saleTransaction(f,'finalized');changeJournal(f,tx,{reservedPayment:4960000000n});},
    'negative-final-is-not-delivery':f=>{const tx=saleTransaction(f,'succeeded');changeJournal(f,tx,{status:6});},
    'final-status-at-enqueue-is-not-payment':f=>{const tx=saleTransaction(f,'claim');changeJournal(f,tx,{status:5});},
    'terminal-clears-unrelated-escrow-tail':f=>{const tx=saleTransaction(f,'finalized');changeJournal(f,tx,{tailPayment:0n});},
    'terminal-over-releases-reserve':f=>{const tx=saleTransaction(f,'finalized');changeJournal(f,tx,{reservedPayment:0n});},
    'terminal-changes-next-wire':f=>{const tx=saleTransaction(f,'finalized');changeJournal(f,tx,{nextSettlement:6n});},
    'terminal-wrong-snapshot-hash':f=>{const tx=saleTransaction(f,'finalized');afterState(f,f.accounts.sale,tx).state.lastTxHash=hash('foreign-state');},
    'failed-credit':f=>{const tx=f.input.chains.get(f.accounts.ownerPaymentWallet)!.transactions.find(t=>launchpadInternalSettlementTransfer(t.inMessage)?.queryId==='3')!;tx.success=false;tx.status='failed';},
  };
  for(const[name,mutate]of Object.entries(cases)){const fixture=launchpadFixture();mutate(fixture);const result=await refund(fixture);assert.notEqual(result.event?.settlement?.status,'confirmed',name);assert(!result.projection.events.some(e=>e.settlement?.status==='confirmed'&&e.movements.some(m=>m.purpose==='launchpad_refund')),name);}
  const unqualified=launchpadFixture();unqualified.input.launchpadSales=new Map();
  const baseline=await projectOwnerLedger(unqualified.input);
  const physical=(projection:typeof baseline)=>projection.events.flatMap(event=>event.movements).map(({purpose,...movement})=>movement).sort((a,b)=>a.id.localeCompare(b.id));
  assert.deepEqual(physical(positive.projection),physical(baseline),'Certification preserves every existing physical amount, fee, identity and evidence exactly');
  const noEscrowRetry=launchpadFixture();for(const row of noEscrowRetry.trace.transactions.filter(t=>t.phase==='creator-escrow-retry')){
    const chain=noEscrowRetry.input.chains.get(row.account)!;chain.transactions=chain.transactions.filter(t=>t!==row.raw);}
  assert.equal((await refund(noEscrowRetry)).event?.settlement?.status,'confirmed','Creator escrow completion is independent of the participant refund');
  const pending=launchpadFixture(),terminal=saleTransaction(pending,'finalized');dropFrom(pending,pending.accounts.sale,terminal.lt);
  const partial=await refund(pending);assert(partial.event);assert.equal(partial.event.id,e.id,'Late missing callback preserves original claim identity');assert.equal(partial.event.settlement?.status,'incomplete');
  assert.equal(partial.event.movements.filter(m=>m.asset.kind==='jetton'&&m.direction==='in').reduce((s,m)=>s+BigInt(m.amountRaw),0n),4000000000n,'Actual observed credit retained once despite missing later finalizer');
  const noCredit=launchpadFixture();const creditTx=noCredit.input.chains.get(noCredit.accounts.ownerPaymentWallet)!.transactions.find(t=>launchpadInternalSettlementTransfer(t.inMessage)?.queryId==='3')!;
  for(const chain of noCredit.input.chains.values())chain.transactions=chain.transactions.filter(t=>BigInt(t.lt)<BigInt(creditTx.lt));
  const waiting=await refund(noCredit);assert.equal(waiting.event?.id,e.id);assert.equal(waiting.event?.settlement?.status,'incomplete');
  assert.equal(waiting.event?.movements.filter(m=>m.asset.kind==='jetton').length,0,'Dispatched request cannot fabricate an unobserved refund credit');
  const archiveMissing=launchpadFixture(),claimTx=saleTransaction(archiveMissing,'claim');
  archiveMissing.states.delete(stateKey(archiveMissing.accounts.sale,claimTx.prevTransactionLt!,claimTx.prevTransactionHash!));
  const unresolved=await projectOwnerLedger(archiveMissing.input),rawClaim=unresolved.events.find(event=>event.id===e.id);
  assert(rawClaim,'Unresolved original claim identity remains present');assert(rawClaim.issues.includes('launchpad_claim_settlement_unverified'));
  assert.notEqual(rawClaim.kind,'launchpad_refund');assert.notEqual(rawClaim.settlement?.status,'confirmed');assert.equal(rawClaim.settlement?.launchpad,undefined);
  assert.deepEqual(physical(unresolved),physical(positive.projection),'Missing archives cannot remove or fabricate raw physical movements');
  const unknownController=launchpadFixture();unknownController.input.launchpadSales=new Map();unknownController.input.launchpadControllers=[];
  assert(!(await projectOwnerLedger(unknownController.input)).events.some(event=>event.issues.includes('launchpad_claim_settlement_unverified')),'Unknown controller does not receive the qualified claim marker');
  if(process.env.LAUNCHPAD_REFUND_EXPORT_DIR){const dir=resolve(process.env.LAUNCHPAD_REFUND_EXPORT_DIR);mkdirSync(dir,{recursive:true});
    for(const[name,p]of [['confirmed',positive.projection],['pending',partial.projection],['claim-unresolved',unresolved]]as const)writeFileSync(resolve(dir,`launchpad-fixed-refund-${name}.json`),JSON.stringify({scope:p.projectionScope,events:p.events},null,2)+'\n');
    writeFileSync(resolve(dir,'producer-fixture-provenance.json'),JSON.stringify({recordedAt:new Date().toISOString(),source:'src/scripts/fixtures/launchpad-fixed-refund.json',sourceSha256:f.fixtureSha256,network:'testnet',simulation:'Actual untransformed Sandbox code, testnet ledger projection; archive seqno1 identifies captured trace only',cases:Object.keys(cases)},null,2)+'\n');
  }
  console.log(`Launchpad refund: authentic exact cash+state proof, ${Object.keys(cases).length} adversarial cases, pending identity/credit, early archive-gap stable claim marker, four unsupported protocol transfers and ordinary control passed.`);
}
if(require.main===module)testLaunchpadRefunds().catch(e=>{console.error(e);process.exitCode=1;});

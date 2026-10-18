import assert from 'node:assert/strict';
import { Address, Cell, beginCell, loadTransaction, storeTransaction, type Transaction } from '@ton/core';
import type { RawTransaction } from '../data/dataSource';
import { decodeOriginalTransaction } from '../data/transactionEvidence';
import { PoolTracker } from '../poolTracker';
import { currentPoolFactoryFixture } from './support/currentPoolFactoryFixture';

export function testCurrentPoolTracker(fixture=currentPoolFactoryFixture()) {
  const {cases}=fixture;let checks=0;
  const test=(name:string,fn:()=>void)=>{fn();checks++;console.log('PASS current PoolTracker:',name);};
  for(const {capture,raw,attempt} of cases)test(capture.name+': original accepted listing and duplicates',()=>{
    const tracker=new PoolTracker({DlmmPoolFactory:Address.parse(capture.factory).toString({bounceable:false})});
    tracker.observeTransactions([attempt]);assert.equal(tracker.getPoolCount(),0);
    tracker.observeTransactions([raw,raw]);assert.equal(tracker.getPoolCount(),1);
  });
  const {capture,raw,parsed}=cases[0];
  const rejected=(tx:RawTransaction,registry={DlmmPoolFactory:capture.factory})=>{
    const tracker=new PoolTracker(registry);tracker.observeTransactions([tx]);assert.equal(tracker.getPoolCount(),0);
  };
  // Adversarial cells below are explicitly synthetic. Positive fixtures retain
  // the full original factory and pool transaction/account boundaries.
  const changed=(edit:(tx:Transaction)=>void)=>{
    const tx=loadTransaction(Cell.fromBase64(raw.rawBoc!).beginParse());edit(tx);
    return decodeOriginalTransaction(beginCell().store(storeTransaction(tx)).endCell(),Address.parse(capture.factory));
  };
  test('registry pool aliases deduplicate and unrelated roles stay excluded',()=>{
    const alias=Address.parse(capture.pool).toString({bounceable:false});
    const tracker=new PoolTracker({DlmmPoolFactory:capture.factory,DlmmPool:capture.pool,Market0Pool:alias,Spot0Pool:alias,
      UnrelatedPoolFactory:capture.factory,PoolRegistry:capture.factory,StrangePool:capture.factory,Market01Pool:capture.factory,Market1Pool:'invalid'});
    tracker.observeTransactions([raw]);assert.equal(tracker.getFactoryCount(),1);assert.equal(tracker.getPoolCount(),1);
  });
  test('missing or mismatched original transaction identity is unavailable',()=>{
    for(const patch of [{rawBoc:undefined},{rawBoc:'invalid'},{hash:Buffer.alloc(32,9).toString('base64')},{lt:'1'},{prevTransactionHash:Buffer.alloc(32,8).toString('base64')}])rejected({...raw,...patch});
  });
  test('VM/action errors and aborted or destroyed callbacks ignore successful summaries',()=>{
    for(const mode of ['compute','action','invalid','aborted','destroyed']){
      const tx=changed(t=>{const d=t.description;assert(d.type==='generic'&&d.computePhase.type==='vm'&&d.actionPhase);
        if(mode==='compute'){d.computePhase.success=false;d.computePhase.exitCode=3107;}
        else if(mode==='action'){d.actionPhase.success=false;d.actionPhase.resultCode=37;}
        else if(mode==='invalid')d.actionPhase.valid=false;
        else if(mode==='aborted')d.aborted=true;else d.destroyed=true;});
      rejected({...tx,success:true,status:'success'});
    }
  });
  test('successful ignored READY without exactly one original PoolListed is not discovery',()=>{
    rejected(changed(t=>{t.outMessages.clear();t.outMessagesCount=0;}));
    rejected(changed(t=>{const m=t.outMessages.values()[0];t.outMessages.set(1,m);t.outMessagesCount=2;}));
  });
  test('original listing must match factory, pool and exact PoolId',()=>{
    assert.throws(()=>changed(t=>{const m=t.outMessages.values()[0];assert(m.info.type==='external-out');m.info.src=Address.parse('0:'+'9'.repeat(64));}),/output source/);
    for(const mode of ['pool','id','opcode','trailing'])rejected(changed(t=>{
      const m=t.outMessages.values()[0];assert(m.info.type==='external-out');
      const s=m.body.beginParse();s.loadUint(32);const pool=s.loadAddress(),id=s.loadRef();s.endParse();
      m.body=beginCell().storeUint(mode==='opcode'?0x504c5332:0x504c5333,32)
        .storeAddress(mode==='pool'?Address.parse('0:'+'8'.repeat(64)):pool).storeRef(mode==='id'?beginCell().endCell():id)
        .storeUint(mode==='trailing'?1:0,mode==='trailing'?1:0).endCell();
    }));
  });
  test('factory receiver comes from original evidence',()=>{
    rejected(raw,{DlmmPoolFactory:'0:'+'9'.repeat(64)});
    const tracker=new PoolTracker({UnrelatedPoolFactory:capture.factory});tracker.observeTransactions([raw]);assert.equal(tracker.getPoolCount(),0);
    rejected({...cases[0].attempt,inMessage:{...raw.inMessage}});
    const valid=new PoolTracker({DlmmPoolFactory:capture.factory});valid.observeTransactions([{...raw,inMessage:{...raw.inMessage,op:0,source:'0:'+'9'.repeat(64),body:''}}]);assert.equal(valid.getPoolCount(),1);
  });
  test('bounced callbacks and retired wire formats are refused',()=>{
    rejected(changed(t=>{assert(t.inMessage!.info.type==='internal');t.inMessage!.info.bounced=true;}));
    for(const op of [0x44504441,0x4c50000a,0x444c4350,0x44504f4c])rejected(changed(t=>{t.inMessage!.body=beginCell().storeUint(op,32).endCell();}));
  });
  test('current READY and PoolId reject missing, trailing and invalid fields',()=>{
    const s=parsed.inMessage!.body.beginParse();s.loadUint(32);const id=s.loadRef(),notify=s.loadMaybeAddress();s.endParse();
    const body=(value:Cell)=>beginCell().storeUint(0x50524459,32).storeRef(value).storeAddress(notify).endCell();
    const ids=[beginCell().endCell(),beginCell().storeSlice(id.beginParse()).storeBit(true).endCell()];
    const p=id.beginParse(),root=p.loadAddress();p.loadUint(16);const rest=beginCell().storeSlice(p).endCell();
    ids.push(beginCell().storeAddress(root).storeUint(0,16).storeSlice(rest.beginParse()).endCell());
    const malformed=[beginCell().endCell(),beginCell().storeSlice(parsed.inMessage!.body.beginParse()).storeBit(true).endCell(),...ids.map(body)];
    for(const value of malformed)rejected(changed(t=>{t.inMessage!.body=value;}));
  });
  console.log(`Current PoolTracker: ${checks} original acceptance and adversarial boundary checks passed`);return checks;
}
if(require.main===module)testCurrentPoolTracker(currentPoolFactoryFixture(process.argv[2]));

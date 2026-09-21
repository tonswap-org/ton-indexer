import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beginCell, Cell, Dictionary, loadShardAccount, loadTransaction } from '@ton/core';
import { PGlite } from '@electric-sql/pglite';
import { readHistoricalJettonRoot, readHistoricalPrecisionContent, resolveHistoricalJettonPrecision, validateHistoricalJettonPrecision, type HistoricalRootArchive } from '../ledger/jettonPrecision';
import { canonicalLedgerHash, normalizeLedgerEvent } from '../ledger/normalize';
import { loadOpcodes } from '../utils/opcodes';
import { parseLedgerMarketBindings } from '../config/ledgerMarkets';
import { DlmmMarketGraphBuilder } from '../ledger/marketGraph';
import { projectDlmmMarket } from '../ledger/marketProjection';
import { PostgresMarketStore, validateMarketProjection } from '../ledger/marketStore';
import { PostgresLedgerStore, type LedgerSqlPool } from '../ledger/store';
import type { LedgerService } from '../ledger/service';
import type { TonDataSource, AccountStateResponse } from '../data/dataSource';
import type { DlmmMarketBinding } from '../ledger/marketTypes';
const fixturePath=resolve(__dirname,'fixtures/dlmm-referral-market-current/dlmm-market-precision.json');
const f=JSON.parse(readFileSync(fixturePath,'utf8'));
const source='contracts/shared/jetton/jetton_root.tolk';
const rootCodeHash=f.compiler.find((c:{entrypointFileName:string})=>c.entrypointFileName===source).codeHash;
const walletCodeHash=f.compiler.find((c:{entrypointFileName:string})=>c.entrypointFileName.endsWith('/jetton_wallet.tolk')).codeHash;
const binding:DlmmMarketBinding={network:'localnet',pool:f.accounts.pool,tokenT:f.accounts.tokenT,tokenX:f.accounts.tokenX,tokenTCodeHash:rootCodeHash,tokenXCodeHash:rootCodeHash,walletCodeHash,poolCodeHash:f.compiler.find((c:{entrypointFileName:string})=>c.entrypointFileName.endsWith('/dlmm/pool.tolk')).codeHash};
const rootState=(root:string)=>f.boundaries.filter((b:{account:string})=>b.account===root).at(-1).after as AccountStateResponse;
const acceptance=f.transactions.find((t:{account:string;phase:string;raw:{inMessage?:{op?:number}}})=>t.account===binding.pool && t.phase==='full-t-to-x' && t.raw.inMessage?.op===0x7362d09c).raw;
const execution={account:binding.pool,lt:acceptance.lt,hash:acceptance.hash,utime:acceptance.utime};
const rootBinding={network:'localnet' as const,root:binding.tokenT,rootCodeHash,walletCodeHash};
const archived=(state:AccountStateResponse):HistoricalRootArchive=>({kind:'masterchain-execution-bracket',provider:'configured-ton-data-source',observedAt:'2026-09-11T00:00:00.000Z',executionSeqno:50,before:{seqno:49,state:structuredClone(state)},after:{seqno:50,state:structuredClone(state)}});
const key=(s:string)=>createHash('sha256').update(s).digest();
const snake=(s:string)=>beginCell().storeUint(0,8).storeStringTail(s).endCell();
const onchain=(values:Record<string,Cell>)=>{const dict=Dictionary.empty(Dictionary.Keys.Buffer(32),Dictionary.Values.Cell());for(const [k,v]of Object.entries(values))dict.set(key(k),v);return beginCell().storeUint(0,8).storeDict(dict).endCell();};
function withContent(state:AccountStateResponse,content:Cell) {const root=Cell.fromBase64(state.dataBoc!),data=root.refs[1],changed=beginCell().storeBits(data.bits).storeRef(data.refs[0]).storeRef(content).endCell();return {...state,dataBoc:beginCell().storeBits(root.bits).storeRef(root.refs[0]).storeRef(changed).storeRef(root.refs[2]).storeRef(root.refs[3]).endCell().toBoc().toString('base64')};}
let checks=0;function test(name:string,fn:()=>void){fn();checks++;console.log('PASS',name);}
test('authentic deployed root metadata explicitly records6 and9 with unchanged code and original state cells',()=>{
 assert.equal(readHistoricalPrecisionContent(readHistoricalJettonRoot(rootState(binding.tokenT).dataBoc!).content).decimals,6);
 assert.equal(readHistoricalPrecisionContent(readHistoricalJettonRoot(rootState(binding.tokenX).dataBoc!).content).decimals,9);
 let roots=0,unconfigured=0;
 for(const row of f.transactions) {
  if(![binding.tokenT,binding.tokenX].includes(row.account))continue;const boundary=f.boundaries.find((b:{account:string;transactionHash:string})=>b.account===row.account&&b.transactionHash===row.raw.hash);
  const tx=loadTransaction(Cell.fromBase64(row.transactionBoc).beginParse());assert.equal(tx.hash().toString('hex'),row.raw.hash);
  const shard=loadShardAccount(Cell.fromBase64(boundary.after.shardAccountBoc).beginParse());assert.equal(Cell.fromBase64(boundary.after.shardAccountBoc).refs[0].hash().toString('hex'),tx.stateUpdate.newHash.toString('hex'));
  if(shard.account?.storage.state.type==='active') {assert.equal(shard.account.storage.state.state.code!.hash().toString('hex'),rootCodeHash);assert.equal(shard.account.storage.state.state.data!.hash().toString('hex'),Cell.fromBase64(boundary.after.dataBoc).hash().toString('hex'));}
  const data=Cell.fromBase64(boundary.after.dataBoc);
  if(data.bits.length===32 && data.refs.length===4 && data.beginParse().preloadUint(32)===0x4a545253){readHistoricalJettonRoot(boundary.after.dataBoc);roots++;}
  else {assert.throws(()=>readHistoricalJettonRoot(boundary.after.dataBoc));unconfigured++;}
 }assert(roots>=10);assert.equal(unconfigured,2,'initial deployment config is evidence, not an admitted execution-era writer layout');
});
test('root code bindings are mandatory canonical deployment inputs',()=>{assert.deepEqual(parseLedgerMarketBindings(JSON.stringify([binding]),'localnet'),[binding]);for(const key of ['tokenTCodeHash','tokenXCodeHash'] as const){const missing={...binding} as Partial<DlmmMarketBinding>;delete missing[key];assert.throws(()=>parseLedgerMarketBindings(JSON.stringify([missing]),'localnet'));assert.throws(()=>parseLedgerMarketBindings(JSON.stringify([{...binding,[key]:'current-rpc'}]),'localnet'));}});
test('explicit archived precision has source/content/field proof and does not require equality of cross-account logical times',()=>{
 const archive=archived(rootState(binding.tokenT));const known=resolveHistoricalJettonPrecision(rootBinding,execution,archive);assert.equal(known.status,'resolved');assert.equal(known.decimals,6);assert.equal(known.method,'onchain-explicit');assert.equal(known.content!.decimalsText,'6');assert(known.content!.decimalsFieldBoc);assert.equal(known.archive!.executionSeqno,50);validateHistoricalJettonPrecision(known,rootBinding,execution);
 const altered=structuredClone(known);altered.decimals=9;assert.throws(()=>validateHistoricalJettonPrecision(altered,rootBinding,execution));
});
for(const value of ['0','6','9','18','255'])test(`TEP64 explicit ${value}`,()=>{const result=readHistoricalPrecisionContent(onchain({decimals:snake(value)}));assert.equal(result.decimals,Number(value));assert.equal(result.method,'onchain-explicit');});
test('valid fully on-chain omission admits sourced TEP64 default9 only',()=>{const known=readHistoricalPrecisionContent(onchain({symbol:snake('LOCAL')}));assert.equal(known.decimals,9);assert.equal(known.method,'tep64-default');});
test('on-chain value overrides URI content without fetching it',()=>{const known=readHistoricalPrecisionContent(onchain({decimals:snake('6'),uri:snake('https://mutable.invalid/token.json')}));assert.equal(known.decimals,6);assert.equal(known.content.uri,'https://mutable.invalid/token.json');assert.equal(known.content.layout,'semichain');});
test('URI-only and semi-chain absent precision never infer9 or use a current remote document',()=>{for(const cell of [beginCell().storeUint(1,8).storeStringTail('https://mutable.invalid/token.json').endCell(),onchain({uri:snake('https://mutable.invalid/token.json')})]) {const result=readHistoricalPrecisionContent(cell);assert.equal(result.decimals,null);assert.equal(result.issue,'metadata_remote_precision_unverified');}});
test('chunked TEP64 value uses exact ordered chunks',()=>{const chunks=Dictionary.empty(Dictionary.Keys.Uint(32),Dictionary.Values.Cell());for(const [i,v] of ['2','5','5'].entries())chunks.set(i,beginCell().storeStringTail(v).endCell());const cell=beginCell().storeUint(1,8).storeDict(chunks).endCell();assert.equal(readHistoricalPrecisionContent(onchain({decimals:cell})).decimals,255);chunks.delete(1);assert.equal(readHistoricalPrecisionContent(onchain({decimals:beginCell().storeUint(1,8).storeDict(chunks).endCell()})).decimals,null);});
for(const value of ['', '256','-1','6.0','1e1',' 6','6 ','NaN','0000'])test(`malformed decimals ${JSON.stringify(value)} does not become a default`,()=>{assert.equal(readHistoricalPrecisionContent(onchain({decimals:snake(value)})).decimals,null);});
test('empty content, missing dictionary bit, empty URI and prefix-free legacy field stay unresolved',()=>{for(const cell of [Cell.EMPTY,beginCell().storeUint(0,8).endCell(),beginCell().storeUint(1,8).endCell(),onchain({decimals:beginCell().storeStringTail('9').endCell()})])assert.equal(readHistoricalPrecisionContent(cell).decimals,null);});
test('root writer arity/trailing fields reject instead of probing obsolete shapes',()=>{const good=Cell.fromBase64(rootState(binding.tokenT).dataBoc!);for(const bad of [good.refs[1],beginCell().storeBits(good.bits).storeBit(0).storeRef(good.refs[0]).storeRef(good.refs[1]).storeRef(good.refs[2]).storeRef(good.refs[3]).endCell(),beginCell().storeBits(good.bits).storeRef(good.refs[0]).storeRef(good.refs[1]).storeRef(good.refs[2]).endCell()])assert.throws(()=>readHistoricalJettonRoot(bad.toBoc().toString('base64')));});
const negatives:Array<[string,(a:HistoricalRootArchive)=>void]>=[
 ['nonadjacent block',a=>{a.before.seqno=48;}],['missing containing block',a=>{a.executionSeqno=51;}],['wrong code',a=>{a.after.state.codeBoc=Cell.EMPTY.toBoc().toString('base64');}],['missing data',a=>{a.before.state.dataBoc=null;}],['frozen root',a=>{a.before.state.accountState='frozen';}],['empty transaction identity',a=>{a.before.state.lastTxLt='0';}],['malformed hash',a=>{a.before.state.lastTxHash='!'+a.before.state.lastTxHash;}],['malformed time',a=>{a.observedAt='yesterday';}],['content conflict',a=>{a.after.state=withContent(a.after.state,onchain({decimals:snake('9')}));}],
];
for(const [label,mutate]of negatives)test(`archive rejects ${label}`,()=>{const a=archived(rootState(binding.tokenT));mutate(a);assert.equal(resolveHistoricalJettonPrecision(rootBinding,execution,a).status,'unresolved');});
test('execution identity cannot be malformed or rebound',()=>{for(const change of [{hash:'bad'},{account:'friendly'},{lt:'-1'},{utime:NaN}])assert.equal(resolveHistoricalJettonPrecision(rootBinding,{...execution,...change},archived(rootState(binding.tokenT))).status,'unresolved');});
test('missing archive and malformed metadata preserve unresolved precision explicitly',()=>{assert.equal(resolveHistoricalJettonPrecision(rootBinding,execution,null).status,'unresolved');const bad=withContent(rootState(binding.tokenT),Cell.EMPTY);const result=resolveHistoricalJettonPrecision(rootBinding,execution,archived(bad));assert.equal(result.decimals,null);assert(result.content?.contentHash);});
async function graphAndStorage(){
 const db=new PGlite(),pool={query:(sql:string,args?:unknown[])=>args?db.query(sql,args):sql.includes(';')?db.exec(sql).then(rows=>({rows:rows.at(-1)?.rows??[]})):db.query(sql),connect:async()=>pool,end:()=>db.close()} as unknown as LedgerSqlPool;
 const store=new PostgresLedgerStore(pool);await store.initialize();const opcodes=loadOpcodes();
 try {
  for(const account of new Set<string>(f.transactions.map((t:{account:string})=>t.account))){const raws=f.transactions.filter((t:{account:string})=>t.account===account).map((t:{raw:unknown})=>t.raw),head=raws.at(-1),generation=randomUUID();await store.begin('localnet',account,generation,{lt:head.lt,hash:canonicalLedgerHash(head.hash)},new Date((head.utime+60)*1000).toISOString());await store.append(generation,await Promise.all(raws.map((raw:Parameters<typeof normalizeLedgerEvent>[2])=>normalizeLedgerEvent('localnet',account,raw,opcodes))),raws);await store.complete('localnet',account,generation);}
  // Original executor account cells are authenticated above. Masterchain sequence
  // labels here model only the archive adapter, not a real network block proof.
  for(const b of f.boundaries)for(const value of [b.before,b.after]){const state={...value,accountState:value.accountState==='uninit'?'uninitialized':value.accountState};await pool.query('INSERT INTO ledger_account_states(network,account,lt,hash,snapshot) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING',['localnet',b.account,state.lastTxLt,canonicalLedgerHash(state.lastTxHash),JSON.stringify({seqno:50,state})]);}
  const reads:Array<[string,number]>=[];const source={network:'localnet',getAccountStateAtSeqno:async(root:string,seqno:number)=>{assert([binding.tokenT,binding.tokenX].includes(root));assert([49,50].includes(seqno));reads.push([root,seqno]);return structuredClone(rootState(root));}} as unknown as TonDataSource;
  const ledger={network:'localnet',store,syncAccount:async()=>true} as unknown as LedgerService;
  const graph=await new DlmmMarketGraphBuilder(ledger,source).build(binding);const result=projectDlmmMarket(binding,graph.nodes,graph.dependencies);assert.equal(result.observations.length,5);assert.equal(result.historyComplete,true);assert.deepEqual(result.observations.map(o=>[o.assetPrecision.input.decimals,o.assetPrecision.output.decimals]),[[6,9],[9,6],[6,9],[6,9],[6,9]]);assert.equal(reads.length,4,'each root/block query is shared across all observations');
  validateMarketProjection(result);
  for(const mutate of [
   (p:typeof result)=>{p.observations[0].assetPrecision.input.decimals=18;},
   (p:typeof result)=>{const a=p.observations[0].assetPrecision.input.archive!;a.before.seqno=59;a.after.seqno=60;a.executionSeqno=60;},
   (p:typeof result)=>{p.observations[0].assetPrecision.input.execution.hash='0'.repeat(64);},
   (p:typeof result)=>{p.observations[0].assetPrecision.input.root=binding.tokenX;},
   (p:typeof result)=>{delete (p.observations[0] as Partial<typeof p.observations[0]>).assetPrecision;},
  ]){const altered=structuredClone(result);mutate(altered);assert.throws(()=>validateMarketProjection(altered));}
  const market=new PostgresMarketStore(pool);await market.publish(result,null);const page=await market.page('localnet',binding.pool);assert.equal(page.observations.length,5);assert.equal(page.observations[0].assetPrecision.input.status,'resolved');
  const before=reads.length;await new DlmmMarketGraphBuilder(ledger,source).build(binding);assert.equal(reads.length,before,'archived root cells are durable and reused by a new graph builder');
  const unchanged=JSON.stringify(page.observations);const editedPage=await market.page('localnet',binding.pool);editedPage.observations[0].assetPrecision.input.archive!.before.state.dataBoc='bad';assert.equal(JSON.stringify((await market.page('localnet',binding.pool)).observations),unchanged,'returned precision cannot mutate immutable stored observation');
  const unavailable=projectDlmmMarket(binding,graph.nodes.map(n=>({...n,assetPrecision:undefined})),graph.dependencies);assert.equal(unavailable.observations.length,5);assert.equal(unavailable.observations[0].assetPrecision.input.status,'unresolved');
  validateMarketProjection(unavailable);
  await pool.query('DELETE FROM market_root_archive_states');
  const missingSource={network:'localnet',getAccountStateAtSeqno:async()=>{throw Error('archive unavailable');}} as unknown as TonDataSource;
  const missingGraph=await new DlmmMarketGraphBuilder(ledger,missingSource).build(binding);const missing=projectDlmmMarket(binding,missingGraph.nodes,missingGraph.dependencies);assert.equal(missing.observations.length,5);assert.equal(missing.historyComplete,true);assert(missing.observations.every(o=>o.assetPrecision.input.status==='unresolved'&&o.assetPrecision.output.status==='unresolved'));validateMarketProjection(missing);
  // Simulate another publisher winning the same root/block insert. The graph
  // must return the winning immutable archive bytes, never the losing response.
  const racingSource={network:'localnet',getAccountStateAtSeqno:async(root:string,seqno:number)=>{const state=rootState(root);await pool.query('INSERT INTO market_root_archive_states(network,root,seqno,snapshot,observed_at) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT DO NOTHING',['localnet',root,seqno,JSON.stringify(state),'2026-09-11T00:00:00.000Z']);return withContent(state,onchain({decimals:snake('18')}));}} as unknown as TonDataSource;
  const racingGraph=await new DlmmMarketGraphBuilder(ledger,racingSource).build(binding),racing=projectDlmmMarket(binding,racingGraph.nodes,racingGraph.dependencies);assert.deepEqual(racing.observations.map(o=>[o.assetPrecision.input.decimals,o.assetPrecision.output.decimals]),[[6,9],[9,6],[6,9],[6,9],[6,9]]);validateMarketProjection(racing);
  if(process.env.MARKET_PRECISION_EXPORT_DIR){const dir=process.env.MARKET_PRECISION_EXPORT_DIR;writeFileSync(resolve(dir,'resolved-market-page.json'),JSON.stringify(page,null,2)+'\n');writeFileSync(resolve(dir,'resolved-market-projection.json'),JSON.stringify(result,null,2)+'\n');}
  console.log('PASS authentic6/9 graph→exact projection→PostgreSQL roundtrip, four pinned root reads, durable archive reuse and atomic execution preservation');checks++;
 } finally {await pool.end();}
}
graphAndStorage().then(()=>console.log(`Passed ${checks} historical precision checks`)).catch(error=>{console.error(error);process.exitCode=1;});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { Address, Cell, loadTransaction } from '@ton/core';
import { decodeOriginalTransaction } from '../data/transactionEvidence';
import { projectOwnerLedger, type ProjectionInput, type LedgerChain } from '../ledger/project';
import { canonicalLedgerHash } from '../ledger/normalize';
import { loadOpcodes } from '../utils/opcodes';
import { perpsWalletAddress } from '../ledger/perpsWire';
import { assertPerpsStressChainConfig, producerSha256, readPerpsProducerReceipt } from './perps-fixture-producer';

// Replay only original current Sandbox bytes. The producer and all supplied
// before/after boundaries remain separate from live archive-range qualification.
const captureRoot=process.argv[2], output=process.argv[3];
assert(captureRoot && resolve(captureRoot)===captureRoot && output && resolve(output)===output && !existsSync(output) && !process.argv[4],
  'Usage: export-perps-browser-evidence.ts <absolute-qualified-browser-producer> <new-absolute-projection-directory>');
assert.equal(process.version,'v26.5.1'); assert(process.execArgv.includes('--no-turbo-fast-api-calls'));
assert(!process.env.NODE_OPTIONS);
const receipt=readPerpsProducerReceipt(captureRoot,'browser',resolve(__dirname,'../../../tonswap_tolk'));
const indexerRoot=resolve(__dirname,'../..');
const inventory=()=>{
 const files:Record<string,string>={};
 const visit=(folder:string)=>{for(const entry of readdirSync(folder,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  const path=join(folder,entry.name);if(entry.isDirectory())visit(path);
  else if(entry.isFile()&&path.endsWith('.ts'))files[relative(indexerRoot,path)]=producerSha256(readFileSync(path));
 }};
 visit(join(indexerRoot,'src'));
 for(const name of ['package.json','package-lock.json','tsconfig.json'])files[name]=producerSha256(readFileSync(join(indexerRoot,name)));
 return files;
};
const sourceBefore=inventory();
const provenance={engineCodeHash:receipt.compiled.PerpsEngine.codeHash,poolCodeHash:receipt.compiled.DlmmPool.codeHash,
 walletCodeHash:receipt.compiled.JettonWallet.codeHash,riskVaultCodeHash:receipt.compiled.RiskVault.codeHash,
 riskControllerCodeHash:receipt.compiled.RiskController.codeHash};
mkdirSync(output,{mode:0o700});


// Unmodified raw transactions and before/after storage emitted by the actual
// Tolk engine, DLMM, RiskVault, RiskController and owner/product T3 wallets.
function fixture(name: string) {
  const bytes = readFileSync(join(captureRoot, `${name}.json`));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.artifacts[`${name}.json`],
    'Every execution case identifies its unchanged original capture');
  const f = JSON.parse(bytes.toString('utf8'));
  assertPerpsStressChainConfig(f.chainConfig);
  assert.equal(Cell.fromBase64(f.riskVaultCode).hash().toString('hex'),provenance.riskVaultCodeHash);
  assert.equal(Cell.fromBase64(f.riskControllerCode).hash().toString('hex'),provenance.riskControllerCodeHash);
  for (const key of ['engine', 'owner', 'pool', 'root', 'riskVault', 'riskController']) f[key] = Address.parse(f[key]).toRawString();
  f.ownerWallet = perpsWalletAddress(Cell.fromBase64(f.walletCode), f.root, f.owner);
  f.engineWallet = perpsWalletAddress(Cell.fromBase64(f.walletCode), f.root, f.engine);
  f.rvWallet = perpsWalletAddress(Cell.fromBase64(f.walletCode), f.root, f.riskVault);
  const code = new Map<string, string>([...Object.entries(f.accountCodes as Record<string, string>), [f.engine, f.engineCode], [f.riskVault, f.riskVaultCode], [f.riskController, f.riskControllerCode], [f.pool, f.poolCode],
    [f.ownerWallet, f.walletCode], [f.engineWallet, f.walletCode], [f.rvWallet, f.walletCode]]);
  const rows = f.transactions.map((saved: any) => {
    const cell = Cell.fromBase64(saved.transaction), tx = loadTransaction(cell.beginParse());
    const account = `0:${tx.address.toString(16).padStart(64, '0')}`;
    return { ...saved, account, raw: decodeOriginalTransaction(cell, Address.parse(account)) };
  });
  const captured = new Map(rows.map((row: any) => [`${row.account}:${row.raw.lt}`, row.raw.hash]));
  assert.equal(captured.size, rows.length, 'Each original transaction is captured once');
  for (const row of rows) {
    const prior = captured.get(`${row.account}:${row.raw.prevTransactionLt}`);
    // Traces are explicitly bounded, so a predecessor may precede the capture.
    // Where both cells are present, reserialization cannot replace original bytes.
    if (prior) assert.equal(canonicalLedgerHash(row.raw.prevTransactionHash), canonicalLedgerHash(prior as string), 'Captured raw BOCs retain original account hash links');
  }
  const accounts=new Set(rows.map((r:any)=>r.account));
  for(const account of accounts){const ordered=rows.filter((r:any)=>r.account===account).sort((a:any,b:any)=>BigInt(a.raw.lt)<BigInt(b.raw.lt)?-1:1);
   for(let i=1;i<ordered.length;i++){assert.equal(ordered[i].raw.prevTransactionLt,ordered[i-1].raw.lt,'No omitted transaction inside captured per-account sequence');assert.equal(canonicalLedgerHash(ordered[i].raw.prevTransactionHash),canonicalLedgerHash(ordered[i-1].raw.hash),'Exact original account-chain linkage');}
  }
  const fromUtime = Math.min(...rows.map((row: any) => row.raw.utime)), toUtime = Math.max(...rows.map((row: any) => row.raw.utime)) + 1;
  const chains = new Map<string, LedgerChain>();
  const states = new Map<string, any>();
  const key = (account: string, lt: string, hash: string) => `${account}:${lt}:${canonicalLedgerHash(hash)}`;
  for (const row of rows) {
    const chain: LedgerChain = chains.get(row.account) ?? { account: row.account, generation: 'real-tolk-oracle', historyComplete: false,
      verifiedRange: { fromUtime, toUtime }, role: row.account === f.owner ? 'owner' : row.account === f.ownerWallet ? 'owned_jetton_wallet' : 'counterparty', transactions: [] };
    chain.transactions.push(row.raw); chains.set(row.account, chain);
    if (code.has(row.account)) {
      for (const [lt, hash, data] of [[row.raw.prevTransactionLt, row.raw.prevTransactionHash, row.oldStorage], [row.raw.lt, row.raw.hash, row.newStorage]]) {
        if (!data) continue; // No invented active historical state for an uninitialized account.
        const identity = key(row.account, lt, hash);
        const snapshot = { seqno: Number(BigInt(lt) / 1000000n), state: { accountState: 'active', codeBoc: code.get(row.account), dataBoc: data,
          lastTxLt: lt, lastTxHash: canonicalLedgerHash(hash) } };
        if (states.has(identity)) assert.equal(states.get(identity).state.dataBoc, data, 'Adjacent real engine boundaries must agree');
        states.set(identity, snapshot);
      }
    }
  }
  const wallets = new Map([f.ownerWallet, f.engineWallet, f.rvWallet].map(wallet => [wallet, { kind: 'jetton' as const,
    id: `localnet:jetton:${f.root}`, master: f.root, owner: wallet === f.ownerWallet ? f.owner : wallet === f.rvWallet ? f.riskVault : f.engine, wallet, decimals: 9 }]));
  const engineCodeHash = Cell.fromBase64(f.engineCode).hash().toString('hex');
  assert.equal(engineCodeHash, provenance.engineCodeHash, 'Every execution fixture must use the same current compiled runtime identity');
  assert.equal(Cell.fromBase64(f.walletCode).hash().toString('hex'), provenance.walletCodeHash, 'Every execution fixture must use the qualified current wallet identity');
  assert.equal(Cell.fromBase64(f.poolCode).hash().toString('hex'), f.runtimeIdentities.find((r:any)=>r.role==='pool').codeHash, 'Pool state uses its actual captured code');
  if(name !== 'open-expired') assert.equal(Cell.fromBase64(f.poolCode).hash().toString('hex'), provenance.poolCodeHash);
  else assert.notEqual(Cell.fromBase64(f.poolCode).hash().toString('hex'), provenance.poolCodeHash, 'Expiry fault target is honestly identified as the actual nonreplying Sandbox treasury');
  const input: ProjectionInput = { network: 'localnet', owner: f.owner, chains, wallets, pools: new Map(), opcodes: loadOpcodes(),
    stateAt: async (account, lt, hash) => states.get(key(account, lt, hash)) ?? null,
    perpsEngines: new Map([[f.engine, { address: f.engine, root: f.root, codeHash: engineCodeHash,
      walletCodeHash: Cell.fromBase64(f.walletCode).hash().toString('hex'), ownerWallet: f.ownerWallet, engineWallet: f.engineWallet }]]) };
  return { f, rows, states, input, engineCodeHash };
}
async function main() {
 const summaries:any[]=[];
 const files:Record<string,string>={}, staged=new Map<string,Buffer>();
 for(const name of ['open-rejected','open-expired','close-rejected','close-accepted','open-fee-excess']){
  const {f,input,rows,engineCodeHash}=fixture(name);
  const result=await projectOwnerLedger(input);
  const events=result.events.filter(e=>e.kind==='perps_operation');
  assert.equal(events.length,1,`${name}: exactly one original operation required`);
  const event=events[0];assert(event.settlement?.perps,`${name}: original projected perps evidence absent`);
  const meta=event.settlement.perps;
  assert.equal(event.settlement.status,'confirmed',`${name}: ${JSON.stringify(meta)}`);
  assert(meta.oracleExecution?.completed,`${name}: actual completion required`);
  assert.notEqual(meta.oracleExecution.completed.lt,meta.oracleExecution.queued.lt);
  assert.deepEqual(meta.stateEvidence?.transactions,[meta.oracleExecution.completed]);
  assert.deepEqual(meta.oracleExecution.intakeEvidence?.transactions,[meta.oracleExecution.queued]);
  if(name==='open-rejected'||name==='open-expired'||name==='close-rejected'){
   assert.equal(meta.outcome,'rejected');assert.equal(meta.oracleExecution.status,'rejected');
   assert.equal(meta.oracleExecution.reason, name==='open-rejected'?1:name==='open-expired'?3:2);
   if(name==='close-rejected'){
    assert.deepEqual(meta.before,meta.after,'Failed limit preserves the actual original funded position');
    assert.equal(meta.payout.status,'none');assert.equal(meta.payout.amountRaw,'0');
   }else{
    assert.equal(meta.payout.status,'completed');assert.equal(meta.payout.amountRaw,meta.depositRaw);
    assert.equal(meta.depositRaw,'3000000000');
   }
   if(name==='open-expired')assert(meta.oracleExecution.completed.utime>=meta.oracleExecution.queued.utime+300);
  }else{
   assert.equal(meta.outcome,'accepted');assert.equal(meta.oracleExecution.status,'accepted');assert.equal(meta.oracleExecution.reason,0);
   assert.equal(meta.payout.status,'completed');
   if(name==='close-accepted'){
    assert.equal(meta.economics?.realizedPnlRaw,'-800000');assert.equal(meta.payout.amountRaw,'2999200000');
    assert.equal(meta.economics?.tradeFeeRaw,'0');assert.equal(meta.counterpartyPayout.status,'none');
   }else{
    assert.equal(meta.economics?.tradeFeeRaw,'3001200');assert.equal(meta.economics?.excessRaw,'113');
    assert.equal(meta.payout.amountRaw,'113');assert.equal(meta.depositRaw,'3003001313');
    assert(meta.oracleExecution.admission,'Original current funded admission graph required');
    const debits=event.movements.filter(m=>m.asset.kind==='jetton'&&['out','fee'].includes(m.direction));
    assert.equal(debits.reduce((sum,m)=>sum+BigInt(m.amountRaw),0n).toString(),meta.depositRaw);
   }
  }
  const filename=name+'-ledger.json',bytes=Buffer.from(JSON.stringify({...f,events:result.events},null,2)+'\n');
  writeFileSync(join(output,filename),bytes,{flag:'wx'});
  files[filename]=producerSha256(bytes);staged.set(filename,bytes);
  summaries.push({name,originalTransactions:rows.length,fromUtime:Math.min(...rows.map((r:any)=>r.raw.utime)),toUtime:Math.max(...rows.map((r:any)=>r.raw.utime))+1,engineCodeHash,txId:event.txId,outcome:meta.outcome,reason:meta.oracleExecution.reason,depositRaw:meta.depositRaw,payout:{status:meta.payout.status,amountRaw:meta.payout.amountRaw},economics:meta.economics,positionBefore:meta.before?.position,positionAfter:meta.after?.position,admission:meta.oracleExecution.admission,issues:event.issues});
  console.log('PASS',name,JSON.stringify(summaries.at(-1)));
 }
 assert.deepEqual(inventory(),sourceBefore,'Indexer source changed during projection; recapture');
 assert.deepEqual(readPerpsProducerReceipt(captureRoot,'browser',resolve(__dirname,'../../../tonswap_tolk')),receipt);
 const summary=Buffer.from(JSON.stringify(summaries,null,2)+'\n');
 writeFileSync(join(output,'projected-summary.json'),summary,{flag:'wx'});
 const producerLog=readFileSync(captureRoot+'.log');
 staged.set('producer.log',producerLog);staged.set('projected-summary.json',summary);
 staged.set('provenance.json',Buffer.from(JSON.stringify({
  kind:'Source-bound current VM15 stress400 original transactions and strict indexer projection; local evidence, not live history',
  scopeLimit:'Bounded original Sandbox account chains; no claim of native historical boundary or complete account-history coverage',
  producer:'tonswap_tolk/tests/perps/PerpsBrowserEvidence.spec.ts',projector:'ton-indexer/src/scripts/export-perps-browser-evidence.ts',
  ...provenance,files,producerReceipt:receipt,producerLogSha256:producerSha256(producerLog),
  projectedSummarySha256:producerSha256(summary),projectorSource:sourceBefore,
 },null,2)+'\n'));
 const target=resolve(__dirname,'../../../tonswap_web/tests/fixtures/perps-browser-current');
 mkdirSync(target,{recursive:true});for(const [name,bytes] of staged)writeFileSync(join(target,name),bytes);
 console.log('Adopted five qualified current Perps browser operation graphs');
}
main().catch(error=>{console.error(error);process.exitCode=1});

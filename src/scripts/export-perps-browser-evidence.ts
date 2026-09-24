import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Address, Cell, loadTransaction } from '@ton/core';
import { decodeOriginalTransaction } from '../data/transactionEvidence';
import { projectOwnerLedger, type ProjectionInput, type LedgerChain } from '../ledger/project';
import { canonicalLedgerHash } from '../ledger/normalize';
import { loadOpcodes } from '../utils/opcodes';
import { perpsWalletAddress } from '../ledger/perpsWire';

// Replay only original current Sandbox bytes. The producer and all supplied
// before/after boundaries remain separate from live archive-range qualification.
const captureRoot=process.env.BROWSER_CAPTURE_ROOT!;
assert(captureRoot && process.env.BROWSER_CAPTURE_PROVENANCE, 'Explicit current capture directory and provenance are required');
const provenance = JSON.parse(readFileSync(process.env.BROWSER_CAPTURE_PROVENANCE!, 'utf8'));


// Unmodified raw transactions and before/after storage emitted by the actual
// Tolk engine, DLMM, RiskVault, RiskController and owner/product T3 wallets.
function fixture(name: string) {
  const bytes = readFileSync(join(captureRoot, 'raw-qualified', `${name}.json`));
  const original = provenance.artifacts.find((entry: { relative: string }) => entry.relative === `${name}.json`);
  assert(original, 'Every execution case identifies its unchanged original capture');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), original.sha256);
  const f = JSON.parse(bytes.toString('utf8'));
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
 for(const name of (process.env.BROWSER_CAPTURE_CASES?.split(',') ?? ['open-rejected','open-expired','close-rejected','close-accepted','open-fee-excess'])){
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
  writeFileSync(join(captureRoot,'projected',name+'-ledger.json'),JSON.stringify({...f,events:result.events},null,2),{flag:'wx'});
  summaries.push({name,originalTransactions:rows.length,fromUtime:Math.min(...rows.map((r:any)=>r.raw.utime)),toUtime:Math.max(...rows.map((r:any)=>r.raw.utime))+1,engineCodeHash,txId:event.txId,outcome:meta.outcome,reason:meta.oracleExecution.reason,depositRaw:meta.depositRaw,payout:{status:meta.payout.status,amountRaw:meta.payout.amountRaw},economics:meta.economics,positionBefore:meta.before?.position,positionAfter:meta.after?.position,admission:meta.oracleExecution.admission,issues:event.issues});
  console.log('PASS',name,JSON.stringify(summaries.at(-1)));
 }
 writeFileSync(join(captureRoot,process.env.BROWSER_CAPTURE_SUMMARY??'projected-summary.json'),JSON.stringify(summaries,null,2),{flag:'wx'});
}
main().catch(error=>{console.error(error);process.exitCode=1});

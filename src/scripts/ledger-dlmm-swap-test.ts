import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Cell, beginCell, loadTransaction } from '@ton/core';
import { readDlmmMarketState } from '../ledger/dlmmState';
import { readT3RecoveryWallet } from '../ledger/t3RecoveryState';
import type { TonDataSource } from '../data/dataSource';
import { projectOwnerLedger, type LedgerChain, type ProjectionInput } from '../ledger/project';
import { canonicalLedgerHash } from '../ledger/normalize';
import { createDlmmProofGraph, type DlmmProofBinding } from '../ledger/dlmmProof';
import { verifyDlmmSwapExecution } from '../ledger/dlmmSwapProof';
import { tokenWire, protocolForward } from '../ledger/wire';
import type { MarketNode } from '../ledger/marketTypes';
import type { LedgerAsset, LedgerEvent, LedgerEvidenceRef } from '../ledger/types';
import { loadOpcodes } from '../utils/opcodes';
import { classifyTransaction } from '../utils/txClassifier';
import { IndexerService } from '../indexerService';
import { MemoryStore } from '../store/memoryStore';
import { loadConfig } from '../config';
import { ledgerSchemas } from '../ledger/openapi';

const opcodes = loadOpcodes();
const provenance = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/dlmm-referral-market-current/dlmm-swap.provenance.json'), 'utf8'));
const matches = (node: MarketNode, ref: Pick<LedgerEvidenceRef, 'account' | 'lt' | 'hash'>) => node.account === ref.account && node.raw.lt === ref.lt && canonicalLedgerHash(node.raw.hash) === canonicalLedgerHash(ref.hash);
function load(label: string) {
  const bytes = gunzipSync(readFileSync(resolve(__dirname, `fixtures/dlmm-referral-market-current/dlmm-swap-${label}.json.gz`)));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance[label].sha256);
  const fixture = JSON.parse(bytes.toString());
  const binding: DlmmProofBinding = { network: 'localnet', pool: fixture.accounts.pool, tokenT: fixture.accounts.tokenT, tokenX: fixture.accounts.tokenX,
    poolCodeHash: fixture.compiler.find((c: any) => c.entrypointFileName.endsWith('/dlmm/pool.tolk')).codeHash,
    walletCodeHash: fixture.compiler.find((c: any) => c.entrypointFileName.endsWith('/jetton/jetton_wallet.tolk')).codeHash };
  const nodes: MarketNode[] = fixture.transactions.map((entry: any) => {
    const tx = loadTransaction(Cell.fromBase64(entry.transactionBoc).beginParse());
    assert.equal(tx.hash().toString('hex'), entry.raw.hash, 'original transaction BOC');
    const boundary = fixture.boundaries.find((b: any) => b.account === entry.account && b.transactionLt === entry.raw.lt && b.transactionHash === entry.raw.hash);
    assert.equal(tx.stateUpdate.oldHash.toString('hex'), Cell.fromBase64(boundary.before.shardAccountBoc).refs[0].hash().toString('hex'));
    assert.equal(tx.stateUpdate.newHash.toString('hex'), Cell.fromBase64(boundary.after.shardAccountBoc).refs[0].hash().toString('hex'));
    return {account: entry.account, raw: entry.raw,
      before: {seqno: 0, state: {...boundary.before, accountState: boundary.before.accountState === 'uninit' ? 'uninitialized' : boundary.before.accountState}},
      after: {seqno: 0, state: {...boundary.after, accountState: boundary.after.accountState === 'uninit' ? 'uninitialized' : boundary.after.accountState}}};
  });
  function ownerInput(input = nodes): ProjectionInput {
    const owner = fixture.accounts.payer, wallets = new Map<string, LedgerAsset>();
    for (const [name, pair] of Object.entries(fixture.accounts.wallets) as [string, string[]][]) {
      const walletOwner = name === 'other' ? fixture.accounts.otherPayer : fixture.accounts[name];
      for (const [side, wallet] of pair.entries()) {
        const master = side ? binding.tokenX : binding.tokenT;
        wallets.set(wallet, {kind: 'jetton', id: `localnet:jetton:${master}`, master, wallet, owner: walletOwner});
      }
    }
    const chains = new Map<string, LedgerChain>();
    for (const node of input) {
      if (!chains.has(node.account)) chains.set(node.account, {account: node.account,
        role: node.account === owner ? 'owner' : node.account === binding.pool ? 'pool' : wallets.get(node.account)?.owner === owner ? 'owned_jetton_wallet' : 'counterparty',
        generation: 'sandbox-original-linked-account-history', historyComplete: true, transactions: []});
      chains.get(node.account)!.transactions.push(node.raw);
    }
    return {network: 'localnet', owner, wallets, chains, pools: new Map([[binding.pool, {address: binding.pool, tokenT: binding.tokenT, tokenX: binding.tokenX, codeHash: binding.poolCodeHash}]]),
      opcodes, stateAt: async (account, lt, hash) => {
        const current = input.find(n => matches(n, {account, lt, hash}));
        if (current) return current.after ?? null;
        const next = input.find(n => n.account === account && n.raw.prevTransactionLt === lt && n.raw.prevTransactionHash && canonicalLedgerHash(n.raw.prevTransactionHash) === canonicalLedgerHash(hash));
        return next?.before ?? null;
      }};
  }
  return {fixture,binding,nodes,ownerInput};
}
const checks: {name: string; status: string}[] = [];
const test = async (name: string, run: () => void | Promise<void>) => {await run(); checks.push({name, status: 'passed'}); console.log('PASS', name);};
const swaps = (events: LedgerEvent[]) => events.filter(event => event.kind === 'swap');
async function main() {
  const evidence: unknown[] = [];
  for (const label of ['full-partial','first-refund']) {
    const {fixture,binding,nodes,ownerInput} = load(label), originalJson = JSON.stringify(nodes), owner = fixture.accounts.payer;
    if (label === 'full-partial') {
      await test('sole current DSJ1 decoder rejects the obsolete direct farming reference', () => {
        const cell = Cell.fromBase64(nodes.find(node => node.account === binding.pool && node.after?.state.dataBoc && readDlmmMarketState(node.after.state.dataBoc).storageForm === 'persisted')!.after!.state.dataBoc!);
        const replace = (cell: Cell, index: number, value: Cell) => {
          const result = beginCell().storeBits(cell.bits); cell.refs.forEach((ref, i) => result.storeRef(i === index ? value : ref)); return result.endCell();
        };
        const metadata = cell.refs[3], positions = metadata.refs[1], journal = positions.refs[3];
        const obsolete = replace(cell, 3, replace(metadata, 1, replace(positions, 3, replace(journal, 3, journal.refs[3].refs[0]))));
        assert.throws(() => readDlmmMarketState(obsolete.toBoc().toString('base64')), /dlmm_products_layout_invalid/);
      });
      await test('sole current wallet decoder rejects omitted receipt and referral dictionaries', () => {
        const node = nodes.find(node => node.account === fixture.accounts.wallets.payer[0] && node.after?.state.dataBoc)!;
        const cell = Cell.fromBase64(node.after!.state.dataBoc!); readT3RecoveryWallet(node.after!.state.dataBoc!);
        const stripped = beginCell().storeBits(cell.beginParse().loadBits(cell.bits.length - 2)); cell.refs.slice(0, 2).forEach(ref => stripped.storeRef(ref));
        assert.throws(() => readT3RecoveryWallet(stripped.endCell().toBoc().toString('base64')));
      });
    }
    const graph = createDlmmProofGraph(binding, nodes);
    for (const acceptance of graph.pools) {
      const notice = tokenWire(acceptance.raw.inMessage), forward = notice && protocolForward(notice.forward);
      if (forward?.operation !== 'swap') continue;
      const verified = verifyDlmmSwapExecution(binding, graph, acceptance);
      if (verified.protocolFeeAllocation) {
        await test(`${label}/${acceptance.raw.lt}: protocol fee is a separate exact T3 treasury allocation, not payer cash`, () => {
          const fee = verified.protocolFeeAllocation!;
          assert.equal(fee.root, binding.tokenT); assert.equal(fee.destinationOwner, fixture.accounts.creator);
          assert.equal(fee.sourceWallet, fixture.accounts.wallets.pool[0]);
          assert(!verified.settlements.some(settlement => settlement.settlementId === fee.settlementId));
          assert.equal(verified.settlements.length, Number(verified.output > 0n) + Number(verified.returned > 0n));
          const intent = fixture.intents.find((intent: any) => intent.businessQueryId === forward.queryId)!;
          assert.equal(BigInt(fee.amountRaw), (BigInt(intent.quote.feePaid) * 1700n + 9999n) / 10000n);
        });
        for (const mutation of ['foreign-kind', 'unknown-kind', 'wrong-token', 'wrong-owner', 'wrong-source', 'wrong-wallet', 'wrong-request', 'wrong-successor', 'overfunded', 'wrong-economic-amount']) {
          await test(`${label}/${acceptance.raw.lt}: rejects protocol fee ${mutation}`, () => {
            const wrapped = {...graph, poolAt: (node: MarketNode) => {
              const state = graph.poolAt(node);
              if (node !== acceptance) return state;
              const after = {...state.after, settlements: new Map(state.after.settlements)};
              const original = after.settlements.get(verified.protocolFeeAllocation!.settlementId)!, fee = {...original};
              after.settlements.set(fee.settlementId, fee);
              if (mutation === 'foreign-kind') fee.kind = 8;
              if (mutation === 'unknown-kind') fee.kind = 10;
              if (mutation === 'wrong-token') fee.tokenSide = 1;
              if (mutation === 'wrong-owner') fee.destinationOwner = owner;
              if (mutation === 'wrong-source') fee.sourceWallet = fixture.accounts.wallets.payer[0];
              if (mutation === 'wrong-wallet') fee.destinationWallet = fixture.accounts.wallets.payer[0];
              if (mutation === 'wrong-request') fee.requestHash = 'f'.repeat(64);
              if (mutation === 'wrong-successor') fee.successorId = '1';
              if (mutation === 'overfunded') fee.fundedRaw = '180000001';
              if (mutation === 'wrong-economic-amount') fee.amountRaw = (BigInt(fee.amountRaw) + 1n).toString();
              return {...state, after};
            }};
            assert.throws(() => verifyDlmmSwapExecution(binding, wrapped, acceptance));
          });
        }
      }
    }
    const projection = await projectOwnerLedger(ownerInput()), rows = swaps(projection.events);
    assert.equal(rows.length, fixture.intents.length);
    for (const intent of fixture.intents) await test(`${intent.phase}: exact actual debit, output and refund are one qualified operation`, () => {
      const event = rows.find(row => row.settlement?.queryId === intent.businessQueryId)!;
      assert.equal(event.settlement?.status,'confirmed',JSON.stringify(event.issues));
      const m = event.settlement!.dlmmSwap!; assert(m);
      assert.equal(m.poolCodeHash,binding.poolCodeHash,'indexed swap binds the authenticated historical pool code');
      assert.equal(m.paidInputRaw,intent.amountInRaw); assert.equal(m.returnedInputRaw,intent.actualRefundRaw);
      assert.equal(BigInt(m.consumedInputRaw),BigInt(intent.amountInRaw)-BigInt(intent.actualRefundRaw));
      assert.equal(m.outputRaw,intent.actualDeliveredOutputRaw);
      const cash = event.movements.filter(movement => movement.asset.kind !== 'native');
      assert.equal(cash.length,1+Number(m.outputRaw!=='0')+Number(m.returnedInputRaw!=='0'));
      assert.equal(cash.find(movement => movement.id===m.inputMovementId)!.amountRaw,m.paidInputRaw);
      if(m.outputRaw!=='0') assert.equal(cash.find(movement => movement.id===m.outputMovementId)!.amountRaw,m.outputRaw);
      else assert.equal(m.outputMovementId,null);
      if(m.returnedInputRaw!=='0') assert.equal(cash.find(movement => movement.id===m.refundMovementId)!.amountRaw,m.returnedInputRaw);
      else assert.equal(m.refundMovementId,null);
      assert.equal(m.finalizations.length,cash.length-1);
      for(const ref of [m.acceptance,...m.finalizations]) assert(nodes.some(node=>matches(node,ref)));
      assert.deepEqual(Object.keys(m).sort(),ledgerSchemas.LedgerEvent.properties.settlement.properties.dlmmSwap.required.slice().sort());
    });
    await test(`${label}: raw input order preserves exact operation and amount identities`, async () => {
      assert.deepEqual(swaps((await projectOwnerLedger(ownerInput([...nodes].reverse()))).events).sort((a,b)=>a.id.localeCompare(b.id)),[...rows].sort((a,b)=>a.id.localeCompare(b.id)));
    });
    if(label==='first-refund') await test('first refund qualifies while the never-used output wallet has no history or archive', () => {
      assert(!nodes.some(node=>node.account===fixture.accounts.wallets.payer[1]));
      assert.equal(rows[0].settlement!.dlmmSwap!.outputRaw,'0');
      assert.equal(rows[0].settlement!.dlmmSwap!.consumedInputRaw,'0');
    });
    const config = {...loadConfig(),network:'localnet' as const,responseCacheEnabled:false}, store = new MemoryStore(config);
    const originals = nodes.filter(node=>node.account===owner).map(node=>classifyTransaction(owner,node.raw,opcodes));
    store.addTransactions(owner,originals);const head=[...originals].sort((a,b)=>BigInt(a.lt)>BigInt(b.lt)?-1:1)[0];
    store.setBalance(owner,{address:owner,balance:'0',lastTxLt:head.lt,lastTxHash:head.hash,updatedAt:Date.now()});store.markHistoryComplete(owner);
    const service=new IndexerService(config,store,{} as TonDataSource,opcodes,[]);
    const page=(events:LedgerEvent[])=>({network:'localnet' as const,account:owner,events,nextCursor:null,
      coverage:{generation:'sandbox-swap-projection',snapshotComplete:true,historyComplete:true,issues:[]}}) as any;
    service.setSwapLedgerReader(async()=>page(projection.events));
    const actual=await service.getSwapExecutions(owner);
    await test(`${label}: public swap history reports consumed input and preserves actual refund separately`,()=>{
      assert.equal(actual.swaps.length,fixture.intents.length);
      for(const intent of fixture.intents){
        const swap=actual.swaps.find(row=>row.queryId===intent.outerQueryId)!;assert(swap);
        assert.equal(swap.requestedPayAmount,intent.amountInRaw);assert.equal(swap.returnedPayAmount,intent.actualRefundRaw);
        assert.equal(BigInt(swap.payAmount!),BigInt(intent.amountInRaw)-BigInt(intent.actualRefundRaw));
        assert.equal(swap.receiveAmount,intent.actualDeliveredOutputRaw==='0'?undefined:intent.actualDeliveredOutputRaw);
        assert.equal(swap.receiveAmountSource,intent.actualDeliveredOutputRaw==='0'?undefined:'actual');
        assert.equal(!!swap.receipt,intent.actualDeliveredOutputRaw!=='0');
      }
    });
    service.setSwapLedgerReader(async()=>{throw Error('archive unavailable');});
    await test(`${label}: unavailable ledger cannot overwrite locally proven consumption with requested input`,async()=>{
      for(const row of (await service.getSwapExecutions(owner)).swaps){assert(row.requestedPayAmount);assert.equal(row.payAmount,undefined);assert.equal(row.receiveAmount,undefined);assert.equal(row.returnedPayAmount,undefined);}
    });
    for(const target of rows){
      const m=target.settlement!.dlmmSwap!;
      for(const [name,id] of [['output',m.outputMovementId],['refund',m.refundMovementId]] as const){
        if(!id)continue;const movement=target.movements.find(row=>row.id===id)!;const credit=movement.evidence.transactions!.find(ref=>ref.account===movement.asset.wallet)!;
        await test(`${label}/${m.acceptance.lt}: missing actual ${name} credit prevents final settlement`,async()=>{
          const result=await projectOwnerLedger(ownerInput(nodes.filter(node=>!matches(node,credit))));
          assert.notEqual(swaps(result.events).find(row=>row.settlement?.queryId===target.settlement!.queryId)?.settlement?.status,'confirmed');
        });
        await test(`${label}/${m.acceptance.lt}: missing or duplicated ${name} movement rejects public amount enrichment`,async()=>{
          for(const duplicate of [false,true]){
            const altered=structuredClone(projection.events),event=altered.find(row=>row.id===target.id)!;
            if(duplicate)event.movements.push(structuredClone(event.movements.find(row=>row.id===id)!));else event.movements=event.movements.filter(row=>row.id!==id);
            service.setSwapLedgerReader(async()=>page(altered));
            const swap=(await service.getSwapExecutions(owner)).swaps.find(row=>row.queryId===target.settlement!.queryId)!;
            assert.equal(swap.payAmount,undefined);assert.equal(swap.receiveAmount,undefined);assert.equal(swap.returnedPayAmount,undefined);
          }
        });
      }
      await test(`${label}/${m.acceptance.lt}: duplicate original acceptance cannot qualify a second economic event`,async()=>{
        const input=ownerInput([...nodes,nodes.find(node=>matches(node,m.acceptance))!]);
        assert(!swaps((await projectOwnerLedger(input)).events).some(row=>row.settlement?.status==='confirmed'));
      });
      await test(`${label}/${m.acceptance.lt}: broken consumption conservation or missing finalizer rejects public amounts`,async()=>{
        for(const invalid of ['conservation','finalization','duplicate-event']){
          const altered=structuredClone(projection.events),event=altered.find(row=>row.id===target.id)!;
          if(invalid==='conservation')event.settlement!.dlmmSwap!.consumedInputRaw=(BigInt(m.consumedInputRaw)+1n).toString();
          if(invalid==='finalization')event.settlement!.dlmmSwap!.finalizations.pop();
          if(invalid==='duplicate-event')altered.push(structuredClone(event));
          service.setSwapLedgerReader(async()=>page(altered));
          const swap=(await service.getSwapExecutions(owner)).swaps.find(row=>row.queryId===target.settlement!.queryId)!;
          assert.equal(swap.payAmount,undefined);assert.equal(swap.receiveAmount,undefined);assert.equal(swap.returnedPayAmount,undefined);
        }
      });
    }
    assert.equal(JSON.stringify(nodes),originalJson,'unaltered original transaction and archive evidence');
    evidence.push({label,binding,source:provenance[label],projection,publicSwaps:actual});
  }
  if(process.env.DLMM_SWAP_EVIDENCE_OUT){const out=resolve(process.env.DLMM_SWAP_EVIDENCE_OUT);mkdirSync(out,{recursive:true});writeFileSync(resolve(out,'owner-swap-checks.json'),JSON.stringify({checks,evidence},null,2)+'\n');}
  console.log(`PASS ${checks.length} actual DLMM swap projection and receipt checks`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});

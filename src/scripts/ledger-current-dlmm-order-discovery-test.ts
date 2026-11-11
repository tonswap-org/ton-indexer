import assert from 'node:assert/strict';
import { currentDlmmMarketOriginals } from './support/currentDlmmFixture';
import { currentDlmmMarketGraphFixture } from './support/currentDlmmMarketGraphFixture';
import { currentDlmmProjectionFixture } from './support/currentDlmmProjectionFixture';
import { currentDlmmBindingFromManifest } from '../ledger/currentDlmmPhysical';
import { LedgerGraphBuilder } from '../ledger/graph';
import { createJettonWalletReader } from '../data/jettonWallet';
import type { WalletIdentityStore } from '../ledger/identities';
import type { PostgresLedgerStore } from '../ledger/store';
async function main(){for(const config of ['default','x6']){
 const c=currentDlmmMarketOriginals().find(c=>c.file===`order-0-filled-${config}.json`)!,f=currentDlmmMarketGraphFixture(c),binding={release:f.binding.release,pools:[{pool:f.binding.pool,market:f.binding.market,t3:f.binding.t3,x:f.binding.x,wallets:f.wallets}]},input=currentDlmmProjectionFixture({binding,request:{owner:c.original.wallet},transactions:f.evidence});
 const identities={resolve:async(a:string)=>input.wallets.get(a)??null,known:async()=>null,reader:createJettonWalletReader({source:f.source,tokens:f.binding.release.tokens.map(t=>({master:t.root,masterCodeHash:t.masterCodeHash,walletCodeHash:t.walletCodeHash}))})} as unknown as WalletIdentityStore;
 const graph=new LedgerGraphBuilder('localnet',f.source,f.ledger.store as PostgresLedgerStore,[],undefined,identities,f.ledger.refreshDependency.bind(f.ledger),256,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,[],[],undefined,undefined,currentDlmmBindingFromManifest(f.binding.release));
 const ownerGeneration=f.dependencies.find(d=>d.account===c.original.wallet)!.generation,result=await graph.build(c.original.wallet,ownerGeneration,{boundary:f.adapter.head});
 assert.equal(result.bindings[`current-dlmm-orders:${f.binding.release.contracts.SpotOrderFactory!.address}`],true,JSON.stringify(result.issues));assert(result.currentDlmmBinding?.pools[0].wallets.some(w=>w.owner===c.original.order));assert(result.chains.has(c.original.order));assert.equal(result.chains.get(c.original.wallet)!.transactions.length,f.histories.get(c.original.wallet)!.length);assert(result.chains.get(c.original.wallet)!.transactions.some(t=>t.lt==='40000000'),'unrelated original setup remains in ordinary owner history');
 f.control.getterOutage=true;const missing=await graph.build(c.original.wallet,ownerGeneration,{boundary:f.adapter.head});assert.equal(missing.bindings[`current-dlmm-orders:${f.binding.release.contracts.SpotOrderFactory!.address}`],false);assert(missing.issues.includes('dlmm_current_order_discovery_unavailable'));f.control.getterOutage=false;f.control.missingBoundary=c.original.wallet;const withoutOriginal=await graph.build(c.original.wallet,ownerGeneration,{boundary:f.adapter.head});assert.equal(withoutOriginal.bindings[`current-dlmm-orders:${f.binding.release.contracts.SpotOrderFactory!.address}`],false);assert(withoutOriginal.issues.includes('dlmm_current_order_discovery_unavailable'));console.log(config,'original factory/child and canonical input-wallet graph qualified; getter outage and missing original owner boundary retained unresolved');
 }console.log('Current Order discovery: production native default/x6 positive and refusal cases passed.');}
void main().catch(e=>{console.error(e);process.exitCode=1;});

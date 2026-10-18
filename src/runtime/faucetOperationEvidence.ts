import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { createJettonWalletReader } from '../data/jettonWallet';
import { activeOrderAccount, verifyOrderTransaction } from '../orders/evidence';
import type { PhysicalEvidenceStore } from './physicalEvidence';
import { ProductEvidenceError, requireProduct, productUint, productAddress, productCell, productDispatch,
  collectProductPhysicalGraph, boundProductResponse, type ProductDispatch, type ProductPhysicalGraph } from './productEvidence';

export type CurrentFaucetEvidenceRequest = { network: string; releaseId: string; manifestHash: string; kind:'claim'; owner:string;
  faucet:string; asset:0|1|2; queryId:string; bodyBoc:string; bodyHash:string; valueNano:string; createdAt:number; dispatch:ProductDispatch };
export function readFaucetOperationRequest(value: unknown, manifest: RuntimeReleaseManifest) {
  try {
    requireProduct(value && typeof value === 'object' && !Array.isArray(value)); const x=value as Record<string, unknown>;
    requireProduct(Object.keys(x).sort().join() === ['network','releaseId','manifestHash','kind','owner','faucet','asset','queryId','bodyBoc','bodyHash','valueNano','createdAt','dispatch'].sort().join());
    requireProduct(x.kind === 'claim' && [0,1,2].includes(x.asset as number));
    if (x.network !== manifest.network.slice(4) || x.releaseId !== manifest.releaseId || x.manifestHash !== manifest.manifestHash
      || x.faucet !== manifest.contracts.TestnetFaucet?.address) throw new ProductEvidenceError(409,'release_mismatch');
    productAddress(x.owner); productAddress(x.faucet); const query=productUint(x.queryId,64), budget=productUint(x.valueNano,120,true), dispatch=productDispatch(x.dispatch);
    requireProduct(BigInt(dispatch.valueNano) <= budget && Number.isSafeInteger(x.createdAt) && Number(x.createdAt)>0);
    const body=productCell(x.bodyBoc,x.bodyHash), s=body.beginParse();
    requireProduct(s.loadUint(32)===0x46434c4d && s.loadUintBig(64)===query && s.loadUint(8)===x.asset); s.endParse();
    return {request:structuredClone(x) as CurrentFaucetEvidenceRequest,body};
  } catch(error) {if(error instanceof ProductEvidenceError) throw error; throw new ProductEvidenceError(400,'bad_request');}
}
export type CurrentFaucetOperationEvidence = ProductPhysicalGraph & {schema:'tonswap-faucet-operation-evidence-v1';releaseId:string;manifestHash:string;
  asOf:{masterchainSeqno:number;unixTime:number;blockRootHash:string};request:{kind:'claim';owner:string;bodyHash:string}};
export async function collectFaucetOperationEvidence(manifest:RuntimeReleaseManifest,source:ChainSource,store:PhysicalEvidenceStore,
  parsed:ReturnType<typeof readFaucetOperationRequest>,signal?:AbortSignal):Promise<CurrentFaucetOperationEvidence> {
  signal?.throwIfAborted(); if(`ton:${source.network}`!==manifest.network) throw new ProductEvidenceError(503,'upstream_unavailable');
  const {request}=parsed, head=await source.head({signal}); assertFreshHeadTime(head.utime);
  const token=manifest.tokens.find(t=>t.symbol===['T3','USDT','TS'][request.asset]); if(!token) throw new ProductEvidenceError(503,'upstream_unavailable');
  const reader=createJettonWalletReader({source,tokens:[{master:token.root,masterCodeHash:token.masterCodeHash,walletCodeHash:token.walletCodeHash}]});
  const sourceWallet=await reader.identity(token.root,request.faucet,{at:head,signal}), recipientWallet=await reader.identity(token.root,request.owner,{at:head,signal});
  const graph=await collectProductPhysicalGraph(source,store,head,{owner:request.owner,target:request.faucet,body:parsed.body,dispatch:request.dispatch,
    pins:new Map([[request.faucet,manifest.contracts.TestnetFaucet!.codeHash]]),completeAccounts:[request.faucet,sourceWallet.wallet,recipientWallet.wallet]},signal);
  try {
    for (const row of graph.transactions) if (row.account === request.faucet) {
      const tx = verifyOrderTransaction(row);
      for (const shard of [tx.before, tx.after]) if (shard.account?.storage.state.type === 'active') {
        const config = activeOrderAccount(shard, manifest.contracts.TestnetFaucet!.codeHash).data.beginParse().loadRef().beginParse();
        config.loadUint(32); config.loadCoins(); config.loadCoins(); config.loadCoins();
        if (config.loadUintBig(120).toString() !== manifest.supplyBase) throw new Error('faucet_supply_base_mismatch');
        config.loadCoins(); config.endParse();
      }
    }
  } catch { graph.coverage.complete = false; graph.coverage.gaps.push({ code: 'faucet_release_config_mismatch', account: request.faucet }); }
  signal?.throwIfAborted(); assertFreshHeadTime(head.utime);
  return boundProductResponse<CurrentFaucetOperationEvidence>({schema:'tonswap-faucet-operation-evidence-v1',releaseId:manifest.releaseId,manifestHash:manifest.manifestHash,
    asOf:{masterchainSeqno:head.seqno,unixTime:head.utime,blockRootHash:head.rootHashHex},request:{kind:'claim',owner:request.owner,bodyHash:request.bodyHash},...graph},request.faucet);
}

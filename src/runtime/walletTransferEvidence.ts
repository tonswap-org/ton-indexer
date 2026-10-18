import { CellType } from '@ton/core';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { createJettonWalletReader } from '../data/jettonWallet';
import { verifyOrderTransaction } from '../orders/evidence';
import { readCurrentT3Wallet } from '../ledger/currentT3State';
import type { PhysicalEvidenceStore } from './physicalEvidence';
import { ProductEvidenceError, requireProduct, productUint, productAddress, productCell, productDispatch,
  collectProductPhysicalGraph, boundProductResponse, type ProductDispatch, type ProductPhysicalGraph } from './productEvidence';
export type CurrentWalletTransferEvidenceRequest = { network:string;releaseId:string;manifestHash:string;owner:string;recipient:string;root:string;
 senderWallet:string;recipientWallet:string;queryId:string;amountRaw:string;bodyBoc:string;bodyHash:string;valueNano:string;createdAt:number;dispatch:ProductDispatch };
export function readWalletTransferEvidenceRequest(value:unknown,manifest:RuntimeReleaseManifest){
 try{
  requireProduct(value&&typeof value==='object'&&!Array.isArray(value));const v=value as Record<string,unknown>;
  requireProduct(Object.keys(v).sort().join()===['network','releaseId','manifestHash','owner','recipient','root','senderWallet','recipientWallet','queryId','amountRaw','bodyBoc','bodyHash','valueNano','createdAt','dispatch'].sort().join());
  if(v.network!==manifest.network.slice(4)||v.releaseId!==manifest.releaseId||v.manifestHash!==manifest.manifestHash)throw new ProductEvidenceError(409,'release_mismatch');
  for(const k of ['owner','recipient','root','senderWallet','recipientWallet'])productAddress(v[k]);requireProduct(v.owner!==v.recipient&&v.senderWallet!==v.recipientWallet);
  const token=manifest.tokens.find(t=>t.root===v.root);requireProduct(token);
  const family=token.root===manifest.contracts.T3Hub?.address&&token.walletCodeHash===manifest.templates.T3Wallet?'t3':token.masterCodeHash===manifest.templates.JettonV21Minter&&token.walletCodeHash===manifest.templates.JettonV21Wallet?'v21':token.masterCodeHash===manifest.vendor.stablecoin.minter.codeHash&&token.walletCodeHash===manifest.vendor.stablecoin.wallet.codeHash?'stablecoin':null;requireProduct(family);
  const amount=productUint(v.amountRaw,120,true),query=productUint(v.queryId,64,true),dispatch=productDispatch(v.dispatch),budget=productUint(v.valueNano,120,true);
  requireProduct(BigInt(dispatch.valueNano)<=budget&&Number.isSafeInteger(v.createdAt)&&Number(v.createdAt)>0);
  const body=productCell(v.bodyBoc,v.bodyHash),s=body.beginParse();requireProduct(s.loadUint(32)===0x0f8a7ea5&&s.loadUintBig(64)===query&&s.loadCoins()===amount&&s.loadAddress().toRawString()===v.recipient&&s.loadAddress().toRawString()===v.owner&&!s.loadBit());
  const forward=s.loadCoins();requireProduct(forward===0n||forward===1n);const byRef=s.loadBit(),payload=byRef?s.loadRef():null;s.endParse();
  if(forward===0n)requireProduct(!byRef);else{requireProduct(payload&&!payload.isExotic);const p=payload.beginParse();requireProduct(p.loadUint(32)===0);const text=p.loadStringTail();requireProduct(text.length>0&&Buffer.byteLength(text)<=512);}
  return{request:structuredClone(v) as CurrentWalletTransferEvidenceRequest,body,token,family};
 }catch(error){if(error instanceof ProductEvidenceError)throw error;throw new ProductEvidenceError(400,'bad_request');}
}
export type CurrentWalletTransferEvidence=ProductPhysicalGraph&{schema:'tonswap-wallet-transfer-evidence-v1';releaseId:string;manifestHash:string;
 asOf:{masterchainSeqno:number;unixTime:number;blockRootHash:string};request:Pick<CurrentWalletTransferEvidenceRequest,'owner'|'recipient'|'root'|'senderWallet'|'recipientWallet'|'bodyHash'>};
export async function collectWalletTransferEvidence(manifest:RuntimeReleaseManifest,source:ChainSource,store:PhysicalEvidenceStore,parsed:ReturnType<typeof readWalletTransferEvidenceRequest>,signal?:AbortSignal):Promise<CurrentWalletTransferEvidence>{
 signal?.throwIfAborted();if(`ton:${source.network}`!==manifest.network)throw new ProductEvidenceError(503,'upstream_unavailable');
 const {request:p,token,family}=parsed,head=await source.head({signal});assertFreshHeadTime(head.utime);
 const reader=createJettonWalletReader({source,tokens:[{master:token.root,masterCodeHash:token.masterCodeHash,walletCodeHash:token.walletCodeHash}]}),[sender,recipient]=await Promise.all([reader.identity(p.root,p.owner,{at:head,signal}),reader.identity(p.root,p.recipient,{at:head,signal})]);
 requireProduct(sender.wallet===p.senderWallet&&recipient.wallet===p.recipientWallet);
 const graph=await collectProductPhysicalGraph(source,store,head,{owner:p.owner,target:p.senderWallet,body:parsed.body,dispatch:p.dispatch,pins:new Map(),completeAccounts:[],includeAccounts:[p.senderWallet,p.recipientWallet]},signal);
 try{for(const e of graph.transactions){const owner=e.account===p.senderWallet?p.owner:e.account===p.recipientWallet?p.recipient:null;if(!owner)continue;const tx=verifyOrderTransaction(e);
  for(const shard of [tx.before,tx.after])if(shard.account?.storage.state.type==='active'){const state=shard.account.storage.state.state,data=state.data;if(!state.code||!data||![CellType.Ordinary,CellType.Library].includes(state.code.type)||state.code.hash().toString('hex')!==token.walletCodeHash||data.isExotic||(state.splitDepth??null)!==(family==='v21'?8:null)||state.special!=null||(state.libraries&&state.libraries.size))throw Error('Wallet executable identity mismatch');
   if(family==='t3'){const s=readCurrentT3Wallet(data.toBoc().toString('base64'));if(s.owner!==owner||s.master!==p.root||s.proofCodeHash!==manifest.templates.T3RecoveryProof)throw Error('T3 wallet identity mismatch');}
   else{const s=data.beginParse();if(family==='stablecoin')s.loadUint(4);s.loadCoins();if(s.loadAddress().toRawString()!==owner||s.loadAddress().toRawString()!==p.root)throw Error('Vendor wallet identity mismatch');s.endParse();}
  }
 }}catch{graph.coverage.complete=false;graph.coverage.gaps.push({code:'transfer_wallet_identity_mismatch',account:p.senderWallet});}
 signal?.throwIfAborted();assertFreshHeadTime(head.utime);
 return boundProductResponse<CurrentWalletTransferEvidence>({schema:'tonswap-wallet-transfer-evidence-v1',releaseId:manifest.releaseId,manifestHash:manifest.manifestHash,asOf:{masterchainSeqno:head.seqno,unixTime:head.utime,blockRootHash:head.rootHashHex},request:{owner:p.owner,recipient:p.recipient,root:p.root,senderWallet:p.senderWallet,recipientWallet:p.recipientWallet,bodyHash:p.bodyHash},...graph},p.senderWallet);
}

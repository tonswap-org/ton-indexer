import { Address, beginCell, Cell, TupleReader } from '@ton/core';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import { t3Attempt } from '../ledger/currentT3Wire';
import type { ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { createJettonWalletReader } from '../data/jettonWallet';
import { activeOrderAccount, orderShard, verifyOrderTransaction } from '../orders/evidence';
import { publicPoolIdentity, verifyPoolEvidenceIdentity } from './poolOperationEvidence';
import { assertPoolIdentity } from './spotOperationEvidence';
import type { PhysicalEvidenceStore } from './physicalEvidence';
import { boundProductResponse, collectProductPhysicalGraph, productAddress, productCell, productDispatch, productUint, ProductEvidenceError, requireProduct, type ProductDispatch, type ProductPhysicalGraph } from './productEvidence';
import { launchAddress, launchCheck, readLaunchChild, readLaunchFactory, readLaunchSaleConfig, readLaunchTerms, readLaunchpadProjectToken, type LaunchIdentity } from './launchpadEvidenceState';
const kinds=['create','contribute','supply','vest-supply','claim','finalize','cancel','discover','lp-seed','lp-release','vest-claim','vest-return','owed','wallet-mark','wallet-retry','holder-claim','archive-claim'] as const;
export type LaunchpadAsset={root:string;masterCodeHash:string;walletCodeHash:string;amountRaw:string;recipient:string};
export type CurrentLaunchpadEvidenceRequest={network:string;releaseId:string;manifestHash:string;kind:typeof kinds[number];owner:string;factory:string;sale:string;target:string;creator:string;nonce:string;model:0|1|2;
  queryId:string;tokenRoot:string|null;amountRaw:string;minTokensRaw:string|null;sourceWallet:string|null;assets:LaunchpadAsset[];bodyBoc:string;bodyHash:string;valueNano:string;createdAt:number;dispatch:ProductDispatch};
export function readLaunchpadOperationRequest(value:unknown,manifest:RuntimeReleaseManifest){
  try{
    requireProduct(value&&typeof value==='object'&&!Array.isArray(value));const v=value as Record<string,unknown>;
    requireProduct(Object.keys(v).sort().join()===['network','releaseId','manifestHash','kind','owner','factory','sale','target','creator','nonce','model','queryId','tokenRoot','amountRaw','minTokensRaw','sourceWallet','assets','bodyBoc','bodyHash','valueNano','createdAt','dispatch'].sort().join());
    requireProduct(kinds.includes(v.kind as any)&&[0,1,2].includes(v.model as number));
    if(v.network!==manifest.network.slice(4)||v.releaseId!==manifest.releaseId||v.manifestHash!==manifest.manifestHash||v.factory!==manifest.contracts.SaleFactory?.address)throw new ProductEvidenceError(409,'release_mismatch');
    for(const key of ['owner','factory','sale','target','creator'])productAddress(v[key]);if(v.tokenRoot!==null)productAddress(v.tokenRoot);if(v.sourceWallet!==null)productAddress(v.sourceWallet);
    const nonce=productUint(v.nonce,64),query=productUint(v.queryId,64),amount=productUint(v.amountRaw,120);productUint(v.valueNano,120,true);const dispatch=productDispatch(v.dispatch);
    requireProduct(BigInt(dispatch.valueNano)<=BigInt(String(v.valueNano))&&Number.isSafeInteger(v.createdAt)&&Number(v.createdAt)>0);
    requireProduct(Array.isArray(v.assets)&&v.assets.length<=16);const assetKeys=new Set<string>();
    for(const a of v.assets){requireProduct(a&&typeof a==='object'&&!Array.isArray(a)&&Object.keys(a).sort().join()===['root','masterCodeHash','walletCodeHash','amountRaw','recipient'].sort().join());
      productAddress(a.root);productAddress(a.recipient);productUint(a.amountRaw,120);requireProduct(/^[0-9a-f]{64}$/.test(a.masterCodeHash)&&/^[0-9a-f]{64}$/.test(a.walletCodeHash));
      const key=a.root+':'+a.recipient;requireProduct(!assetKeys.has(key));assetKeys.add(key);
    }
    const body=productCell(v.bodyBoc,v.bodyHash,v.kind==='wallet-mark'?256:128),s=body.beginParse();let terms:ReturnType<typeof readLaunchTerms>|null=null,dispatchTarget=String(v.target),owedSlot:number|null=null;
    const path=(proof:Cell)=>{let cell:Cell|null=proof;for(let i=0;i<64;i++){requireProduct(cell&&!cell.isExotic);const p=cell.beginParse();requireProduct(p.remainingBits===257);p.loadUintBig(256);cell=p.loadMaybeRef();p.endParse();requireProduct((cell===null)===(i===63));}};
    if(v.kind==='wallet-mark'||v.kind==='wallet-retry'){
      requireProduct(v.sourceWallet!==null&&v.tokenRoot===manifest.contracts.T3Hub!.address&&v.minTokensRaw===null&&amount>0n);dispatchTarget=String(v.sourceWallet);
      requireProduct(s.loadUint(32)===(v.kind==='wallet-mark'?0x5433574b:0x54335759));const record=s.loadRef().beginParse(),failed=record.loadBit(),cancelled=record.loadBit(),attempt=t3Attempt(record.loadRef());record.endParse();path(s.loadRef());
      requireProduct(!cancelled&&!attempt.burn&&attempt.owner===v.target&&attempt.amount===amount&&v.assets.length===1&&v.assets[0].root===v.tokenRoot&&v.assets[0].amountRaw===v.amountRaw&&v.assets[0].recipient===attempt.recipient);
      if(v.kind==='wallet-retry')requireProduct(failed&&s.loadAddress().toRawString()===attempt.recipient);else{requireProduct(!failed);s.loadUintBig(64);path(s.loadRef());}s.endParse();
    }else if(v.kind==='holder-claim'){
      requireProduct(s.loadUint(32)===0x4a52434d&&v.sourceWallet===null&&v.tokenRoot===manifest.contracts.T3Hub!.address&&v.minTokensRaw===null&&amount>0n);
      const receipt=s.loadRef().beginParse();receipt.loadUintBig(64);const record=receipt.loadRef().beginParse();receipt.endParse();record.loadBit();requireProduct(record.loadUint(8)===0&&record.loadCoins()===amount&&!record.loadBit());record.loadRef();record.endParse();path(s.loadRef());s.endParse();
      requireProduct(v.assets.length===1&&v.assets[0].root===v.tokenRoot&&v.assets[0].amountRaw===v.amountRaw);
    }else if(v.kind==='archive-claim'){
      requireProduct(s.loadUint(32)===0x434c4d41&&s.loadUintBig(64)===query&&v.sourceWallet===null&&v.minTokensRaw===null&&amount>0n);owedSlot=s.loadUint(8);requireProduct(owedSlot<=1);s.loadUintBig(64);
      requireProduct(s.loadAddress().toRawString()===v.owner&&s.loadCoins()===amount);path(s.loadRef());s.endParse();requireProduct(v.assets.length===1&&v.assets[0].root===v.tokenRoot&&v.assets[0].amountRaw===v.amountRaw&&v.assets[0].recipient===v.owner);
    }else if(v.kind==='contribute'||v.kind==='supply'||v.kind==='vest-supply'){

      requireProduct(v.sourceWallet!==null&&v.tokenRoot!==null&&amount>0n);dispatchTarget=String(v.sourceWallet);
      requireProduct(s.loadUint(32)===0x0f8a7ea5&&s.loadUintBig(64)===query&&s.loadCoins()===amount&&s.loadAddress().toRawString()===v.target&&s.loadMaybeAddress()?.toRawString()===v.owner&&!s.loadMaybeRef()&&s.loadCoins()>0n);
      const referenced=s.loadBit(),payload=referenced?s.loadRef():beginCell().storeSlice(s).endCell();if(referenced)s.endParse();const p=payload.beginParse();
      if(v.kind==='contribute')requireProduct(p.loadUint(32)===0x53434f4e&&p.loadCoins()===productUint(v.minTokensRaw,120,true));else requireProduct(v.minTokensRaw===null);p.endParse();
      requireProduct(v.assets.some(a=>a.root===v.tokenRoot&&a.recipient===v.target&&a.amountRaw===v.amountRaw));
    }else{
      requireProduct(v.sourceWallet===null&&v.minTokensRaw===null);
      const op=s.loadUint(32);requireProduct(s.loadUintBig(64)===query);
      if(v.kind==='create'){
        requireProduct(op===0x53464e57&&v.creator===v.owner&&v.target===v.factory&&s.loadUintBig(64)===nonce&&s.loadUint(8)===v.model);terms=readLaunchTerms(s.loadRef());
        if(v.tokenRoot!==null)requireProduct(v.tokenRoot===terms.project);
      }else if(v.kind==='lp-seed'){requireProduct(op===0x4c565344);s.loadCoins();s.loadCoins();}
      else if(v.kind==='lp-release'){requireProduct(op===0x4c56524c);s.loadCoins();s.loadCoins();s.loadBit();}
      else if(v.kind==='owed'){requireProduct(op===0x434c4d4a&&amount>0n);owedSlot=s.loadUint(8);requireProduct(owedSlot<=1&&s.loadAddress().toRawString()===v.owner);}
      else requireProduct(op===({claim:0x53434c4d,finalize:0x5346494e,cancel:0x5343414e,discover:0x44534357,'vest-claim':0x5656434c,'vest-return':0x56565254} as Record<string,number>)[String(v.kind)]);
      s.endParse();
    }
    return{request:structuredClone(v) as CurrentLaunchpadEvidenceRequest,body,dispatchTarget,terms,owedSlot};
  }catch(e){if(e instanceof ProductEvidenceError)throw e;throw new ProductEvidenceError(400,'bad_request');}
}
export type CurrentLaunchpadOperationEvidence=ProductPhysicalGraph&{schema:'tonswap-launchpad-operation-evidence-v1';releaseId:string;manifestHash:string;asOf:{masterchainSeqno:number;unixTime:number;blockRootHash:string};request:{kind:CurrentLaunchpadEvidenceRequest['kind'];owner:string;bodyHash:string}};
export async function readLaunchpadEvidenceContext(manifest:RuntimeReleaseManifest,source:ChainSource,parsed:ReturnType<typeof readLaunchpadOperationRequest>,signal?:AbortSignal){
  signal?.throwIfAborted();launchCheck(`ton:${source.network}`===manifest.network);const p=parsed.request,head=await source.head({signal});assertFreshHeadTime(head.utime);
  const factoryState=await source.getAccountState(p.factory,{at:head,signal});launchCheck(factoryState.shardAccountBoc);
  const factory=readLaunchFactory(activeOrderAccount(orderShard(factoryState.shardAccountBoc,p.factory).shard,manifest.contracts.SaleFactory!.codeHash).data,manifest);
  const id:LaunchIdentity={factory:p.factory,creator:p.creator,nonce:BigInt(p.nonce),model:p.model,role:0};
  const children=[0,1,2].map(role=>{const slot=role===0?p.model:role+2;return{address:launchAddress({...id,role},factory.codes.get(slot)!),hash:factory.pins[slot],role};});
  requireProduct(p.sale===children[0].address);
  const targetRole=children.find(c=>c.address===p.target)?.role;
  if(p.kind==='create')requireProduct(p.target===p.factory);
  else if(['wallet-mark','wallet-retry'].includes(p.kind))requireProduct(p.target===p.owner||targetRole===0||targetRole===1);
  else if(p.kind==='holder-claim')requireProduct(targetRole===0||targetRole===1);
  else if(p.kind==='archive-claim')requireProduct(targetRole===0);
  else if(['contribute','supply','claim','finalize','cancel'].includes(p.kind))requireProduct(targetRole===0);
  else if(['lp-seed','lp-release'].includes(p.kind))requireProduct(targetRole===1);
  else if(['vest-supply','vest-claim','vest-return'].includes(p.kind))requireProduct(targetRole===2);
  else requireProduct(targetRole!==undefined);
  const pins=new Map([[p.factory,manifest.contracts.SaleFactory!.codeHash],...children.map(c=>[c.address,c.hash] as [string,string])]),completeAccounts=[p.factory];
  let terms=parsed.terms;const loaded=new Map<number,ReturnType<typeof readLaunchChild>>();
  for(const c of children){
    if(c.role===2&&terms&&!terms.vesting&&targetRole!==2)continue;
    const state=await source.getAccountState(c.address,{at:head,signal});
    if(state.accountState!=='active'){launchCheck(p.kind==='create'||c.role===2&&targetRole!==2);continue;}
    launchCheck(state.shardAccountBoc);const child=readLaunchChild(activeOrderAccount(orderShard(state.shardAccountBoc,c.address).shard,c.hash).data);
    launchCheck(child.id.factory===p.factory&&child.id.creator===p.creator&&child.id.nonce===BigInt(p.nonce)&&child.id.model===p.model&&child.id.role===c.role);loaded.set(c.role,child);completeAccounts.push(c.address);
    if(c.role===0&&child.config){const sale=readLaunchSaleConfig(child.config);launchCheck(sale.fee===manifest.contracts.FeeRouter?.address&&sale.lp===children[1].address&&sale.vesting===(sale.terms.vesting?children[2].address:null));if(terms)launchCheck(terms.cell.equals(sale.terms.cell));terms=sale.terms;}
  }
  launchCheck(terms);if(p.tokenRoot!==null)requireProduct(p.tokenRoot===manifest.contracts.T3Hub!.address||p.tokenRoot===terms.project);
  const t3=manifest.tokens.find(t=>t.symbol==='T3');launchCheck(t3&&t3.root===manifest.contracts.T3Hub?.address);
  const project=await readLaunchpadProjectToken(manifest,source,terms.project,head,signal);launchCheck(project.decimals===terms.decimals);
  const tokenPins=[t3,project];for(const a of p.assets){const pin=tokenPins.find(t=>t.root===a.root);requireProduct(pin&&a.masterCodeHash===pin.masterCodeHash&&a.walletCodeHash===pin.walletCodeHash);}
  for(const [role,child] of loaded)if(child.config){const expected=role===2?[project.root]:[t3.root,project.root];launchCheck(child.slots.size===expected.length&&expected.every((root,slot)=>child.slots.get(slot)?.master===root));}
  const wallets=createJettonWalletReader({source,tokens:tokenPins.map(t=>({master:t.root,masterCodeHash:t.masterCodeHash,walletCodeHash:t.walletCodeHash}))});
  if(p.sourceWallet!==null){const recovery=p.kind==='wallet-mark'||p.kind==='wallet-retry',expectedRoot=p.kind==='contribute'||recovery?t3.root:project.root;requireProduct(p.tokenRoot===expectedRoot);const origin=await wallets.identity(expectedRoot,recovery?p.target:p.owner,{at:head,signal});requireProduct(origin.wallet===p.sourceWallet);completeAccounts.push(origin.wallet);}
  // Request asset pins are checked against the installed release families and
  // canonical same-head masters; they never enroll a business decoder.
  for(const root of new Set(p.assets.map(a=>a.root)))await wallets.identity(root,p.owner,{at:head,signal});
  for(const [role,child] of loaded)for(const slot of child.slots.values())if(slot.wallet){const actual=await wallets.identity(slot.master,children[role].address,{at:head,signal});launchCheck(actual.wallet===slot.wallet);}
  if(parsed.owedSlot!==null){const slot=loaded.get(targetRole!)?.slots.get(parsed.owedSlot);launchCheck(slot&&p.assets.some(a=>a.root===slot.master&&a.recipient===p.owner));}
  return{head,request:p,factory,children,targetRole,pins,completeAccounts,terms,loaded,t3,project,wallets};
}
export async function collectLaunchpadOperationEvidence(manifest:RuntimeReleaseManifest,source:ChainSource,store:PhysicalEvidenceStore,parsed:ReturnType<typeof readLaunchpadOperationRequest>,signal?:AbortSignal):Promise<CurrentLaunchpadOperationEvidence>{
  const context=await readLaunchpadEvidenceContext(manifest,source,parsed,signal),{head,request:p,pins,completeAccounts}=context;
  const includeAccounts=new Set<string>();
  if(context.targetRole!==undefined)for(const slot of context.loaded.get(context.targetRole)?.slots.values()??[])if(slot.wallet)includeAccounts.add(slot.wallet);
  for(const asset of p.assets){const identity=await context.wallets.identity(asset.root,asset.recipient,{at:head,signal});includeAccounts.add(identity.wallet);}
  let poolContext:{pool:string;identityManifest:RuntimeReleaseManifest;market:RuntimeReleaseManifest['spotMarkets'][number];poolWallets:readonly{root:string;wallet:string}[]}|null=null;
  if(p.kind==='lp-seed'||p.kind==='lp-release'){
    const lp=context.loaded.get(1);launchCheck(lp?.config&&!lp.config.isExotic&&!lp.book.isExotic);
    const config=lp.config.beginParse(),peers=config.loadRef().beginParse();
    launchCheck(peers.loadAddress().toRawString()===p.sale&&peers.loadAddress().toRawString()===context.terms.lpRecipient&&peers.loadAddress().toRawString()===manifest.contracts.DlmmPoolFactory!.address);peers.endParse();
    config.loadInt(32);const poolId=config.loadRef();config.endParse();
    const book=lp.book.beginParse(),pool=book.loadMaybeAddress();book.loadUint(32);book.loadUint(32);book.loadCoins();book.loadCoins();book.endParse();
    if(pool){
      launchCheck(pool.workChain===0);const address=pool.toRawString(),state=await source.getAccountState(address,{at:head,signal});launchCheck(state.shardAccountBoc);
      const account=activeOrderAccount(orderShard(state.shardAccountBoc,address).shard,manifest.templates.DlmmPool);
      const identity=await publicPoolIdentity(manifest,source,head,address,account.data,signal);
      const derived=await source.runGetMethod(manifest.contracts.DlmmPoolFactory!.address,'get_pool_address',[{type:'cell',cell:poolId}],{at:head,signal});
      launchCheck(derived&&derived.exitCode===0&&derived.stack.length===1&&new TupleReader(derived.stack).readAddress().toRawString()===address);
      await assertPoolIdentity(identity.identityManifest,source,head,identity.market,signal);
      const poolWallets=await Promise.all([context.t3.root,context.project.root].map(root=>context.wallets.identity(root,address,{at:head,signal})));
      poolContext={pool:address,...identity,poolWallets};verifyPoolEvidenceIdentity(account.data,identity.identityManifest,poolContext,true);
      includeAccounts.add(address);pins.set(address,manifest.templates.DlmmPool);
    }
  }
  const graph=await collectProductPhysicalGraph(source,store,head,{owner:p.owner,target:parsed.dispatchTarget,body:parsed.body,dispatch:p.dispatch,pins,completeAccounts,includeAccounts:[...includeAccounts]},signal);
  if(poolContext)for(const row of graph.transactions)if(row.account===poolContext.pool)for(const shard of [verifyOrderTransaction(row).before,verifyOrderTransaction(row).after])if(shard.account?.storage.state.type==='active')verifyPoolEvidenceIdentity(activeOrderAccount(shard,manifest.templates.DlmmPool).data,poolContext.identityManifest,poolContext);
  assertFreshHeadTime(head.utime);signal?.throwIfAborted();return boundProductResponse<CurrentLaunchpadOperationEvidence>({schema:'tonswap-launchpad-operation-evidence-v1',releaseId:manifest.releaseId,manifestHash:manifest.manifestHash,
    asOf:{masterchainSeqno:head.seqno,unixTime:head.utime,blockRootHash:head.rootHashHex},request:{kind:p.kind,owner:p.owner,bodyHash:p.bodyHash},...graph},p.factory);
}

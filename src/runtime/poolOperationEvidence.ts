import { Address, Dictionary, TupleReader, beginCell, type Cell, type Slice } from '@ton/core';
import { validJettonWalletProfile, type JettonWalletBudget, type RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { ChainHead, ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { createJettonWalletReader } from '../data/jettonWallet';
import { activeOrderAccount, orderShard, verifyOrderTransaction } from '../orders/evidence';
import { assertPoolIdentity } from './spotOperationEvidence';
import { readLaunchpadProjectToken } from './launchpadEvidenceState';
import type { PhysicalEvidenceStore } from './physicalEvidence';
import { ProductEvidenceError, requireProduct, productUint, productAddress, productCell, productDispatch,
  collectProductPhysicalGraph, boundProductResponse, type ProductDispatch, type ProductPhysicalGraph } from './productEvidence';

export type CurrentPoolEvidenceRequest = {
  network: string; releaseId: string; manifestHash: string; kind: 'add'|'farm-create'|'farm-action'|'remove'|'owed';
  owner: string; pool: string; side: 0|1; queryId: string; amountRaw: string; binId: number|null; farmId: string|null;
  action: number|null; sourceWallet: string|null; bodyBoc: string; bodyHash: string; valueNano: string; createdAt: number; dispatch: ProductDispatch;
};
const wireAddress = (s: Slice) => { requireProduct(s.preloadUint(11) === 0b10000000000); return s.loadAddress().toRawString(); };
const bin = (value: unknown): number => { requireProduct(typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647); return value; };
const either = (s: Slice) => { if (s.loadBit()) { const result = s.loadRef(); s.endParse(); return result; } return beginCell().storeSlice(s).endCell(); };
export function readPoolOperationRequest(value: unknown, manifest: RuntimeReleaseManifest) {
  try {
    requireProduct(value && typeof value === 'object' && !Array.isArray(value)); const x = value as Record<string, unknown>;
    requireProduct(Object.keys(x).sort().join() === ['network','releaseId','manifestHash','kind','owner','pool','side','queryId','amountRaw','binId','farmId','action','sourceWallet','bodyBoc','bodyHash','valueNano','createdAt','dispatch'].sort().join());
    requireProduct(['add','farm-create','farm-action','remove','owed'].includes(String(x.kind)) && [0,1].includes(x.side as number));
    if (x.network !== manifest.network.slice(4) || x.releaseId !== manifest.releaseId || x.manifestHash !== manifest.manifestHash) throw new ProductEvidenceError(409, 'release_mismatch');
    productAddress(x.owner); productAddress(x.pool);
    const market = manifest.spotMarkets.find(m => m.pool === x.pool) ?? null;
    const query = productUint(x.queryId,64), amount = productUint(x.amountRaw,120, ['add','farm-create','owed'].includes(String(x.kind))), valueNano = productUint(x.valueNano,120,true), dispatch = productDispatch(x.dispatch);
    requireProduct(BigInt(dispatch.valueNano) <= valueNano && Number.isSafeInteger(x.createdAt) && Number(x.createdAt) > 0);
    const body = productCell(x.bodyBoc,x.bodyHash), s = body.beginParse(); let target: string;
    if (x.kind === 'add' || x.kind === 'farm-create') {
      target = productAddress(x.sourceWallet); bin(x.binId); requireProduct(x.farmId === null && x.action === null);
      requireProduct(s.loadUint(32) === 0x0f8a7ea5 && s.loadUintBig(64) === query && s.loadCoins() === amount
        && wireAddress(s) === x.pool && wireAddress(s) === x.owner && !s.loadMaybeRef() && s.loadCoins() > 0n);
      const p = either(s).beginParse();
      if (x.kind === 'add') {
        requireProduct(p.loadUint(32) === 0x4c514133 && wireAddress(p) === x.owner && p.loadBit() && p.loadUint(3) === 1);
        const row = p.loadRef().beginParse(); p.endParse(); requireProduct(row.loadInt(32) === x.binId && row.loadCoins() === amount && row.loadUintBig(256) > 0n && !row.loadMaybeRef()); row.endParse();
      } else {
        requireProduct(p.loadUint(32) === 0x464d4333 && p.loadInt(32) === x.binId); const duration = p.loadUint(32); requireProduct(duration >= 3600 && duration <= 7776000); p.endParse();
      }
    } else {
      target = String(x.pool); requireProduct(x.sourceWallet === null);
      if (x.kind === 'farm-action') {
        bin(x.binId); requireProduct(amount === 0n); const farmId = productUint(x.farmId,64,true); requireProduct(Number.isInteger(x.action) && Number(x.action) >= 1 && Number(x.action) <= 5);
        requireProduct(s.loadUint(32) === 0x464d4133 && s.loadUintBig(64) === query && s.loadUint(8) === x.action && s.loadUintBig(64) === farmId && wireAddress(s) === x.owner);
      } else if (x.kind === 'owed') {
        requireProduct(x.binId === null && x.farmId === null && x.action === null && s.loadUint(32) === 0x434c4d4a && s.loadUintBig(64) === query && s.loadUint(8) === x.side && wireAddress(s) === x.owner);
      } else {
        requireProduct(x.binId === null && x.farmId === null && x.action === null && amount === 0n && s.loadUint(32) === 0x4c515233 && s.loadUintBig(64) === query && wireAddress(s) === x.owner);
        s.loadUint(32); s.loadCoins(); s.loadCoins(); const count = s.loadUint(3); requireProduct(count >= 1 && count <= 2);
        let row: Cell|null = s.loadRef(); const bins = new Set<number>();
        for (let i = 0; i < count; i++) { requireProduct(row); const r: Slice = row.beginParse(), id = r.loadInt(32); requireProduct(!bins.has(id) && r.loadUintBig(256) > 0n); bins.add(id); row = r.loadMaybeRef(); r.endParse(); }
        requireProduct(row === null);
      }
      s.endParse();
    }
    return { request: structuredClone(x) as CurrentPoolEvidenceRequest, body, target, market };
  } catch (error) { if (error instanceof ProductEvidenceError) throw error; throw new ProductEvidenceError(400, 'bad_request'); }
}
export type CurrentPoolOperationEvidence = ProductPhysicalGraph & { schema: 'tonswap-pool-operation-evidence-v1'; releaseId: string; manifestHash: string;
  asOf: { masterchainSeqno: number; unixTime: number; blockRootHash: string }; request: { kind: CurrentPoolEvidenceRequest['kind']; owner: string; bodyHash: string } };
const unavailable = () => new ProductEvidenceError(503,'upstream_unavailable');
const budgetWidths = [['senderGas',32],['walletBounceGas',32],['burnWalletGas',32],['smallPayloadCells',16],['largeWalletGas',32],['largeSenderGas',32],['rentSeconds',32],['rentBits',32],['rentCells',16],['initBits',32],['initCells',16],['initCopies',8],['transferBits',16],['transferCells',8],['transferCopies',8]] as const;
const slotCodec = { serialize() { throw Error('read only'); }, parse(s: Slice) { const v = { master:s.loadAddress().toRawString(),wallet:s.loadMaybeAddress()?.toRawString()??null,gas:s.loadUint(32),gram:s.loadCoins(),optional:s.loadBit(),budget:s.loadRef() }; s.endParse();return v; } };
export function verifyPoolEvidenceIdentity(data: Cell, manifest: RuntimeReleaseManifest, context: { market: RuntimeReleaseManifest['spotMarkets'][number]; poolWallets: readonly { root: string; wallet: string }[] }, current = false) {
  const s=data.beginParse(),m=context.market,t3=manifest.tokens.find(t=>t.symbol==='T3'),x=manifest.tokens.find(t=>t.symbol===m.symbol); if(!t3||!x)throw unavailable();
  s.loadUint(8);if(s.loadUint(16)!==m.binSpacing||s.loadUint(32)!==m.feePips||s.loadUint(8)!==m.xDecimals)throw unavailable();
  s.loadInt(32);s.loadCoins();s.loadUint(16);s.loadUint(16);s.loadUint(8);const jet=s.loadRef().beginParse();s.loadRef();s.loadRef();const cold=s.loadRef().beginParse();s.endParse();
  if(cold.loadAddress().toRawString()!==manifest.contracts.DlmmPoolFactory?.address||cold.loadAddress().toRawString()!==manifest.contracts.FeeRouter?.address||cold.loadAddress().toRawString()!==manifest.contracts.Treasury?.address)throw unavailable();
  const slots=jet.loadDict(Dictionary.Keys.Uint(8),slotCodec),budget=beginCell();for(const [key,width]of budgetWidths)budget.storeUint(m.walletBudgetX[key],width);const profile=budget.storeBit(m.walletBudgetX.creditProtection).endCell();
  if(slots.size!==2)throw unavailable();
  for(const [side,token]of [t3,x].entries()){const slot=slots.get(side),wallet=context.poolWallets[side];if(!slot||slot.master!==token.root||wallet.root!==token.root||slot.optional!==(side===1)||current&&slot.wallet===null||slot.wallet!==null&&slot.wallet!==wallet.wallet)throw unavailable();if(side===1&&(slot.gas!==m.walletGasX||slot.gram.toString()!==m.walletGramX||!slot.budget.equals(profile)))throw unavailable();}
}
/** Public pools derive their identity from the pinned native factory. The
 * caller supplies only a pool address; token code/decimals never come from the
 * request or an observed unknown implementation. */
export async function publicPoolIdentity(manifest: RuntimeReleaseManifest, source: ChainSource, head: ChainHead, pool: string, data: Cell, signal?: AbortSignal) {
  const s=data.beginParse();s.loadUint(8);const binSpacing=s.loadUint(16),feePips=s.loadUint(32),xDecimals=s.loadUint(8);s.loadInt(32);s.loadCoins();s.loadUint(16);s.loadUint(16);s.loadUint(8);
  const jet=s.loadRef().beginParse(),slots=jet.loadDict(Dictionary.Keys.Uint(8),slotCodec),x=slots.get(1),t=slots.get(0);if(slots.size!==2||!x||!t||!x.optional||t.optional||t.master!==manifest.contracts.T3Hub?.address||x.master===t.master)throw unavailable();
  const token=await readLaunchpadProjectToken(manifest,source,x.master,head,signal);if(token.decimals!==xDecimals)throw unavailable();
  const b=x.budget.beginParse(),budget={} as JettonWalletBudget;for(const [key,width]of budgetWidths)budget[key]=b.loadUint(width);budget.creditProtection=b.loadBit();b.endParse();
  if(!validJettonWalletProfile(x.gas,x.gram.toString(),budget))throw unavailable();
  const id=beginCell().storeAddress(Address.parse(x.master)).storeUint(binSpacing,16).storeUint(feePips,32).storeUint(xDecimals,8).storeUint(x.gas,32).storeCoins(x.gram).storeRef(x.budget).endCell();
  const factory=manifest.contracts.DlmmPoolFactory;if(!factory)throw unavailable();
  const options={at:head,signal},[account,info,derived]=await Promise.all([source.getAccountState(factory.address,options),source.runGetMethod(factory.address,'get_factory_info',[],options),source.runGetMethod(factory.address,'get_pool_address',[{type:'cell',cell:id}],options)]);
  if(!account.shardAccountBoc)throw unavailable();activeOrderAccount(orderShard(account.shardAccountBoc,factory.address).shard,factory.codeHash);
  if(!info||info.exitCode!==0||info.stack.length!==11||!derived||derived.exitCode!==0||derived.stack.length!==1)throw unavailable();
  const f=new TupleReader(info.stack);for(const expected of [manifest.contracts.Governance?.address,manifest.contracts.FeeRouter?.address,manifest.contracts.Treasury?.address,t.master])if(!expected||f.readAddress().toRawString()!==expected)throw unavailable();
  f.readAddressOpt();for(const max of [0xffffffffn,0xffffn]){const n=f.readBigNumber();if(n<0n||n>max)throw unavailable();}
  if(f.readCell().hash().toString('hex')!==manifest.templates.DlmmPool)throw unavailable();
  f.readBigNumber();f.readBigNumber();f.readCell();if(f.remaining||new TupleReader(derived.stack).readAddress().toRawString()!==pool)throw unavailable();
  const known=manifest.tokens.find(t=>t.root===token.root),symbol=known?.symbol??`project:${token.root}`;
  const identityManifest=known?manifest:{...manifest,tokens:[...manifest.tokens,{...token,symbol}]};
  const market={symbol,pool,binSpacing,feePips,xDecimals,walletGasX:x.gas,walletGramX:x.gram.toString(),walletBudgetX:budget};
  return{market,identityManifest};
}
export async function readPoolEvidenceContext(manifest: RuntimeReleaseManifest, source: ChainSource, parsed: ReturnType<typeof readPoolOperationRequest>, signal?: AbortSignal, at?: ChainHead) {
  signal?.throwIfAborted();if(`ton:${source.network}`!==manifest.network)throw unavailable();
  const {request}=parsed,head=at??await source.head({signal});assertFreshHeadTime(head.utime);
  const state=await source.getAccountState(request.pool,{at:head,signal});if(!state.shardAccountBoc)throw unavailable();
  const pool=activeOrderAccount(orderShard(state.shardAccountBoc,request.pool).shard,manifest.templates.DlmmPool);
  const {market,identityManifest}=parsed.market?{market:parsed.market,identityManifest:manifest}:await publicPoolIdentity(manifest,source,head,request.pool,pool.data,signal);
  await assertPoolIdentity(identityManifest,source,head,market,signal);
  const tokens=[identityManifest.tokens.find(t=>t.symbol==='T3'),identityManifest.tokens.find(t=>t.symbol===market.symbol)];if(tokens.some(t=>!t))throw unavailable();
  const reader=createJettonWalletReader({source,tokens:tokens.map(t=>({master:t!.root,masterCodeHash:t!.masterCodeHash,walletCodeHash:t!.walletCodeHash}))});
  const [poolWallets,ownerWallets]=await Promise.all([Promise.all(tokens.map(t=>reader.identity(t!.root,request.pool,{at:head,signal}))),Promise.all(tokens.map(t=>reader.identity(t!.root,request.owner,{at:head,signal})))]),ownerWallet=ownerWallets[request.side];
  if(new Set(poolWallets.map(w=>w.wallet)).size!==2||poolWallets.some(w=>w.wallet===ownerWallet.wallet))throw unavailable();
  if(request.sourceWallet!==null&&request.sourceWallet!==ownerWallet.wallet)throw new ProductEvidenceError(400,'bad_request');
  verifyPoolEvidenceIdentity(pool.data,identityManifest,{market,poolWallets},true);
  // Only authenticated dictionary absence can omit an untouched canonical
  // seed. Any later causal message still forces the ordinary original-history
  // reader, so absence cannot manufacture a delivery or an empty transaction.
  const absent=new Set<string>();
  await Promise.all([...poolWallets,...ownerWallets].map(async w=>{
    const s=await source.getAccountState(w.wallet,{at:head,signal});
    if(!s.shardAccountBoc&&s.provenAbsent===true&&s.anchor&&s.anchor.genUtime<=head.utime&&s.accountState==='uninitialized'
      &&s.balance==='0'&&s.codeBoc===null&&s.dataBoc===null&&s.lastTxLt===undefined&&s.lastTxHash===undefined)absent.add(w.wallet);
  }));
  return {head,market,identityManifest,poolWallets,ownerWallet,ownerWallets,absent,pins:new Map([[request.pool,manifest.templates.DlmmPool]]),completeAccounts:[request.pool,...poolWallets.map(w=>w.wallet).filter(w=>!absent.has(w)),...(request.sourceWallet?[request.sourceWallet]:[])]};
}
export async function collectPoolOperationEvidence(manifest: RuntimeReleaseManifest, source: ChainSource, store: PhysicalEvidenceStore, parsed: ReturnType<typeof readPoolOperationRequest>, signal?: AbortSignal): Promise<CurrentPoolOperationEvidence> {
  const {request}=parsed,context=await readPoolEvidenceContext(manifest,source,parsed,signal),{head,pins,completeAccounts}=context;
  const graph=await collectProductPhysicalGraph(source,store,head,{owner:request.owner,target:parsed.target,body:parsed.body,dispatch:request.dispatch,pins,completeAccounts,
    includeAccounts:context.ownerWallets.map(w=>w.wallet).filter(w=>!context.absent.has(w))},signal);
  try {for(const row of graph.transactions)if(row.account===request.pool){const tx=verifyOrderTransaction(row);for(const shard of [tx.before,tx.after])if(shard.account?.storage.state.type==='active')verifyPoolEvidenceIdentity(activeOrderAccount(shard,manifest.templates.DlmmPool).data,context.identityManifest,context);}}
  catch {graph.coverage.complete=false;graph.coverage.gaps.push({code:'pool_release_config_mismatch',account:request.pool});}
  signal?.throwIfAborted();assertFreshHeadTime(head.utime);
  return boundProductResponse<CurrentPoolOperationEvidence>({schema:'tonswap-pool-operation-evidence-v1',releaseId:manifest.releaseId,manifestHash:manifest.manifestHash,asOf:{masterchainSeqno:head.seqno,unixTime:head.utime,blockRootHash:head.rootHashHex},request:{kind:request.kind,owner:request.owner,bodyHash:request.bodyHash},...graph},request.pool);
}

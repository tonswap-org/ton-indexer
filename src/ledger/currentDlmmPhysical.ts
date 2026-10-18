import { Address, beginCell, Cell, CellType, Dictionary, loadCommonMessageInfo, loadStateInit, storeMessage, type Slice } from '@ton/core';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import { verifyOrderTransaction, orderCell, type OrderTransactionEvidence } from '../orders/evidence';
import { readCurrentT3Wallet } from './currentT3State';
import { t3Attempt, t3PathRoot } from './currentT3Wire';
import { readCurrentDlmmPool, decodeDlmmBudget as decodeJettonWalletBudget, dlmmBudgetCell as jettonWalletBudgetToCell } from './currentDlmmState';
export type CurrentDlmmWallet={address:string;owner:string;root:string;codeHash:string};
export type CurrentDlmmPoolConfig={pool:string;market:RuntimeReleaseManifest['spotMarkets'][number];t3:RuntimeReleaseManifest['tokens'][number];x:RuntimeReleaseManifest['tokens'][number]};
export type CurrentDlmmConfigBinding={release:RuntimeReleaseManifest;pools:CurrentDlmmPoolConfig[]};
export type CurrentDlmmProofBinding={release:RuntimeReleaseManifest;orderWalletAbsences?:import('./currentDlmmOrderAbsence').CurrentOrderWalletAbsence[];pools:Array<CurrentDlmmPoolConfig&{wallets:CurrentDlmmWallet[]}>};
export function currentDlmmBindingFromManifest(release:RuntimeReleaseManifest):CurrentDlmmConfigBinding{
 const t3=release.tokens.find(t=>t.symbol==='T3'),hub=release.contracts.T3Hub;if(!hub||!t3||t3.root!==hub.address||t3.masterCodeHash!==hub.codeHash||t3.walletCodeHash!==release.templates.T3Wallet)throw Error('Current DLMM T3 pin');
 return{release,pools:release.spotMarkets.map(market=>{const x=release.tokens.find(t=>t.symbol===market.symbol);if(!x||x.decimals!==market.xDecimals||!(x.masterCodeHash===release.templates.JettonV21Minter&&x.walletCodeHash===release.templates.JettonV21Wallet||x.masterCodeHash===release.vendor.stablecoin.minter.codeHash&&x.walletCodeHash===release.vendor.stablecoin.wallet.codeHash))throw Error('Current DLMM token family');return{pool:market.pool,market,t3,x};})};
}
export type SpotPoolIdentity=CurrentDlmmPoolConfig&{release:RuntimeReleaseManifest;inSide:0|1};
type SpotWalletIdentity=CurrentDlmmWallet;
export type SpotChainWallets={pay:SpotWalletIdentity;receive:SpotWalletIdentity;poolPay:SpotWalletIdentity;poolReceive:SpotWalletIdentity};
export type SpotProofBinding={identity:SpotPoolIdentity;wallets:SpotChainWallets};
export type CurrentT3TransactionEvidence=OrderTransactionEvidence;
const verifiedTransactions=new WeakMap<OrderTransactionEvidence,{original:OrderTransactionEvidence;value:ReturnType<typeof verifyOrderTransaction>&{account:string}}>();
export function verifyCurrentT3Transaction(e:OrderTransactionEvidence){const cached=verifiedTransactions.get(e);if(cached&&Object.entries(cached.original).every(([k,v])=>e[k as keyof OrderTransactionEvidence]===v))return cached.value;const value={account:e.account,...verifyOrderTransaction(e)};verifiedTransactions.set(e,{original:{...e},value});return value;}
export type CurrentT3Transaction=ReturnType<typeof verifyCurrentT3Transaction>;
export const currentT3Cell=orderCell;
export function currentT3ActiveState(shard:CurrentT3Transaction['after'],codeHash:string){
 const state=shard.account?.storage.state;if(state?.type!=='active')throw Error('Current DLMM inactive account');const s=state.state;
 if(!s.code||!s.data||![CellType.Ordinary,CellType.Library].includes(s.code.type)||s.code.hash().toString('hex')!==codeHash||s.special||s.libraries?.size)throw Error('Current DLMM code pin');
 return{code:s.code,data:s.data,splitDepth:s.splitDepth??null};
}
export function readT3WalletStorage(c:Cell){const s=readCurrentT3Wallet(c);return{...s,owner:Address.parse(s.owner),master:Address.parse(s.master),proofCodeHash:BigInt('0x'+s.proofCodeHash),count:s.nextId};}
export function t3WalletAttemptFromCell(c:Cell){const a=t3Attempt(c);return{...a,owner:Address.parse(a.owner),recipient:Address.parse(a.recipient),details:{queryId:a.queryId,response:a.response?Address.parse(a.response):null,forwardValue:a.forwardValue,forwardPayload:a.forwardPayload,customPayload:a.customPayload}};}
export const t3WalletAttemptToCell=(a:ReturnType<typeof t3WalletAttemptFromCell>)=>a.cell;
export function readT3WalletRecord(c:Cell){const s=c.beginParse();if(c.isExotic)throw Error('Current DLMM record');const r={failed:s.loadBit(),cancelled:s.loadBit(),attempt:t3WalletAttemptFromCell(s.loadRef())};s.endParse();return r;}
export const verifyT3Witness=(c:Cell,id:bigint,p:Cell,root:bigint)=>t3PathRoot(id,c,p)===root;
export const T3_OP={T3_WALLET_DELIVERY:0x5433444c,T3_WALLET_RETRY:0x54335759};
const digest = (c: Cell) => c.hash().toString('hex');
const raw = (a: Address | null) => a?.toRawString() ?? null;
function requireProof(value: unknown, detail: string): asserts value { if (!value) throw Error(`Direct Spot proof: ${detail}`); }
function ordinary(c: Cell) { requireProof(!c.isExotic, 'ordinary cell required'); return c.beginParse(); }
const maybe = <T>(fn: () => T): T | null => { try { return fn(); } catch { return null; } };
const one = <T>(xs: readonly T[]) => xs.length === 1 ? xs[0] : null;
function either(s: Slice) { if (s.loadBit()) { const c = s.loadRef(); s.endParse(); return c; } return beginCell().storeSlice(s).endCell(); }
export function decodeSpotTokenTransfer(body: Cell, internal = false) {
  const s = ordinary(body); requireProof(s.loadUint(32) === (internal ? 0x178d4519 : 0x0f8a7ea5), 'TEP74 transfer');
  const query = s.loadUintBig(64), amount = s.loadCoins(), owner = raw(s.loadAddress()), response = raw(s.loadMaybeAddress());
  const custom = internal ? null : s.loadMaybeRef(), forwardValue = s.loadCoins(), payload = either(s);
  return { query, amount, owner, response, custom, forwardValue, payload };
}
function message(cell: Cell) {
  const s = ordinary(cell), info = loadCommonMessageInfo(s); let init = null;
  if (s.loadBit()) { if (s.loadBit()) { const ref = ordinary(s.loadRef()); init = loadStateInit(ref); ref.endParse(); } else init = loadStateInit(s); }
  const body = either(s); return {info,init,body};
}
function input(tx: CurrentT3Transaction, source?: string) {
  requireProof(tx.incoming, 'original incoming cell'); const m = message(tx.incoming);
  requireProof(m.info.type === 'internal' && !m.info.bounced && (source === undefined || raw(m.info.src) === source), 'input source'); return m;
}
const canonicalMessages=new WeakMap<Cell,string>();
const canonicalMessageHash=(c:Cell)=>{let h=canonicalMessages.get(c);if(!h){h=beginCell().store(storeMessage(message(c))).endCell().hash().toString('hex');canonicalMessages.set(c,h);}return h;};
export function verifySpotMessageLink(a: CurrentT3Transaction, b: CurrentT3Transaction) {
  // TON permits inline/reference placement for StateInit and body. Compare the whole
  // parsed message canonically while retaining both original transaction commitments.
  return !!b.incoming && b.tx.lt > a.tx.lt && a.outgoing.values().some(c => canonicalMessageHash(c)===canonicalMessageHash(b.incoming!));
}
/** Authenticate the immutable pool identity and discovered wallets in original state. */
export function verifySpotPoolData(data: Cell, b: { identity: SpotPoolIdentity; wallets: Pick<SpotChainWallets,'poolPay'|'poolReceive'> }) {
  const {identity:i,wallets:w}=b;readCurrentDlmmPool(data,i.pool);const s=ordinary(data);
  s.loadUint(8); const spacing = s.loadUint(16), fee = s.loadUint(32), decimals = s.loadUint(8);
  s.loadInt(32); s.loadCoins(); s.loadUint(16); s.loadUint(16); s.loadUint(8);
  const jet = ordinary(s.loadRef()); s.loadRef(); s.loadRef(); const cold = ordinary(s.loadRef()); s.endParse();
  requireProof(raw(cold.loadAddress()) === i.release.contracts.DlmmPoolFactory?.address && raw(cold.loadAddress()) === i.release.contracts.FeeRouter?.address &&
    raw(cold.loadAddress()) === i.release.contracts.Treasury?.address && spacing === i.market.binSpacing && fee === i.market.feePips && decimals === i.market.xDecimals, 'pool configuration');
  const slots = jet.loadDict(Dictionary.Keys.Uint(8), { serialize() { throw Error('read only'); }, parse(s) {
    const v = { master: raw(s.loadAddress()), wallet: raw(s.loadMaybeAddress()), gas: s.loadUint(32), gram: s.loadCoins(), optional: s.loadBit(), budget: decodeJettonWalletBudget(s.loadRef()) }; s.endParse(); return v;
  } });
  const t = slots.get(0), x = slots.get(1);
  requireProof(slots.size === 2 && t && x && t.master === i.t3.root && x.master === i.x.root && !t.optional && x.optional &&
    slots.get(i.inSide)?.wallet === w.poolPay.address && slots.get(1-i.inSide)?.wallet === w.poolReceive.address &&
    x.gas === i.market.walletGasX && x.gram === BigInt(i.market.walletGramX) &&
    jettonWalletBudgetToCell(x.budget).equals(jettonWalletBudgetToCell(i.market.walletBudgetX)), 'pool slots');
}
export function verifySpotPoolBoundary(tx: CurrentT3Transaction, b: { identity: SpotPoolIdentity; wallets: Pick<SpotChainWallets,'poolPay'|'poolReceive'> }) {
  requireProof(tx.succeeded && tx.account === b.identity.pool, 'pool execution');
  for (const state of [tx.before, tx.after]) verifySpotPoolData(currentT3ActiveState(state, b.identity.release.templates.DlmmPool).data, b);
}
/** Caller must authenticate the master-selected wallet identity for this release.
 * Layout selection follows the release code pin, never a shape-based fallback. */
export function readSpotWalletBalance(state: CurrentT3Transaction['after'], wallet: SpotWalletIdentity, b: Pick<SpotProofBinding,'identity'>) {
  requireProof([b.identity.t3,b.identity.x].some(token=>token.root===wallet.root && token.walletCodeHash===wallet.codeHash), 'release token identity');
  const isT3 = wallet.root === b.identity.t3.root, isV21 = wallet.codeHash === b.identity.release.templates.JettonV21Wallet;
  const read = (data: Cell) => {
    if (isT3) {
      requireProof(wallet.codeHash === b.identity.release.templates.T3Wallet, 'T3 code pin'); const d = readT3WalletStorage(data);
      requireProof(raw(d.owner) === wallet.owner && raw(d.master) === wallet.root && d.proofCodeHash === BigInt('0x' + b.identity.release.templates.T3RecoveryProof), 'T3 wallet configuration'); return d.balance;
    }
    requireProof(isV21 || wallet.codeHash === b.identity.release.vendor.stablecoin.wallet.codeHash, 'unsupported wallet code');
    const s = ordinary(data); if (!isV21) s.loadUint(4);
    const balance = s.loadCoins(); requireProof(raw(s.loadAddress()) === wallet.owner && raw(s.loadAddress()) === wallet.root, 'token wallet configuration'); s.endParse(); return balance;
  };
  if (!state.account || state.account.storage.state.type === 'uninit') return 0n;
  const active = currentT3ActiveState(state,wallet.codeHash);
  requireProof(active.splitDepth === null || isV21 && active.splitDepth === 8, 'wallet split depth');
  return read(active.data);
}
export function verifySpotWalletDelta(tx: CurrentT3Transaction, wallet: SpotWalletIdentity, delta: bigint, b: Pick<SpotProofBinding,'identity'>) {
  requireProof(tx.succeeded && tx.account === wallet.address, 'successful wallet transaction');
  const after = currentT3ActiveState(tx.after,wallet.codeHash), amount = readSpotWalletBalance(tx.after,wallet,b);
  let prior = 0n;
  if (tx.before.account?.storage.state.type === 'active') {
    const before = currentT3ActiveState(tx.before,wallet.codeHash); requireProof(before.splitDepth === after.splitDepth, 'wallet layout changed'); prior = readSpotWalletBalance(tx.before,wallet,b);
  } else requireProof(delta > 0n && (!tx.before.account || tx.before.account.storage.state.type === 'uninit'), 'wallet prior state');
  requireProof(amount - prior === delta, 'physical balance delta');
}
export function verifySpotTokenDelivery(source: CurrentT3Transaction, destination: CurrentT3Transaction, request: ReturnType<typeof decodeSpotTokenTransfer>, from: SpotWalletIdentity, to: SpotWalletIdentity, b: Pick<SpotProofBinding,'identity'>) {
  requireProof(from.root === to.root && from.codeHash === to.codeHash, 'same-token delivery');
  requireProof(verifySpotMessageLink(source,destination), 'delivery message linkage'); const m = input(destination,from.address);
  if (from.root === b.identity.t3.root) {
    const s = ordinary(m.body); requireProof(s.loadUint(32) === T3_OP.T3_WALLET_DELIVERY, 'T3 delivery'); const a = t3WalletAttemptFromCell(s.loadRef()); s.endParse();
    requireProof(!a.burn && a.originLt === source.tx.lt && a.attempt === 0n && raw(a.owner) === from.owner && raw(a.recipient) === to.owner && a.amount === request.amount &&
      a.details.queryId === request.query && raw(a.details.response) === request.response && a.details.forwardValue === request.forwardValue && a.details.customPayload === null &&
      either(ordinary(a.details.forwardPayload)).equals(request.payload), 'T3 original transfer binding');
  } else {
    const d = decodeSpotTokenTransfer(m.body,true); requireProof(d.query === request.query && d.amount === request.amount && d.owner === from.owner && d.response === request.response &&
      d.forwardValue === request.forwardValue && d.payload.equals(request.payload), 'TEP74 original transfer binding');
  }
  verifySpotWalletDelta(source,from,-request.amount,b); verifySpotWalletDelta(destination,to,request.amount,b);
}


export function currentDlmmPoolBinding(b:CurrentDlmmProofBinding,pool:string,owner:string,side:0|1):SpotProofBinding{
 const p=b.pools.find(v=>v.pool===pool);if(!p)throw Error('Current DLMM pool not installed');
 const identity={...p,release:b.release,inSide:side};const pay=side===0?p.t3:p.x,receive=side===0?p.x:p.t3;
 const wallet=(token:typeof pay,who:string)=>{const found=p.wallets.filter(w=>w.root===token.root&&w.owner===who&&w.codeHash===token.walletCodeHash);if(found.length!==1)throw Error('Current DLMM canonical wallet unavailable');return found[0];};
 return{identity,wallets:{pay:wallet(pay,owner),receive:wallet(receive,owner),poolPay:wallet(pay,pool),poolReceive:wallet(receive,pool)}};
}

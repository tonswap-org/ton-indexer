import { createHash } from 'node:crypto';
import { Address, beginCell, Cell, CellType, contractAddress, Dictionary, type Slice } from '@ton/core';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { ChainHead, ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { isSuccessfulGetterResult, parseCanonicalJettonRootData } from '../data/jettonAbi';
import { orderShard } from '../orders/evidence';
import { ProductEvidenceError } from './productEvidence';
const fail=()=>new ProductEvidenceError(503,'upstream_unavailable');
export function launchCheck(value:unknown):asserts value{if(!value)throw fail();}
const slice=(c:Cell)=>{launchCheck(!c.isExotic);return c.beginParse();};
const addr=(s:Slice)=>{const a=s.loadAddress();launchCheck(a.workChain===0);return a.toRawString();};
export type LaunchIdentity={factory:string;creator:string;nonce:bigint;model:number;role:number};
export function launchInitialData(id:LaunchIdentity){
  const identity=beginCell().storeAddress(Address.parse(id.factory)).storeAddress(Address.parse(id.creator)).storeUint(id.nonce,64).storeUint(id.model,8).storeUint(id.role,8).endCell();
  const book=id.role===0?beginCell().storeUint(0,16).storeCoins(0).storeCoins(0).storeCoins(0).storeCoins(0).storeCoins(0).storeUint(0,16).storeDict(null).endCell()
    :id.role===1?beginCell().storeAddress(null).storeUint(0,64).storeCoins(0).storeCoins(0).endCell():beginCell().storeCoins(0).storeCoins(0).storeCoins(0).storeUint(0,32).storeBit(false).endCell();
  return beginCell().storeRef(identity).storeMaybeRef(null).storeRef(beginCell().storeDict(null).storeDict(null).storeDict(null).endCell()).storeRef(book).endCell();
}
export const launchAddress=(id:LaunchIdentity,code:Cell)=>contractAddress(0,{code,data:launchInitialData(id)}).toRawString();
export function readLaunchFactory(data:Cell,manifest:RuntimeReleaseManifest){
  const s=slice(data),governance=addr(s);s.loadBit();const p=slice(s.loadRef()),master=addr(p),fee=addr(p),dlmm=addr(p),profile=slice(p.loadRef());p.endParse();
  profile.loadUint(32);profile.loadCoins();profile.loadRef();profile.endParse();const feeBps=s.loadUint(16);
  const codes=s.loadDict(Dictionary.Keys.Uint(8),{serialize(){throw fail();},parse(q:Slice){const code=q.loadRef();q.loadUint(32);q.loadUint(16);q.endParse();return code;}});s.endParse();
  const pins=[manifest.templates.SaleFixed,manifest.templates.SaleBonding,manifest.templates.SaleAuction,manifest.templates.LpVault,manifest.templates.VestingVault];
  launchCheck(governance===manifest.contracts.Governance?.address&&master===manifest.contracts.T3Hub?.address&&fee===manifest.contracts.FeeRouter?.address&&dlmm===manifest.contracts.DlmmPoolFactory?.address
    &&feeBps<=500&&codes.size===5&&pins.every((hash,i)=>codes.has(i)&&!codes.get(i)!.isExotic&&codes.get(i)!.hash().toString('hex')===hash));
  return{codes,pins};
}
export function readLaunchTerms(cell:Cell){
  const s=slice(cell),project=addr(s),lpRecipient=addr(s),decimals=s.loadUint(8);s.loadUint(32);s.loadUint(32);s.loadInt(32);
  const caps=slice(s.loadRef());for(let i=0;i<5;i++)caps.loadCoins();caps.endParse();const pricing=s.loadRef(),vesting=s.loadMaybeRef();s.endParse();
  let beneficiary:string|null=null;if(vesting){const v=slice(vesting);beneficiary=addr(v);v.loadCoins();v.loadUint(32);v.loadUint(32);v.loadUint(32);v.endParse();}
  launchCheck(decimals<=18&&!pricing.isExotic);return{project,decimals,lpRecipient,beneficiary,vesting:!!vesting,cell};
}
export function readLaunchChild(data:Cell){
  const s=slice(data),i=slice(s.loadRef()),id={factory:addr(i),creator:addr(i),nonce:i.loadUintBig(64),model:i.loadUint(8),role:i.loadUint(8)};i.endParse();
  launchCheck(id.model<=2&&id.role<=2);const config=s.loadMaybeRef(),managed=slice(s.loadRef());
  const slots=managed.loadDict(Dictionary.Keys.Uint(8),{serialize(){throw fail();},parse(q:Slice){const master=addr(q),wallet=q.loadMaybeAddress();launchCheck(!wallet||wallet.workChain===0);q.loadUint(32);q.loadCoins();const optional=q.loadBit();q.loadRef();q.endParse();return{master,wallet:wallet?.toRawString()??null,optional};}});
  managed.loadMaybeRef();managed.loadDict(Dictionary.Keys.Uint(8),Dictionary.Values.Cell());managed.endParse();const book=s.loadRef();s.endParse();return{id,config,slots,book};
}
export function readLaunchSaleConfig(config:Cell){
  const c=slice(config),feeBps=c.loadUint(16),p=slice(c.loadRef()),fee=addr(p),lp=addr(p),vesting=p.loadMaybeAddress();p.endParse();const terms=readLaunchTerms(c.loadRef());c.endParse();
  launchCheck(feeBps<=500&&(!vesting||vesting.workChain===0));return{fee,lp,vesting:vesting?.toRawString()??null,terms};
}

/** Public project roots use the installed current vendor families. Observed
 * hashes and request fields never enroll a master or wallet implementation. */
export async function readLaunchpadProjectToken(manifest: RuntimeReleaseManifest, source: ChainSource, root: string, head: ChainHead, signal?: AbortSignal) {
  signal?.throwIfAborted(); assertFreshHeadTime(head.utime);
  launchCheck(/^0:[0-9a-f]{64}$/.test(root) && root !== `0:${'0'.repeat(64)}` && `ton:${source.network}` === manifest.network);
  const known = manifest.tokens.find(token => token.root === root);
  const approved = known ? [{ masterCodeHash: known.masterCodeHash, walletCodeHash: known.walletCodeHash }]
    : [{ masterCodeHash: manifest.templates.JettonV21Minter, walletCodeHash: manifest.templates.JettonV21Wallet },
      { masterCodeHash: manifest.vendor.stablecoin.minter.codeHash, walletCodeHash: manifest.vendor.stablecoin.wallet.codeHash }];
  const options = { at: head, signal };
  const [account, getter] = await Promise.all([source.getAccountState(root, options), source.runGetMethod(root, 'get_jetton_data', [], options)]);
  launchCheck(account.accountState === 'active' && account.shardAccountBoc && account.anchor && account.anchor.genUtime <= head.utime);
  const shard = orderShard(account.shardAccountBoc, root).shard, state = shard.account?.storage.state;
  launchCheck(state?.type === 'active' && state.state.code && state.state.data && isSuccessfulGetterResult(getter));
  const executable = (cell: Cell) => cell.type === CellType.Ordinary || cell.type === CellType.Library;
  launchCheck(executable(state.state.code));
  const masterCodeHash = state.state.code.hash().toString('hex'), pairs = approved.filter(pin => pin.masterCodeHash === masterCodeHash);
  launchCheck(pairs.length > 0 && pairs.every(pin => pin.walletCodeHash === pairs[0].walletCodeHash));
  const walletCodeHash = pairs[0].walletCodeHash;
  const data = parseCanonicalJettonRootData(getter.stack);
  launchCheck(data && executable(data.walletCode) && data.walletCode.hash().toString('hex') === walletCodeHash);
  const content = slice(data.content); launchCheck(content.loadUint(8) === 0);
  const fields = content.loadDict(Dictionary.Keys.BigUint(256), { serialize() { throw fail(); }, parse(s: Slice) { const cell = s.loadRef(); s.endParse(); return cell; } }); content.endParse();
  const decimalsCell = fields.get(BigInt('0x' + createHash('sha256').update('decimals').digest('hex')));
  launchCheck(decimalsCell); let cell: Cell | undefined = decimalsCell, prefix = true, bytes = Buffer.alloc(0), cells = 0;
  while (cell) {
    launchCheck(++cells <= 4); const s = slice(cell);
    if (prefix) { launchCheck(s.loadUint(8) === 0); prefix = false; }
    launchCheck(s.remainingBits % 8 === 0 && s.remainingRefs <= 1);
    bytes = Buffer.concat([bytes, s.loadBuffer(s.remainingBits / 8)]); launchCheck(bytes.length <= 2);
    cell = s.remainingRefs ? s.loadRef() : undefined; s.endParse();
  }
  const text = bytes.toString('utf8'); launchCheck(/^(0|[1-9][0-9]?)$/.test(text));
  const decimals = Number(text); launchCheck(decimals <= 18 && (!known || decimals === known.decimals));
  signal?.throwIfAborted(); assertFreshHeadTime(head.utime);
  return { root, masterCodeHash, walletCodeHash, decimals };
}

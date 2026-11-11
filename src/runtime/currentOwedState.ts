import { Address, beginCell, Cell, Dictionary, type Slice } from '@ton/core';

/** Current native holders only. A caller must authenticate the code/address
 * before using this layout; getters cannot select or substitute a layout. */
export const OWED_ROLES = ['Governance','MerkleClaim','SwapCoordinator','PerpsEngine','RiskVault','OptionVault','FeeRouter','BuybackExecutor','EmissionsSplitter','CoverVault'] as const;
export type OwedRole = typeof OWED_ROLES[number] | 'DlmmPool';
export type OwedManifest = { contracts: Partial<Record<string,{address:string;codeHash:string}>>; templates: {DlmmPool:string};
  tokens: readonly {root:string;masterCodeHash:string;walletCodeHash:string;symbol:string;decimals:number}[];
  spotMarkets: readonly {pool:string;symbol:string;binSpacing:number;feePips:number;xDecimals:number}[] };
const fail=()=>Error('Unverified current owed holder');
export function owedCheck(value:unknown):asserts value {if(!value)throw fail();}
const s=(c:Cell)=>{owedCheck(!c.isExotic);return c.beginParse();};
const addr=(v:Slice)=>{const a=v.loadAddress().toRawString();owedCheck(/^0:[0-9a-f]{64}$/.test(a)&&!/^0:0+$/.test(a));return a;};
const onlyRead=()=>{throw fail();};
export function owedHolderPin(manifest:OwedManifest,holder:string,allowPublicPoolCandidate=false):{role:OwedRole;codeHash:string} {
  owedCheck(/^0:[0-9a-f]{64}$/.test(holder)&&!/^0:0+$/.test(holder)&&Address.parse(holder).toRawString()===holder);
  const matches=OWED_ROLES.filter(role=>manifest.contracts[role]?.address===holder);
  if(matches.length===1)return{role:matches[0],codeHash:manifest.contracts[matches[0]]!.codeHash};
  owedCheck(matches.length===0&&(allowPublicPoolCandidate||manifest.spotMarkets.some(m=>m.pool===holder)));return{role:'DlmmPool',codeHash:manifest.templates.DlmmPool};
}
export type OwedArchiveState={count:bigint;root:bigint;total:bigint;frontier:Map<number,bigint>};
export function emptyOwedArchive():OwedArchiveState {
  let h=beginCell().storeUint(0,8).endCell().hash();for(let i=0;i<64;i++)h=beginCell().storeUint(3,8).storeBuffer(h).storeBuffer(h).endCell().hash();
  return{count:0n,root:BigInt('0x'+h.toString('hex')),total:0n,frontier:new Map()};
}
export function readOwedArchive(cell:Cell|null):OwedArchiveState {
  if(!cell)return emptyOwedArchive();const q=s(cell),count=q.loadUintBig(65),root=q.loadUintBig(256),total=q.loadCoins(),frontier=new Map(q.loadDict(Dictionary.Keys.Uint(8),Dictionary.Values.BigUint(256)));q.endParse();
  owedCheck(count>0n&&count<=1n<<64n&&total<1n<<120n&&[...frontier.keys()].every(k=>k<64));return{count,root,total,frontier};
}
const slotCodec={serialize:onlyRead,parse(q:Slice){const out={master:addr(q),wallet:q.loadMaybeAddress()?.toRawString()??null,gas:q.loadUint(32),gram:q.loadCoins(),optional:q.loadBit(),budget:q.loadRef()};q.endParse();owedCheck(!out.budget.isExotic);return out;}};
const bookCodec={serialize:onlyRead,parse(q:Slice){const total=q.loadCoins(),count=q.loadUint(16),entries=q.loadDict(Dictionary.Keys.Address(),Dictionary.Values.BigVarUint(4)),archive=readOwedArchive(q.loadMaybeRef());q.endParse();let sum=archive.total;
  owedCheck(count===entries.size&&count<=1024);for(const[owner,amount]of entries){owedCheck(owner.workChain===0&&amount>0n&&amount<1n<<120n);sum+=amount;}
  owedCheck(sum===total&&total<1n<<120n);return{total,count,entries,archive};}};
export function readCurrentOwedState(data:Cell,role:OwedRole,manifest:OwedManifest,holder:string){
  const q=s(data),expected=(name:string)=>{const value=manifest.contracts[name]?.address;owedCheck(value);return value;},peer=(r:Slice,name:string)=>owedCheck(addr(r)===expected(name));
  let ledger:Cell,kind:'plain'|'managed'|'coordinator'|'pool'='managed';
  if(role==='Governance'){
    owedCheck(q.loadUint(8)<=1);q.loadMaybeAddress();q.loadUint(32);q.loadUintBig(64);q.loadUint(32);const a=s(q.loadRef());ledger=a.loadRef();a.loadRef();const treasury=a.loadMaybeAddress();owedCheck(!treasury||treasury.toRawString()===expected('Treasury'));a.endParse();
    if(q.loadBit()){peer(q,'MerkleClaim');q.loadUintBig(120);q.loadUintBig(120);}q.loadMaybeRef();q.loadUint(16);q.loadRef();q.loadRef();kind='plain';
  }else if(role==='MerkleClaim'){
    q.loadRef();peer(q,'Governance');const a=s(q.loadRef());ledger=a.loadRef();a.loadRef();peer(a,'Treasury');a.endParse();q.loadMaybeRef();q.loadMaybeRef();q.loadUintBig(120);q.loadUintBig(120);kind='plain';
  }else if(role==='DlmmPool'){
    const market=manifest.spotMarkets.find(m=>m.pool===holder);owedCheck(market);q.loadUint(8);owedCheck(q.loadUint(16)===market.binSpacing&&q.loadUint(32)===market.feePips&&q.loadUint(8)===market.xDecimals);q.loadInt(32);q.loadCoins();q.loadUint(16);q.loadUint(16);q.loadUint(8);ledger=q.loadRef();q.loadRef();q.loadRef();const cold=s(q.loadRef());peer(cold,'DlmmPoolFactory');peer(cold,'FeeRouter');peer(cold,'Treasury');cold.loadMaybeRef();cold.loadRef();cold.endParse();kind='pool';
  }else if(role==='SwapCoordinator'||role==='CoverVault'){
    peer(q,'Governance');peer(q,'Treasury');ledger=q.loadRef();q.loadRef();kind=role==='SwapCoordinator'?'coordinator':'managed';
  }else if(role==='PerpsEngine'||role==='OptionVault'){
    peer(q,'Governance');q.loadBit();q.loadRef();ledger=q.loadRef();q.loadRef();q.loadRef();
  }else if(role==='RiskVault'){
    peer(q,'Governance');q.loadBit();peer(q,'Treasury');ledger=q.loadRef();q.loadRef();q.loadMaybeRef();q.loadMaybeRef();q.loadUint(16);
  }else if(role==='FeeRouter'){
    peer(q,'Governance');q.loadRef();ledger=q.loadRef();q.loadRef();q.loadCoins();q.loadUint(16);q.loadCoins();
  }else if(role==='BuybackExecutor'){
    const peers=s(q.loadRef());peer(peers,'Governance');peer(peers,'Treasury');peer(peers,'GasVault');peers.endParse();q.loadMaybeRef();ledger=q.loadRef();q.loadRef();q.loadCoins();q.loadCoins();q.loadUint(32);
  }else{
    owedCheck(role==='EmissionsSplitter');const peers=s(q.loadRef());peer(peers,'Governance');peer(peers,'Treasury');peer(peers,'GasVault');peers.endParse();ledger=q.loadRef();q.loadRef();q.loadRef();const claim=q.loadMaybeAddress();owedCheck(!claim||claim.toRawString()===expected('MerkleClaim'));q.loadCoins();q.loadCoins();q.loadUint(32);q.loadUint(32);q.loadCoins();q.loadCoins();kind='plain';
  }
  q.endParse();const l=s(ledger),slots=l.loadDict(Dictionary.Keys.Uint(8),slotCodec),owed=l.loadDict(Dictionary.Keys.Uint(8),bookCodec);
  if(kind==='pool'){l.loadUintBig(256);l.loadMaybeRef();l.loadMaybeRef();}else if(kind!=='plain')l.loadMaybeRef();l.endParse();
  owedCheck(slots.size<=16&&[...owed.keys()].every(k=>slots.has(k)));
  for(const[,slot]of slots)owedCheck(manifest.tokens.some(t=>t.root===slot.master));
  if(role==='SwapCoordinator'&&slots.size)owedCheck(slots.size===1&&slots.get(0)?.master===expected('T3Hub'));
  return{slots,owed};
}
/** Verify one native append from the authenticated previous frontier. */
export function verifyOwedArchiveAppend(before:OwedArchiveState,after:OwedArchiveState,holder:string,slot:number,owner:string,amount:bigint){
  const hash=(c:Cell)=>BigInt('0x'+c.hash().toString('hex')),pair=(a:bigint,b:bigint)=>hash(beginCell().storeUint(3,8).storeUint(a,256).storeUint(b,256).endCell());
  owedCheck(before.count<1n<<64n&&after.count===before.count+1n&&amount>0n&&after.total===before.total+amount);
  let node=hash(beginCell().storeUint(1,8).storeAddress(Address.parse(holder)).storeUint(slot,8).storeUint(before.count,64).storeAddress(Address.parse(owner)).storeUint(amount,120).endCell()),zero=hash(beginCell().storeUint(0,8).endCell()),cursor=before.count,stored=false;const frontier=new Map(before.frontier);
  for(let level=0;level<64;level++,cursor>>=1n){if(cursor&1n){const left=frontier.get(level);owedCheck(left!==undefined);node=pair(left,node);}else{if(!stored){frontier.set(level,node);stored=true;}node=pair(node,zero);}zero=pair(zero,zero);}
  owedCheck(node===after.root&&frontier.size===after.frontier.size&&[...frontier].every(([level,value])=>after.frontier.get(level)===value));return true;
}

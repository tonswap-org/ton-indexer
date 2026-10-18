import { Address, beginCell, Cell, contractAddress, Dictionary, type DictionaryValue, type Slice } from '@ton/core';
import { validJettonWalletProfile } from '../config/runtimeManifest';
/** Exact current native child storage. Economic proof separately authenticates
 * original account code and factory-derived identities. No old sale layouts. */
type FreshJettonSlot = { master: Address; wallet: Address | null; walletGas: number; walletGram: bigint; optional: boolean; budget: Record<string, number | boolean> };
function decodeJettonWalletBudget(cell: Cell) {
 const s=cell.beginParse(), budget:Record<string,number|boolean>={};
 if(cell.isExotic)throw Error('Exotic Launchpad wallet profile');
 for(const [key,bits] of [['senderGas',32],['walletBounceGas',32],['burnWalletGas',32],['smallPayloadCells',16],['largeWalletGas',32],['largeSenderGas',32],['rentSeconds',32],['rentBits',32],['rentCells',16],['initBits',32],['initCells',16],['initCopies',8],['transferBits',16],['transferCells',8],['transferCopies',8]] as const)budget[key]=s.loadUint(bits);
 budget.creditProtection=s.loadBit();s.endParse();return budget;
}
function validateJettonWalletProfile(p: {walletGas:number;walletGram:bigint;budget:Record<string,number|boolean>}) {
 if(!validJettonWalletProfile(p.walletGas,p.walletGram.toString(),p.budget))throw Error('Invalid current Launchpad wallet profile');
}
export const LAUNCH_OP = { CREATE:0x53464e57, CREATED:0x53464556, CONTRIBUTE:0x53434f4e, FINALIZE:0x5346494e, CLAIM:0x53434c4d, CANCEL:0x5343414e,
  DISCOVER:0x44534357, OWED:0x434c4d4a, LP_SEED:0x4c565344, LP_RELEASE:0x4c56524c, VEST_CLAIM:0x5656434c, VEST_RETURN:0x56565254, EVENT:0x53455654 } as const;
export type NativeSaleKind = 0 | 1 | 2;
export type NativeLaunchRole = 0 | 1 | 2;
export type NativeSaleIdentity = { factory:Address; creator:Address; nonce:bigint; kind:NativeSaleKind; role:NativeLaunchRole };
export type NativeSaleCaps = { softCap:bigint; hardCap:bigint; minContribution:bigint; maxContribution:bigint; saleSupply:bigint };
export type NativeSaleVesting = { beneficiary:Address; amount:bigint; cliff:number; duration:number; period:number };
export type NativeSaleTerms = { projectMaster:Address; lpRecipient:Address; xDecimals:number; startTime:number; endTime:number; seedBin:number;
  caps:NativeSaleCaps; pricing:Cell; vesting:NativeSaleVesting|null };
export type NativeSalePricing = { kind:0; price:bigint } | { kind:1; curveKind:1; basePrice:bigint; slopeNumerator:bigint; slopeDenominator:bigint }
  | { kind:2; startPrice:bigint; reservePrice:bigint; decayInterval:number; tickSize:bigint };
export const launchContractError = (message:string) => new Error(`Current Launchpad: ${message}`);
function fail(message:string):never {throw launchContractError(message);}
const ordinary = (c:Cell) => {if(c.isExotic)fail('Exotic launchpad state');return c.beginParse();};
const addr = (s:Slice) => {const a=s.loadAddress();if(a.workChain!==0)fail('Launchpad requires basechain addresses');return a;};
const optionalAddr = (s:Slice) => {const a=s.loadMaybeAddress();if(a&&a.workChain!==0)fail('Launchpad requires basechain addresses');return a;};
const end = <T>(s:Slice,value:T):T => {s.endParse();return value;};
const codec = <T>(parse:(s:Slice)=>T):DictionaryValue<T> => ({serialize(){fail('Read-only launchpad codec');},parse});
const kind = (v:number):NativeSaleKind => {if(v!==0&&v!==1&&v!==2)fail('Unknown sale kind');return v as NativeSaleKind;};
const role = (v:number):NativeLaunchRole => {if(v!==0&&v!==1&&v!==2)fail('Unknown launchpad role');return v as NativeLaunchRole;};
const query = (op:number,q:bigint) => {if(q<=0n||q>=1n<<64n)fail('Invalid launchpad query');return beginCell().storeUint(op,32).storeUint(q,64);};
export const launchControlBody = (op:number,q:bigint) => query(op,q).endCell();
export const launchContributeBody = (minTokens:bigint) => {if(minTokens<=0n)fail('Minimum token amount required');return beginCell().storeUint(LAUNCH_OP.CONTRIBUTE,32).storeCoins(minTokens).endCell();};
export const launchSeedBody = (q:bigint,t3:bigint,x:bigint) => query(LAUNCH_OP.LP_SEED,q).storeCoins(t3).storeCoins(x).endCell();
export const launchReleaseBody = (q:bigint,t3:bigint,x:bigint,remove:boolean) => query(LAUNCH_OP.LP_RELEASE,q).storeCoins(t3).storeCoins(x).storeBit(remove).endCell();
export const launchOwedBody = (q:bigint,slot:0|1,owner:Address) => query(LAUNCH_OP.OWED,q).storeUint(slot,8).storeAddress(owner).endCell();
export function launchPricingCell(p:NativeSalePricing):Cell {
  if(p.kind===0)return beginCell().storeCoins(p.price).endCell();
  if(p.kind===1)return beginCell().storeUint(p.curveKind,8).storeCoins(p.basePrice).storeCoins(p.slopeNumerator).storeCoins(p.slopeDenominator).endCell();
  return beginCell().storeCoins(p.startPrice).storeCoins(p.reservePrice).storeUint(p.decayInterval,32).storeCoins(p.tickSize).endCell();
}
export function decodeLaunchPricing(k:NativeSaleKind,c:Cell):NativeSalePricing {
  const s=ordinary(c);if(k===0)return end(s,{kind:k,price:s.loadCoins()});
  if(k===1){const curveKind=s.loadUint(8);if(curveKind!==1)fail('Unknown native sale curve');return end(s,{kind:k,curveKind:1,basePrice:s.loadCoins(),slopeNumerator:s.loadCoins(),slopeDenominator:s.loadCoins()});}
  return end(s,{kind:k,startPrice:s.loadCoins(),reservePrice:s.loadCoins(),decayInterval:s.loadUint(32),tickSize:s.loadCoins()});
}
export function launchTermsCell(t:NativeSaleTerms):Cell {
  const c=t.caps,v=t.vesting;
  return beginCell().storeAddress(t.projectMaster).storeAddress(t.lpRecipient).storeUint(t.xDecimals,8).storeUint(t.startTime,32).storeUint(t.endTime,32).storeInt(t.seedBin,32)
    .storeRef(beginCell().storeCoins(c.softCap).storeCoins(c.hardCap).storeCoins(c.minContribution).storeCoins(c.maxContribution).storeCoins(c.saleSupply).endCell()).storeRef(t.pricing)
    .storeMaybeRef(v?beginCell().storeAddress(v.beneficiary).storeCoins(v.amount).storeUint(v.cliff,32).storeUint(v.duration,32).storeUint(v.period,32).endCell():null).endCell();
}
export function decodeLaunchTerms(c:Cell):NativeSaleTerms {
  const s=ordinary(c),projectMaster=addr(s),lpRecipient=addr(s),xDecimals=s.loadUint(8),startTime=s.loadUint(32),endTime=s.loadUint(32),seedBin=s.loadInt(32),a=ordinary(s.loadRef());
  const caps=end(a,{softCap:a.loadCoins(),hardCap:a.loadCoins(),minContribution:a.loadCoins(),maxContribution:a.loadCoins(),saleSupply:a.loadCoins()}),pricing=s.loadRef(),v=s.loadMaybeRef(),p=v?ordinary(v):null;
  return end(s,{projectMaster,lpRecipient,xDecimals,startTime,endTime,seedBin,caps,pricing,vesting:p?end(p,{beneficiary:addr(p),amount:p.loadCoins(),cliff:p.loadUint(32),duration:p.loadUint(32),period:p.loadUint(32)}):null});
}
export const launchCreateBody = (q:bigint,nonce:bigint,k:NativeSaleKind,terms:NativeSaleTerms) => query(LAUNCH_OP.CREATE,q).storeUint(nonce,64).storeUint(k,8).storeRef(launchTermsCell(terms)).endCell();
export function launchInitialData(id:NativeSaleIdentity):Cell {
  const identity=beginCell().storeAddress(id.factory).storeAddress(id.creator).storeUint(id.nonce,64).storeUint(id.kind,8).storeUint(id.role,8).endCell();
  const book=id.role===0?beginCell().storeUint(0,16).storeCoins(0).storeCoins(0).storeCoins(0).storeCoins(0).storeCoins(0).storeUint(0,16).storeDict(null).endCell()
    :id.role===1?beginCell().storeAddress(null).storeUint(0,64).storeCoins(0).storeCoins(0).endCell():beginCell().storeCoins(0).storeCoins(0).storeCoins(0).storeUint(0,32).storeBit(false).endCell();
  return beginCell().storeRef(identity).storeMaybeRef(null).storeRef(beginCell().storeDict(null).storeDict(null).storeDict(null).endCell()).storeRef(book).endCell();
}
export const launchChildAddress = (id:NativeSaleIdentity,code:Cell) => contractAddress(0,{code,data:launchInitialData(id)});
const codeCodec=codec(s=>end(s,{code:s.loadRef(),bits:s.loadUint(32),cells:s.loadUint(16)}));
export function decodeLaunchFactory(c:Cell) {
  const s=ordinary(c),governance=addr(s),closed=s.loadBit(),p=ordinary(s.loadRef()),t3Master=addr(p),feeSink=addr(p),dlmmFactory=addr(p),profile=ordinary(p.loadRef());p.endParse();
  const t3Profile=end(profile,{walletGas:profile.loadUint(32),walletGram:profile.loadCoins(),budget:decodeJettonWalletBudget(profile.loadRef())});validateJettonWalletProfile(t3Profile);
  return end(s,{governance,closed,t3Master,feeSink,dlmmFactory,t3Profile,feeBps:s.loadUint(16),codes:s.loadDict(Dictionary.Keys.Uint(8),codeCodec)});
}
const slotCodec=codec<FreshJettonSlot>(s=>{const slot=end(s,{master:addr(s),wallet:optionalAddr(s),walletGas:s.loadUint(32),walletGram:s.loadCoins(),optional:s.loadBit(),budget:decodeJettonWalletBudget(s.loadRef())});validateJettonWalletProfile(slot);return slot;});
export function decodeLaunchChild(c:Cell) {
  const s=ordinary(c),i=ordinary(s.loadRef()),identity=end(i,{factory:addr(i),creator:addr(i),nonce:i.loadUintBig(64),kind:kind(i.loadUint(8)),role:role(i.loadUint(8))});
  const config=s.loadMaybeRef(),m=ordinary(s.loadRef()),slots=m.loadDict(Dictionary.Keys.Uint(8),slotCodec),owed=m.loadMaybeRef(),recovery=m.loadDict(Dictionary.Keys.Uint(8),Dictionary.Values.Cell());m.endParse();
  return end(s,{identity,config,slots,owed,recovery,book:s.loadRef()});
}
export const launchEntryCodec=codec(s=>end(s,{paid:s.loadCoins(),tokens:s.loadCoins()}));
export function decodeLaunchSale(child:ReturnType<typeof decodeLaunchChild>) {
  if(child.identity.role!==0||!child.config)fail('Unconfigured sale');
  const s=ordinary(child.config!),feeBps=s.loadUint(16),p=ordinary(s.loadRef()),peers=end(p,{feeSink:addr(p),lpVault:addr(p),vestingVault:optionalAddr(p)}),termsCell=s.loadRef();s.endParse();
  const terms=decodeLaunchTerms(termsCell),b=ordinary(child.book),book=end(b,{ready:b.loadUint(8),phase:b.loadUint(8),inventory:b.loadCoins(),raised:b.loadCoins(),sold:b.loadCoins(),t3Due:b.loadCoins(),tokDue:b.loadCoins(),openEntries:b.loadUint(16),entries:b.loadDict(Dictionary.Keys.Address(),launchEntryCodec)});
  if(book.phase<1||book.phase>4||book.openEntries!==book.entries.size||book.openEntries>16384||feeBps>500)fail('Invalid sale book');
  const armed=!!child.slots.get(0)?.wallet&&!!child.slots.get(1)?.wallet&&book.inventory>=terms.caps.saleSupply+terms.caps.saleSupply/2n&&(book.ready&1)!==0&&(!terms.vesting||(book.ready&2)!==0);
  return{...child,feeBps,...peers,terms,termsCell,pricing:decodeLaunchPricing(child.identity.kind,terms.pricing),...book,armed};
}
export function decodeLaunchLp(child:ReturnType<typeof decodeLaunchChild>) {
  if(child.identity.role!==1||!child.config)fail('Unconfigured LP vault');
  const s=ordinary(child.config!),p=ordinary(s.loadRef()),peers=end(p,{sale:addr(p),lpRecipient:addr(p),dlmmFactory:addr(p)}),seedBin=s.loadInt(32),poolId=s.loadRef();s.endParse();
  const b=ordinary(child.book);return{...child,...peers,seedBin,poolId,...end(b,{pool:optionalAddr(b),armedAt:b.loadUint(32),unlockAt:b.loadUint(32),t3Bal:b.loadCoins(),tokenBal:b.loadCoins()})};
}
export function decodeLaunchVesting(child:ReturnType<typeof decodeLaunchChild>) {
  if(child.identity.role!==2||!child.config)fail('Unconfigured vesting vault');
  const s=ordinary(child.config!),sale=addr(s),v=ordinary(s.loadRef());s.endParse();const terms=end(v,{beneficiary:addr(v),amount:v.loadCoins(),cliff:v.loadUint(32),duration:v.loadUint(32),period:v.loadUint(32)});
  const b=ordinary(child.book);return{...child,sale,terms,...end(b,{deposited:b.loadCoins(),claimed:b.loadCoins(),returned:b.loadCoins(),start:b.loadUint(32),failed:b.loadBit()})};
}

tolk 1.5.0

import "@stdlib/gas-payments"
import "../shared/jetton/jetton_slots"
import "../shared/jetton/holder_recovery"
import "../shared/jetton/jetton_quotes"
import "../shared/math/full_math"
import "../dlmm/constants"
import "../dlmm/math"
import "pricing"

const SALE_MAX_ENTRIES = 16384
const SALE_ENTRY_DEPOSIT = 20000000
const SALE_BOUNCE_GAS = 250000
// Includes every owner-address prefix fork at full contributor capacity.
const SALE_CREDIT_GAS = 250000
const SALE_REFUND_TAIL_GAS = 350000
const SALE_FIN_GAS = 160000
const SALE_CLAIM_GAS = 250000
const LAUNCHPAD_INIT_GAS = 90000
const LAUNCHPAD_CONTROL_GAS = 50000
const LAUNCHPAD_RENT_SECONDS = 63072000
const ERR_SALE = 3300

struct SaleIdentity { factory: address; creator: address; nonce: uint64; kind: uint8; role: uint8 }
struct ChildStorage { identity: Cell<SaleIdentity>; config: cell?; jetton: Cell<JettonManagedLedger>; book: cell }
struct SaleCaps { softCap: coins; hardCap: coins; minContribution: coins; maxContribution: coins; saleSupply: coins }
struct SaleVesting { beneficiary: address; amount: coins; cliff: uint32; duration: uint32; period: uint32 }
struct SaleTerms { projectMaster: address; lpRecipient: address; xDecimals: uint8; startTime: uint32; endTime: uint32; seedBin: int32;
    caps: Cell<SaleCaps>; pricing: cell; vesting: Cell<SaleVesting>? }
struct FixedPricing { price: coins }
struct BondingPricing { curveKind: uint8; basePrice: coins; slopeNumerator: coins; slopeDenominator: coins }
struct AuctionPricing { startPrice: coins; reservePrice: coins; decayInterval: uint32; tickSize: coins }
struct T3Profile { walletGas: uint32; walletGram: coins; budget: Cell<JettonWalletBudget> }
struct SalePeers { feeSink: address; lpVault: address; vestingVault: address? }
struct SaleConfig { feeBps: uint16; peers: Cell<SalePeers>; terms: Cell<SaleTerms> }
struct SaleEntry { paid: coins; tokens: coins }
struct SaleBook { ready: uint8; phase: uint8; inventory: coins; raised: coins; sold: coins; t3Due: coins; tokDue: coins; openEntries: uint16; entries: map<address, SaleEntry> }
struct (0x53494e49) SaleInit { feeBps: uint16; t3Master: address; profile: Cell<T3Profile>; peers: Cell<SalePeers>; terms: Cell<SaleTerms> }
struct (0x43524459) ChildReady { role: uint8 }
struct (0x53434f4e) SaleContribute { minTokens: coins }
struct (0x5346494e) SaleFinalize { queryId: uint64 }
struct (0x53434c4d) SaleClaim { queryId: uint64 }
struct (0x5343414e) SaleCancel { queryId: uint64 }
struct (0x4c56474f) LpResult { success: bool }
struct (0x56565253) VestResult { success: bool }
struct (0x53455654) SaleEvent { queryId: uint64; kind: uint8; owner: address?; a: coins; b: coins }

fun ChildStorage.load(): ChildStorage { return ChildStorage.fromCell(contract.getData()); }
fun ChildStorage.save(self) { contract.setData(self.toCell()); }
fun ChildStorage.ledger(self):JettonLedger{return self.jetton.load().ledger;}
fun ChildStorage.setLedger(mutate self,ledger:JettonLedger){var m=self.jetton.load();m.ledger=ledger;self.jetton=m.toCell();}
fun ChildStorage.initRecovery(mutate self){var m=self.jetton.load();val slot=m.ledger.slots.get(0);if(slot.isFound&&slot.loadValue().budget.load().creditProtection){m.recovery.slots.set(0,jetton_empty_recovery());}self.jetton=m.toCell();}
fun ChildStorage.dispatch(mutate self,slot:uint8,amount:coins){var m=self.jetton.load();m.recovery.dispatch(slot,amount);self.jetton=m.toCell();}
fun ChildStorage.handled(mutate self,slot:uint8,amount:coins){var m=self.jetton.load();m.recovery.handled(slot,amount);self.jetton=m.toCell();}
fun ChildStorage.restored(mutate self,slot:uint8,amount:coins){var m=self.jetton.load();m.recovery.restored(slot,amount);self.jetton=m.toCell();}
fun ChildStorage.protected(self,slot:uint8):bool{return self.jetton.load().recovery.get(slot)!=null;}
fun launchpad_return(to: address) { createMessage({bounce:BounceMode.NoBounce,dest:to,value:0}).send(128 | 2); }
fun launchpad_reserve(value: coins) { reserveGramsOnBalance(max(contract.getOriginalBalance()-value,0),RESERVE_MODE_EXACT_AMOUNT); }
fun launchpad_control_value(): coins { return calculateGasFee(BASECHAIN, LAUNCHPAD_CONTROL_GAS)+calculateForwardFee(BASECHAIN,1300,2); }
// These code/data envelopes are qualified against the compiled children in the gas suite.
fun launchpad_rent(duration: int): coins { return calculateStorageFee(BASECHAIN, LAUNCHPAD_RENT_SECONDS+duration,400000,1200); }
fun launchpad_init_value(duration: int): coins { return launchpad_rent(duration)+calculateGasFee(BASECHAIN,LAUNCHPAD_INIT_GAS)
    +jetton_min_discover(1)+2*launchpad_control_value(); }
fun launchpad_initial(identity: SaleIdentity, book: cell): cell { return ChildStorage{identity:identity.toCell(),config:null,
    jetton:JettonManagedLedger{ledger:JettonLedger{slots:createEmptyMap(),owed:createEmptyMap()},recovery:JettonRecoveries{slots:createEmptyMap()}}.toCell(),book}.toCell(); }
fun sale_empty_book(): cell { return SaleBook{ready:0,phase:0,inventory:0,raised:0,sold:0,t3Due:0,tokDue:0,openEntries:0,entries:createEmptyMap()}.toCell(); }
fun sale_bond_cost(p: BondingPricing, sold: int): int {
    return mul_div_round_up(sold,2*p.slopeDenominator*p.basePrice+p.slopeNumerator*sold,2*p.slopeDenominator*LAUNCHPAD_PRICE_SCALE);
}
fun sale_bond_safe(p: BondingPricing, sold: int): bool {
    return p.slopeNumerator*sold <= p.slopeDenominator*(LAUNCHPAD_MAX_PRICE-p.basePrice);
}
fun sale_price(kind: int, terms: SaleTerms, at: int): coins {
    if(kind==0){return FixedPricing.fromCell(terms.pricing).price;}
    if(kind==1){return BondingPricing.fromCell(terms.pricing).basePrice;}
    val p=AuctionPricing.fromCell(terms.pricing);
    return max(p.reservePrice,p.startPrice-max(at-terms.startTime,0)/p.decayInterval*p.tickSize);
}
fun sale_quote(kind: int, terms: SaleTerms, sold: coins, payment: coins, at: int): (coins, coins, coins) {
    val price=sale_price(kind,terms,at);
    if(kind!=1){val n=launchpad_tokens_for_payment(payment,price);return(n,launchpad_payment_for_tokens(n,price),price);}
    val p=BondingPricing.fromCell(terms.pricing);val cap=terms.caps.load();val start=sale_bond_cost(p,sold);
    var low=0;var high=cap.saleSupply-sold;
    while(low<high){val mid=low+(high-low+1)/2;if(sale_bond_cost(p,sold+mid)-start<=payment){low=mid;}else{high=mid-1;}}
    return(low,sale_bond_cost(p,sold+low)-start,price);
}
fun sale_terms_valid(kind: int, terms: SaleTerms): bool {
    val c=terms.caps.load();
    if(c.toCell().hash()!=terms.caps.hash()){return false;}
    if(kind>2 || terms.projectMaster.getWorkchain()!=0 || terms.lpRecipient.getWorkchain()!=0 || terms.xDecimals>18
        || !dlmm_bin_valid(terms.seedBin,POOL_PUBLIC_BIN_SPACING,terms.xDecimals)
        || terms.startTime<blockchain.now()+300 || terms.endTime<terms.startTime+900 || terms.endTime-terms.startTime>7776000
        || c.softCap<10000000000 || c.softCap>c.hardCap || c.minContribution==0 || c.minContribution>c.maxContribution
        || c.maxContribution>c.hardCap || c.minContribution*SALE_MAX_ENTRIES<c.hardCap || c.saleSupply==0 || c.saleSupply>=(1<<118)){return false;}
    if(terms.vesting!=null){val v=terms.vesting!.load();if(v.toCell().hash()!=terms.vesting!.hash()){return false;}if(v.beneficiary.getWorkchain()!=0||v.amount==0||v.cliff>v.duration||v.duration>315360000||v.period==0||v.period>v.duration){return false;}}
    if(kind==1){val p=BondingPricing.fromCell(terms.pricing);return p.toCell().hash()==terms.pricing.hash()&& p.curveKind==1&&p.basePrice>0&&p.basePrice<=LAUNCHPAD_MAX_PRICE&&p.slopeDenominator>0
        &&sale_bond_safe(p,c.saleSupply)&&sale_bond_cost(p,c.saleSupply)>=c.softCap;}
    var low:coins=0;var high:coins=0;
    if(kind==0){val p=FixedPricing.fromCell(terms.pricing);if(p.toCell().hash()!=terms.pricing.hash()){return false;}low=p.price;high=p.price;}
    else{val p=AuctionPricing.fromCell(terms.pricing);if(p.toCell().hash()!=terms.pricing.hash()){return false;}if(p.decayInterval==0||p.tickSize==0){return false;}low=p.reservePrice;high=p.startPrice;}
    return low>0&&low<=high&&high<=LAUNCHPAD_MAX_PRICE&&launchpad_tokens_for_payment(c.minContribution,high)>0&&launchpad_payment_for_tokens(c.saleSupply,low)>=c.softCap;
}

struct VestConfig { sale: address; terms: Cell<SaleVesting> }
struct VestBook { deposited: coins; claimed: coins; returned: coins; start: uint32; failed: bool }
struct (0x5656494e) VestInit { sale: address; projectMaster: address; terms: Cell<SaleVesting> }
fun vest_empty_book():cell{return VestBook{deposited:0,claimed:0,returned:0,start:0,failed:false}.toCell();}
struct LpPeers { sale: address; lpRecipient: address; dlmmFactory: address }
struct LpConfig { peers: Cell<LpPeers>; seedBin: int32; poolId: cell }
struct LpBook { pool: address?; armedAt: uint32; unlockAt: uint32; t3Bal: coins; tokenBal: coins }
struct LpInitMore { dlmmFactory: address; t3Master: address; projectMaster: address; profile: Cell<T3Profile> }
struct (0x4c56494e) LpInit { sale: address; lpRecipient: address; seedBin: int32; more: Cell<LpInitMore>; poolId: cell }
fun lp_empty_book():cell{return LpBook{pool:null,armedAt:0,unlockAt:0,t3Bal:0,tokenBal:0}.toCell();}

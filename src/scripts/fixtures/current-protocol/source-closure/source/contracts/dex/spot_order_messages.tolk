tolk 1.5.0

import "@stdlib/gas-payments";
import "@gen/op/orders";
import "../shared/jetton/jetton_quotes";
import "../shared/jetton/tep74_codec";
import "../shared/dex/swap_payload";

const ORDER_ACTIVE = 1;
const ORDER_EXECUTING = 2;
const ORDER_CLOSED = 3;
const ORDER_FILLED = 1;
const ORDER_CANCELLED = 2;
const ORDER_EXPIRED = 3;
const ORDER_EXEC_DOMAIN = 9223372036854775808;
const ORDER_ATTEMPT_GAP = 60;
const ORDER_STUCK_TIMEOUT = 3600;
const ORDER_MIN_TIP = 20000000;
const ORDER_CLOSE_REWARD_GAS = 150000;
const ORDER_CLOSED_RESERVE = 10000000;
const ORDER_RENT_RESERVE = 20000000;
const ORDER_EXEC_GAS = 60000;
const ORDER_CREATE_GAS = 60000;
const ORDER_INIT_GAS = 30000;
const ORDER_CONTROL_GAS = 40000;
const ORDER_CREDIT_GAS = 40000;
const ORDER_BOUNCE_GAS = 40000;
// A terminal refund never needs a reply to settle order state.
const ORDER_CLOSED_BOUNCE_GAS = 0;
const ORDER_FORWARD_GAS = 400000;
const ERR_ORDER_AUTH = 1240;
const ERR_ORDER_STATE = 1241;
const ERR_ORDER_ELIGIBLE = 1242;
const ERR_ORDER_VALUE = 1243;
const ERR_ORDER_SLOT = 1244;
const ERR_ORDER_GAP = 1245;
const ERR_ORDER_FORWARD = 1246;
const ERR_ORDER_TERMS = 1247;

struct OrderNums {
    amountIn: coins;
    minOutTotal: coins;
    slices: uint8;
    interval: uint32;
    startAt: uint32;
    expiresAt: uint32;
    tipPerSlice: coins;
    forwardGas: uint32;
    walletGas: uint32;
    walletGram: coins;
    executor: address?;
    walletBudget: Cell<JettonWalletBudget>;
}
struct OrderTerms { inputMaster: address; pool: address; sellIndex: uint1; recipient: address; nums: Cell<OrderNums> }
struct OrderPeers { inputWallet: address?; keeper: address?; prevKeeper: address? }
struct OrderBody {
    state: uint2;
    closeReason: uint2;
    executedSlices: uint8;
    execId: uint32;
    lastExecutedAt: uint32;
    attemptAt: uint32;
    cancelRequested: bool;
    refundSeen: bool;
    // 0 none, 1 matching SWR3 credit, 2 matching JCLR credit.
    refundKind: uint2;
    // 0 none, 1 REFUND, 2 INPUT_OWED.
    refusal: uint2;
    peers: Cell<OrderPeers>;
    terms: Cell<OrderTerms>;
}
struct OrderStorage { factory: address; owner: address; nonce: uint64; body: Cell<OrderBody>? }
struct OrderFactoryStorage { orderCode: cell; salt: uint64 }
struct (0x4f435254) CreateOrder { queryId: uint64; nonce: uint64; terms: Cell<OrderTerms> }
struct (0x4f494e49) OrderInit { queryId: uint64; terms: Cell<OrderTerms> }
struct (0x4f455845) ExecuteSlice { queryId: uint64; forwardGram: coins }
struct (0x4f434e4c) CancelOrder { queryId: uint64 }
struct (0x4f434c53) CloseExpired { queryId: uint64 }
struct (0x4f574452) WithdrawJetton { queryId: uint64; wallet: address; amount: coins; recovery: cell? }
struct (0x4f4b5044) KeeperPaid { execId: uint32; status: uint8; tip: coins }
struct (0x4f434c44) OrderClosed { reason: uint8; executedSlices: uint8; refund: coins; away: coins }

@inline
fun order_slice(amountIn: coins, slices: int, done: int): coins {
    return done == slices - 1 ? amountIn - (slices - 1) * (amountIn / slices) : amountIn / slices;
}
@inline
fun order_sold(amountIn: coins, slices: int, done: int): coins { return done == slices ? amountIn : done * (amountIn / slices); }
@inline
fun order_leg(n: OrderNums, fwd: coins, bits: int, cells: int, bounceGas: int): coins {
    return jetton_leg_value(n.walletGas,n.walletGram,n.walletBudget.load(),fwd,bits,cells,bounceGas);
}
fun order_refund_forward(): coins { return calculateGasFee(BASECHAIN,ORDER_CREDIT_GAS); }
fun order_forward_floor(n: OrderNums): coins {
    return calculateGasFee(BASECHAIN,max(n.forwardGas,ORDER_FORWARD_GAS)) + swap_aux_value() + swap_log_fee()
        + order_leg(n,order_refund_forward(),628,1,POOL_BOUNCE_GAS) + jetton_recovery_rent();
}
fun order_exec_fee(): coins {
    return calculateGasFee(BASECHAIN,ORDER_EXEC_GAS) + 2 * calculateForwardFee(BASECHAIN,2000,3);
}
fun order_control_value(): coins { return calculateGasFee(BASECHAIN,ORDER_CONTROL_GAS) + 3 * calculateForwardFee(BASECHAIN,2000,3); }
fun order_close_reward(): coins {
    return max(ORDER_MIN_TIP,calculateGasFee(BASECHAIN,ORDER_CLOSE_REWARD_GAS) + 3*calculateForwardFee(BASECHAIN,2000,4));
}
fun order_close_balance(n: OrderNums,b: OrderBody,peers: OrderPeers): coins {
    val away=b.state==ORDER_EXECUTING && !b.refundSeen?order_slice(n.amountIn,n.slices,b.executedSlices):(0 as coins);
    val refund=n.amountIn-order_sold(n.amountIn,n.slices,b.executedSlices)-away;
    val leg=refund>0 && peers.inputWallet!=null?order_leg(n,0,0,0,ORDER_CLOSED_BOUNCE_GAS):(0 as coins);
    return order_close_reward()+leg+ORDER_CLOSED_RESERVE+2*calculateForwardFee(BASECHAIN,2000,4);
}
fun order_bond(n: OrderNums): coins {
    // Expiry leaves at least one unearned slice tip; final success cannot also expire.
    return (n.slices-1)*n.tipPerSlice + max(n.tipPerSlice,order_close_reward()) + ORDER_CLOSED_RESERVE + ORDER_RENT_RESERVE
        + jetton_discover_value(n.walletGram) + 2*order_leg(n,0,0,0,ORDER_CLOSED_BOUNCE_GAS) + calculateGasFee(BASECHAIN,ORDER_INIT_GAS);
}
fun order_initial(factory: address, owner: address, nonce: uint64): cell { return OrderStorage { factory,owner,nonce,body:null }.toCell(); }
fun order_validate(terms: Cell<OrderTerms>, owner: address): OrderTerms {
    val t=terms.load(); val n=t.nums.load();
    // fromCell/load assertEnd, including every immutable profile reference.
    val profile=jetton_budget_try_parse(n.walletBudget as cell);
    assert (owner.getWorkchain()==0 && t.inputMaster.getWorkchain()==0 && t.pool.getWorkchain()==0
        && t.recipient.getWorkchain()==0 && t.pool!=t.inputMaster && t.recipient!=t.pool
        && (n.executor==null || n.executor!.getWorkchain()==0)) throw ERR_ORDER_TERMS;
    val now=blockchain.now(); val start=max(n.startAt,now);
    assert (n.slices>=1 && n.slices<=50 && n.amountIn>=n.slices && n.minOutTotal>0
        && ((n.slices==1 && n.interval==0) || (n.slices>1 && n.interval>=120 && n.interval<=86400))
        && n.startAt<=now+2592000 && start+(n.slices-1)*n.interval<n.expiresAt && n.expiresAt<=now+7776000
        && n.tipPerSlice>=ORDER_MIN_TIP && n.forwardGas>=ORDER_FORWARD_GAS
        && n.walletGas>=10000 && n.walletGas<=500000 && n.walletGram<=500000000
        && profile!=null && jetton_budget_valid(profile!,n.walletGas)) throw ERR_ORDER_TERMS;
    return t;
}

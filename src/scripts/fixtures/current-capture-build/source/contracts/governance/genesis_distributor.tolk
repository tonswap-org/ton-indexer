tolk 1.5.0

import "@gen/op/tep";
import "@stdlib/gas-payments"
import "genesis_types"
import "../shared/jetton/vendor_minter"
import "../shared/jetton/jetton_slots"
import "../shared/jetton/jetton_sweep"
import "../shared/jetton/jetton_quotes"
import "../shared/jetton/tep74_codec"
import "../shared/utils/error_codes"
import "@gen/op/governance"
import "@gen/op/restricted_jetton_change_admin"

const GENS_GAS = 70000
const GENS_FLOOR = 1000000000
const MINTER_MINT_GAS = 8000
const WALLET_DEPLOY_BITS = 7025
const WALLET_DEPLOY_CELLS = 13

struct GenesisCodes { metadata: cell; merkleClaimCode: cell; remintCode: cell }
struct GenesisStorage {
    sent: bool
    nominationFailed: bool
    campaign: Cell<Campaign>
    governance: address
    emissionsSplitter: address
    treasury: address
    codes: Cell<GenesisCodes>
}
struct (0x47454e53) GenesisSend { queryId: uint64 }
struct (0x474e4556) GenesisEvent { master: address; merkleClaim: address; remint: address; total: uint120 }

fun GenesisStorage.load(): GenesisStorage { return GenesisStorage.fromCell(contract.getData()); }
fun GenesisStorage.save(self) { contract.setData(self.toCell()); }

fun genesis_ledger(master: address): Cell<JettonLedger> {
    var ledger = JettonLedger { slots: [], owed: [] };
    ledger.slotAdd(0, master, JETTON_V21_WALLET_GAS, 0, false, jetton_standard_budget(JETTON_V21_WALLET_GAS));
    return ledger.toCell();
}
fun GenesisStorage.identities(self): (address, address, address) {
    val codes = self.codes.load();
    val master = jetton_v21_minter_address(contract.getAddress(), codes.metadata);
    val jetton = genesis_ledger(master);
    val claim = MerkleClaimStorage { campaign: self.campaign, governance: self.governance, assets: MerkleClaimAssets { ledger: jetton,
            sweeps: JettonSweeps { busy: 0, slots: [] }.toCell(), treasury: self.treasury }.toCell(),
        bitmap: [], vesting: [], acceptedTotal: 0, acceptedDeferred: 0 };
    val remint = RemintStorage { jetton, cfg: RemintConfig { governance: self.governance, emissionsSplitter: self.emissionsSplitter }.toCell(),
        rateBps: 9000, day: 0, burnedToday: 0, burnedYesterday: 0, minted: false };
    return (master,
        AutoDeployAddress { workchain: BASECHAIN, stateInit: { code: codes.merkleClaimCode, data: claim.toCell() } }.calculateAddress(),
        AutoDeployAddress { workchain: BASECHAIN, stateInit: { code: codes.remintCode, data: remint.toCell() } }.calculateAddress());
}
fun GenesisStorage.minimum(self): coins {
    val codes = self.codes.load();
    val minterState = jetton_v21_minter_init(contract.getAddress(), codes.metadata).stateInit;
    assert (minterState is ContractState) throw ERR_GOVERNANCE_CONFIG;
    val codeSize = minterState.code.calculateSizeStrict(1024);
    val metadataSize = codes.metadata.calculateSizeStrict(1024);
    // Root data, StateInit and both mint cells, with 120-bit coin fields.
    val bits = codeSize.1 + metadataSize.1 + 1600;
    val cells = codeSize.0 + metadataSize.0 + 4;
    val deployFee = calculateForwardFee(BASECHAIN, bits, cells);
    val a = (10000000 + calculateGasFee(BASECHAIN, MINTER_MINT_GAS)
        + calculateForwardFee(BASECHAIN, WALLET_DEPLOY_BITS, WALLET_DEPLOY_CELLS)) / 2 + 1;
    val b = (deployFee + calculateForwardFeeWithoutLumpPrice(BASECHAIN, 812, 3)
        + calculateGasFee(BASECHAIN, 6327) + calculateGasFee(BASECHAIN, 7443)
        + calculateStorageFee(BASECHAIN, 157680000, 1026, 3)) / 3 + 1;
    val c = calculateGasFee(BASECHAIN, GENS_GAS) + deployFee + 3 * calculateForwardFee(BASECHAIN, 1000, 1);
    return max(GENS_FLOOR, 8 * max(a, max(b, c)));
}

fun onBouncedMessage(in: InMessageBounced) {
    var st = GenesisStorage.load();
    if (!st.sent || st.nominationFailed) { return; }
    val master = jetton_v21_minter_address(contract.getAddress(), st.codes.load().metadata);
    var body = in.bouncedBody;
    if (in.senderAddress != master || body.remainingBitsCount() != 288 || body.remainingRefsCount() != 0) { return; }
    if (body.loadUint(32) != 0xffffffff || body.loadUint(32) != OP_JETTON_CHANGE_ADMIN) { return; }
    // No success inference: this flag records only an authenticated nomination refusal.
    st.nominationFailed = true;
    st.save();
}

fun onInternalMessage(in: InMessage) {
    if (in.body.isEmpty()) { return; }
    if (in.body.remainingBitsCount() >= 32 && in.body.preloadUint(32) == OP_TEP74_EXCESSES) { return; }
    val msg = GenesisSend.fromSlice(in.body);
    var st = GenesisStorage.load();
    assert (!st.sent && in.valueCoins >= st.minimum()) throw ERR_GOVERNANCE_CONFIG;
    val (master, merkleClaim, remint) = st.identities();
    val campaign = st.campaign.load();
    val codes = st.codes.load();
    val unit = in.valueCoins / 8;
    st.sent = true;
    st.save();
    createExternalLogMessage({ dest: createAddressNone(), body: GenesisEvent { master, merkleClaim, remint, total: campaign.total } })
        .send(SEND_MODE_IGNORE_ERRORS);
    createMessage({ bounce: BounceMode.Only256BitsOfBody, dest: jetton_v21_minter_init(contract.getAddress(), codes.metadata), value: 5 * unit,
        body: jetton_v21_mint_body(msg.queryId, merkleClaim, 3 * unit, campaign.total as coins, in.senderAddress, 0) })
        .send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    createMessage({ bounce: BounceMode.Only256BitsOfBody, dest: master, value: unit,
        body: beginCell().storeUint(OP_JETTON_CHANGE_ADMIN, 32).storeUint(msg.queryId, 64).storeAddress(remint).endCell() })
        .send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    createMessage({ bounce: BounceMode.NoBounce, dest: remint, value: unit,
        body: beginCell().storeUint(OP_REMINT_CLAIM_ADMIN, 32).storeUint(msg.queryId, 64).endCell() })
        .send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    reserveGramsOnBalance(contract.getOriginalBalance() - in.valueCoins, RESERVE_MODE_EXACT_AMOUNT | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
    createMessage({ bounce: BounceMode.NoBounce, dest: in.senderAddress, value: 0, body: createEmptyCell() })
        .send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}

get fun get_genesis(): (bool, bool, cell, address, address, address) {
    val st = GenesisStorage.load();
    val (master, claim, remint) = st.identities();
    return (st.sent, st.nominationFailed, st.campaign, master, claim, remint);
}
get fun get_gens_value(): coins { return GenesisStorage.load().minimum(); }

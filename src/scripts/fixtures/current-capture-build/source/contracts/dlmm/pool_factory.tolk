tolk 1.5.0

import "@gen/op/tep";
import "../shared/jetton/jetton_quotes";

// Immutable factory: pool addresses are proven by StateInit, never by a registry entry.
import "@stdlib/gas-payments";
import "../shared/jetton/jetton_sweep";
import "@gen/op/dlmm";
import "../shared/jetton/tep74_codec";
import "./constants";
import "./pool_state_init";
import "./pool_storage";
import "./pool_codec";
import "./pool_funding";

const ERR_POOL_FACTORY = 3100;

fun factory_id_public(id: PoolId): bool {
    return id.binSpacing == POOL_PUBLIC_BIN_SPACING && id.feePips == POOL_PUBLIC_FEE_PIPS
        && id.walletGasX == POOL_PUBLIC_WALLET_GAS_X && id.walletGramX == POOL_PUBLIC_WALLET_GRAM_X
        && id.walletBudgetX.hash() == jetton_standard_budget(POOL_PUBLIC_WALLET_GAS_X).hash();
}
fun factory_identity_valid(s: PoolFactoryStorage, id: PoolId): bool {
    return id.xMaster != s.t3Master && id.xMaster != contract.getAddress()
        && (s.blockedX == null || id.xMaster != s.blockedX);
}
fun factory_pool(s: PoolFactoryStorage, id: PoolId): AutoDeployAddress {
    val cfg = s.cfg.load();
    return { stateInit: { code: s.poolCode,
        data: pool_initial_data(contract.getAddress(), cfg.feeSink, cfg.treasury, s.t3Master, s.t3WalletGas, s.t3WalletGram, s.t3WalletBudget, id) } };
}
fun onInternalMessage(in: InMessage) {
    if (in.body.remainingBitsCount() < 32) { assert (in.body.isEmpty()) throw ERR_POOL_FACTORY; return; }
    val op = in.body.preloadUint(32);
    if (op == OP_TEP74_EXCESSES) { return; }
    val s = PoolFactoryStorage.fromCell(contract.getData());
    val cfg = s.cfg.load();
    val base = max(contract.getOriginalBalance() - in.valueCoins, 0);
    if (op == OP_POOL_CREATE) {
        assert (in.senderAddress.getWorkchain() == BASECHAIN) throw ERR_POOL_FACTORY;
        val req = PoolCreate.fromSlice(in.body);
        val parsed = pool_id_try_parse(req.id);
        assert (parsed != null) throw ERR_POOL_FACTORY;
        val id = parsed!;
        assert (factory_identity_valid(s, id)) throw ERR_POOL_FACTORY;
        assert (factory_id_public(id) || in.senderAddress == cfg.governance) throw ERR_POOL_FACTORY;
        assert (in.valueCoins >= pool_factory_create_value(s, id.walletGramX, base)) throw ERR_POOL_FACTORY;
        val kept = pool_factory_keep(s.poolCodeBits, s.poolCodeCells, base);
        reserveGramsOnBalance(base + kept, RESERVE_MODE_AT_MOST);
        createMessage({ bounce: BounceMode.NoBounce, dest: factory_pool(s, id), value: pool_init_value(id.walletGramX),
            body: PoolInit { notifyTo: req.notify ? in.senderAddress : null } }).send(SEND_MODE_PAY_FEES_SEPARATELY);
        createMessage({ bounce: BounceMode.NoBounce, dest: in.senderAddress, value: 0 }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
        return;
    }
    if (op == OP_POOL_READY) {
        val req = PoolReady.fromSlice(in.body);
        val id = pool_id_try_parse(req.id);
        if (id == null || !factory_identity_valid(s, id) || in.senderAddress != factory_pool(s, id).calculateAddress()) { return; }
        if (req.notifyTo != null && req.notifyTo!.getWorkchain() != BASECHAIN) { return; }
        // The authentic pool budgets the external log before asking for a notification.
        if (in.valueCoins < calculateGasFee(BASECHAIN, FACTORY_READY_GAS) + calculateForwardFee(BASECHAIN, 1023, 2)) { return; }
        createExternalLogMessage({ dest: createAddressNone(), body: PoolListed { pool: in.senderAddress, id: id.toCell() } }).send(SEND_MODE_IGNORE_ERRORS);
        if (req.notifyTo != null) {
            reserveGramsOnBalance(base, RESERVE_MODE_AT_MOST);
            createMessage({ bounce: BounceMode.NoBounce, dest: req.notifyTo!, value: 0,
                body: PoolCreated { pool: in.senderAddress, id: id.toCell() } }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
        }
        return;
    }
    if (op == OP_FACTORY_SWEEP_ALLOW) {
        val req = FactorySweepAllow.fromSlice(in.body);
        assert (in.senderAddress == cfg.governance && req.pool.getWorkchain() == BASECHAIN) throw ERR_POOL_FACTORY;
        assert (in.valueCoins >= pool_factory_relay_value()) throw ERR_POOL_FACTORY;
        reserveGramsOnBalance(base, RESERVE_MODE_AT_MOST);
        createMessage({ bounce: BounceMode.NoBounce, dest: req.pool, value: 0,
            body: SweepAllow { queryId: req.queryId, slot: req.slot, amount: req.amount } })
            .send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        return;
    }
    if (op == OP_FACTORY_PAUSE) {
        val req = FactoryPause.fromSlice(in.body);
        assert (in.senderAddress == cfg.governance && req.pool.getWorkchain() == BASECHAIN) throw ERR_POOL_FACTORY;
        assert (in.valueCoins >= pool_factory_relay_value()) throw ERR_POOL_FACTORY;
        reserveGramsOnBalance(base, RESERVE_MODE_AT_MOST);
        createMessage({ bounce: BounceMode.NoBounce, dest: req.pool, value: 0,
            body: PoolPause { paused: req.paused } }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        return;
    }
    throw ERR_POOL_FACTORY;
}
fun onBouncedMessage(in: InMessageBounced) {}
get fun get_factory_info(): (address, address, address, address, address?, int, int, cell, int, coins, cell) {
    val s = PoolFactoryStorage.fromCell(contract.getData()); val cfg = s.cfg.load();
    return (cfg.governance, cfg.feeSink, cfg.treasury, s.t3Master, s.blockedX, s.poolCodeBits, s.poolCodeCells, s.poolCode,
        s.t3WalletGas, s.t3WalletGram, s.t3WalletBudget);
}
get fun get_pool_address(id: cell): address {
    val s = PoolFactoryStorage.fromCell(contract.getData()); val parsed = pool_id_try_parse(id);
    assert (parsed != null && factory_identity_valid(s, parsed!)) throw ERR_POOL_FACTORY;
    return factory_pool(s, parsed!).calculateAddress();
}
get fun get_create_min_value(): coins {
    return pool_factory_create_value(PoolFactoryStorage.fromCell(contract.getData()), 0, contract.getOriginalBalance());
}
get fun get_create_min_value_for(id: cell): coins {
    val s = PoolFactoryStorage.fromCell(contract.getData()); val parsed = pool_id_try_parse(id);
    assert (parsed != null && factory_identity_valid(s, parsed!)) throw ERR_POOL_FACTORY;
    return pool_factory_create_value(s, parsed!.walletGramX, contract.getOriginalBalance());
}
get fun get_relay_min_value(): coins { return pool_factory_relay_value(); }
get fun get_public_tier(): (int, int, int, int) {
    return (POOL_PUBLIC_BIN_SPACING, POOL_PUBLIC_FEE_PIPS, POOL_PUBLIC_WALLET_GAS_X, POOL_PUBLIC_WALLET_GRAM_X);
}

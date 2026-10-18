tolk 1.5.0

import "@stdlib/gas-payments";
import "@stdlib/exotic-cells";
import "../shared/governance/module_gate";
import "@gen/op/automation";
import "@gen/op/governance";

const GV_MIN_BALANCE = 1000000000;
const GV_TICK_GAS = 24000;
const GV_ADMIN_GAS = 24000;
const GV_WITHDRAW_GAS = 14000;
const GV_MAX_JOBS = 16;
const ERR_GAS_VAULT = 3300;

struct GasJob {
    target: address;
    value: coins;
    cadence: uint32;
    lastAt: uint32;
    ticks: uint64;
    op: uint32;
    args: cell;
}
struct GasVaultStorage {
    gate: ModuleGate;
    treasury: address;
    jobCount: uint5;
    jobs: map<uint32, GasJob>;
}
struct (0x47564a42) GasSetJob {
    queryId: uint64; jobId: uint32; target: address; value: coins; cadence: uint32; op: uint32; args: cell;
}
struct (0x47564a50) GasTuneJob { queryId: uint64; jobId: uint32; value: coins; cadence: uint32 }
struct (0x4756544b) GasTick { queryId: uint64; jobId: uint32 }
struct (0x47565744) GasWithdraw { queryId: uint64; amount: coins }

fun GasVaultStorage.load(): GasVaultStorage { return GasVaultStorage.fromCell(contract.getData()); }
fun GasVaultStorage.save(self) { contract.setData(self.toCell()); }
fun gas_return_fee(): coins { return calculateForwardFee(BASECHAIN, 700, 1); }
fun gas_job_fee(): coins { return calculateForwardFee(BASECHAIN, 1400, 2); }
fun gas_min_value(op: int): coins {
    val gas = op == OP_GAS_TICK ? GV_TICK_GAS : op == OP_GAS_WITHDRAW ? GV_WITHDRAW_GAS : GV_ADMIN_GAS;
    return calculateGasFee(BASECHAIN, gas) + gas_return_fee()
        + (op == OP_GAS_WITHDRAW ? gas_return_fee() : 0 as coins);
}
fun gas_bounds(value: coins, cadence: int) {
    assert (value <= 1000000000 && (cadence == 0 || cadence >= 30)) throw ERR_GAS_VAULT;
}
fun gas_return(sender: address, reserve: coins) {
    reserveGramsOnBalance(reserve, RESERVE_MODE_EXACT_AMOUNT | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
    createMessage({ bounce: BounceMode.NoBounce, dest: sender, value: 0 })
        .send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}

fun onInternalMessage(in: InMessage) {
    if (in.body.remainingBitsCount() < 32) { return; }
    val op = in.body.preloadUint(32);
    if (op != OP_GAS_SET_JOB && op != OP_GAS_TUNE_JOB && op != OP_GAS_TICK && op != OP_GAS_WITHDRAW
        && op != OP_WITHDRAWALS_ONLY_ON && op != OP_WITHDRAWALS_ONLY_OFF) { return; }
    assert (in.senderAddress.getWorkchain() == BASECHAIN && in.valueCoins >= gas_min_value(op)) throw ERR_GAS_VAULT;
    var st = GasVaultStorage.load();
    val before = max(contract.getOriginalBalance() - in.valueCoins, 0);
    if (gate_handle(mutate st.gate, in.senderAddress, in.body)) {
        st.save(); gas_return(in.senderAddress, before); return;
    }
    if (op == OP_GAS_TICK) {
        val msg = GasTick.fromSlice(in.body);
        gate_require_open(st.gate);
        var job = st.jobs.mustGet(msg.jobId, ERR_GAS_VAULT);
        assert (job.cadence > 0 && blockchain.now() >= job.lastAt + job.cadence
            && job.ticks < 18446744073709551615) throw ERR_GAS_VAULT;
        val cost = job.value + gas_job_fee();
        assert (before >= GV_MIN_BALANCE + cost) throw ERR_GAS_VAULT;
        job.lastAt = blockchain.now() as uint32; job.ticks += 1;
        st.jobs.set(msg.jobId, job); st.save();
        reserveGramsOnBalance(before - cost, RESERVE_MODE_EXACT_AMOUNT | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
        createMessage({ bounce: BounceMode.Only256BitsOfBody, dest: job.target, value: job.value,
            body: beginCell().storeUint(job.op, 32).storeUint(job.ticks, 64).storeSlice(job.args.beginParse()) })
            .send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        createMessage({ bounce: BounceMode.NoBounce, dest: in.senderAddress, value: 0 })
            .send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
        return;
    }
    gate_require_governance(st.gate, in.senderAddress);
    if (op == OP_GAS_SET_JOB) {
        val msg = GasSetJob.fromSlice(in.body);
        gas_bounds(msg.value, msg.cadence);
        assert (!st.jobs.exists(msg.jobId) && st.jobCount < GV_MAX_JOBS
            && msg.target.getWorkchain() == BASECHAIN && msg.target != contract.getAddress()) throw ERR_GAS_VAULT;
        val (args, exotic) = msg.args.beginParseSpecial();
        assert (!exotic && args.remainingRefsCount() == 0 && args.remainingBitsCount() <= 512) throw ERR_GAS_VAULT;
        st.jobs.set(msg.jobId, { target: msg.target, value: msg.value, cadence: msg.cadence,
            lastAt: 0, ticks: 0, op: msg.op, args: beginCell().storeSlice(args).endCell() });
        st.jobCount += 1; st.save(); gas_return(in.senderAddress, before); return;
    }
    if (op == OP_GAS_TUNE_JOB) {
        val msg = GasTuneJob.fromSlice(in.body);
        gas_bounds(msg.value, msg.cadence);
        var job = st.jobs.mustGet(msg.jobId, ERR_GAS_VAULT);
        job.value = msg.value; job.cadence = msg.cadence;
        st.jobs.set(msg.jobId, job); st.save(); gas_return(in.senderAddress, before); return;
    }
    val msg = GasWithdraw.fromSlice(in.body);
    val amount = min(msg.amount, max(before - GV_MIN_BALANCE, 0));
    reserveGramsOnBalance(before - amount, RESERVE_MODE_EXACT_AMOUNT | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
    if (amount > 0) {
        createMessage({ bounce: BounceMode.Only256BitsOfBody, dest: st.treasury, value: amount })
            .send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
    }
    createMessage({ bounce: BounceMode.NoBounce, dest: in.senderAddress, value: 0 })
        .send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
}
fun onBouncedMessage(in: InMessageBounced) {}
get fun get_job(jobId: uint32): GasJob? {
    val job = GasVaultStorage.load().jobs.get(jobId); return job.isFound ? job.loadValue() : null;
}
get fun get_jobs(): map<uint32, GasJob> { return GasVaultStorage.load().jobs; }
get fun get_gas_vault(): (coins, int, bool, address, address) {
    val st = GasVaultStorage.load();
    return (contract.getOriginalBalance(), st.jobCount, st.gate.withdrawalsOnly, st.gate.governance, st.treasury);
}
get fun get_min_value(op: uint32): coins {
    assert (op == OP_GAS_SET_JOB || op == OP_GAS_TUNE_JOB || op == OP_GAS_TICK || op == OP_GAS_WITHDRAW
        || op == OP_WITHDRAWALS_ONLY_ON || op == OP_WITHDRAWALS_ONLY_OFF) throw ERR_GAS_VAULT;
    return gas_min_value(op);
}
get fun get_tick_balance(jobId: uint32): coins {
    return GV_MIN_BALANCE + GasVaultStorage.load().jobs.mustGet(jobId, ERR_GAS_VAULT).value + gas_job_fee();
}

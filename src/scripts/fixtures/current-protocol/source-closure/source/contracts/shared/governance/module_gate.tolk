tolk 1.5.0

// module_gate.tolk
// The pause switch of a governed module. A module deploys closed (withdrawalsOnly = 1 in its
// StateInit) and wdof opens it; while closed, operations that add risk are refused and exits,
// which never ask the gate, keep working.

import "../../generated/op/governance.tolk";
import "../utils/error_codes.tolk";

struct ModuleGate {
    // From StateInit; nothing writes it.
    governance: address;
    withdrawalsOnly: bool;
}

struct (0x57444f4e) WithdrawalsOnlyOn {}

struct (0x57444f46) WithdrawalsOnlyOff {}

type GateMessage = WithdrawalsOnlyOn | WithdrawalsOnlyOff;

fun gate_require_governance(g: ModuleGate, sender: address) {
    assert (sender == g.governance) throw ERR_GOVERNANCE_UNAUTHORIZED;
}

fun gate_require_open(g: ModuleGate) {
    assert (!g.withdrawalsOnly) throw ERR_WITHDRAWALS_ONLY;
}

// True when `body` was a gate message and has been applied; false when it is the module's own.
// A body that starts with a gate tag is never the module's: from anyone but governance, or with
// anything after the tag, it throws.
fun gate_handle(mutate g: ModuleGate, sender: address, body: slice): bool {
    if (body.remainingBitsCount() < 32) {
        return false;
    }
    val op = body.preloadUint(32);
    if (op != OP_WITHDRAWALS_ONLY_ON && op != OP_WITHDRAWALS_ONLY_OFF) {
        return false;
    }
    gate_require_governance(g, sender);
    // Repeating either message changes nothing.
    g.withdrawalsOnly = GateMessage.fromSlice(body) is WithdrawalsOnlyOn;
    return true;
}

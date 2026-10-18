tolk 1.5.0

import "@gen/op/tep";
import "governance_types"
import "../shared/governance/policy_types"
import "../shared/jetton/jetton_slots"
import "../shared/jetton/tep74_codec"
import "../shared/jetton/jetton_sweep"
import "@gen/op/jetton"

fun GovernanceStorage.externalTarget(self, action: GovAction): bool {
    if (action.target == contract.getAddress()) { return false; }
    val wallet = self.ledger().slots.get(0);
    if (wallet.isFound) { val own = wallet.loadValue().wallet; if (own != null && own == action.target) { return false; } }
    val op = action_op(action.body);
    return op != null && op != OP_TEP74_TRANSFER && op != OP_TEP74_BURN;
}

// Validate and apply each shrink in order on a private map. Duplicate lowers cannot raise an intermediate maximum.
fun governance_shrink(mutate policy: PolicyMap, mutate count: uint16, body: cell): bool {
    val shrink = policy_shrink_decode(body);
    if (shrink == null) { return false; }
    var i = 0;
    while (i < shrink.removes.size()) {
        val row = shrink.removes.get(i).row;
        val entry = policy_find(policy, row);
        if (entry != null) {
            if (entry.permanent) { return false; }
            policy_drop(mutate policy, row); count -= 1;
        }
        i += 1;
    }
    i = 0;
    while (i < shrink.lowers.size()) {
        val lower = shrink.lowers.get(i);
        val entry = policy_find(policy, lower.row);
        if (entry != null) {
            if (entry.permanent || lower.max < entry.minValue || lower.max > entry.maxValue) { return false; }
            var changed = entry; changed.maxValue = lower.max;
            policy_put(mutate policy, lower.row, changed);
        }
        i += 1;
    }
    return true;
}

// Status 0 means valid; 1 encoding/class, 2 target, 3 policy, 4 shrink.
fun GovernanceStorage.checkActions(self, class: int, list: cell): (int, coins, PolicyMap, uint16, JettonSweeps) {
    var policy = self.policy; var count = self.policyCount; var sweeps = self.assets.load().sweeps.load();
    val actions = action_list_decode(list);
    if (class < 0 || class > 2 || actions == null) { return (1, 0, policy, count, sweeps); }
    var value: coins = 0; var i = 0;
    while (i < actions.size()) {
        val action = actions.get(i);
        if (!action_body_fits(action.body)) { return (1, 0, policy, count, sweeps); }
        if (action.target == contract.getAddress()) {
            if (action.value != 0) { return (4, 0, policy, count, sweeps); }
            if (action_op(action.body)! == OP_SWEEP_ALLOW) {
                val allow = governance_sweep_allow(action.body);
                if (class != GOV_CLASS_NORMAL || allow == null || self.assets.load().treasury == null
                        || !self.ledger().slots.exists(allow.slot)) { return (4, 0, policy, count, sweeps); }
                sweeps.allow(self.ledger(), allow.slot, allow.amount);
            } else if (class != GOV_CLASS_CONSTITUTIONAL
                    || !governance_shrink(mutate policy, mutate count, action.body)) { return (4, 0, policy, count, sweeps); }
        } else {
            if (!self.externalTarget(action)) { return (2, 0, policy, count, sweeps); }
            val entry = policy_entry_for(policy, action.target, action.body);
            if (entry == null || action.value < entry.minValue || action.value > entry.maxValue
                    || (class == GOV_CLASS_EMERGENCY ? !entry.emergency || !emergency_shape_ok(action.body) : entry.class > class)) {
                return (3, 0, policy, count, sweeps);
            }
        }
        value += action.value; i += 1;
    }
    return (0, value, policy, count, sweeps);
}

fun governance_sweep_allow(body: cell): SweepAllow? {
    val opened = policy_open(body);
    if (opened == null || opened.remainingBitsCount() < 108 || opened.remainingRefsCount() != 0) { return null; }
    var s = opened;
    if (s.loadUint(32) != OP_SWEEP_ALLOW) { return null; }
    val queryId = s.loadUint(64) as uint64; val slot = s.loadUint(8) as uint8;
    val amount = policy_take_coins(mutate s);
    if (amount == null || s.remainingBitsCount() != 0) { return null; }
    return { queryId, slot, amount };
}

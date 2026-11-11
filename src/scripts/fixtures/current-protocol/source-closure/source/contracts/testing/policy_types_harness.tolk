tolk 1.5.0

// testing/policy_types_harness.tolk
// Getters over shared/governance/policy_types.tolk for the cross-language test. A decoder getter
// returns what it decoded written again by the compiler's own serializer, so the test compares
// whole cells with the TypeScript builders instead of trusting a field-by-field reading.

import "../shared/governance/policy_types.tolk";

const APPLY_OK: int = 0;
const APPLY_MALFORMED: int = 1;
const APPLY_ITEM_REFUSED: int = 2;
const APPLY_NODE_KIND: int = 3;
const APPLY_FULL: int = 4;

// One gpol-shaped step of a policy script: upserts, then removals.
struct PolicyBatch {
    items: Cell<PolicyItem>?;
    removes: Cell<PolicyRef>?;
    next: Cell<PolicyBatch>?;
}

struct PolicyBuild {
    status: int;
    policy: PolicyMap;
    count: int;
}

// Applies a script the way gpol applies its two lists and keeps the entry count as Governance must.
fun build_policy(script: Cell<PolicyBatch>?): PolicyBuild {
    var policy: PolicyMap = [];
    var count = 0;
    var cursor = script;
    while (cursor != null) {
        val batch = cursor.load();
        val items = policy_items_decode(batch.items);
        val removes = policy_refs_decode(batch.removes);
        if (items == null || removes == null) {
            return { status: APPLY_MALFORMED, policy, count };
        }
        var i = 0;
        while (i < items.size()) {
            val item = items.get(i);
            if (!policy_item_ok(item)) {
                return { status: APPLY_ITEM_REFUSED, policy, count };
            }
            val put = policy_put(mutate policy, item.row, policy_entry_of(item));
            if (put == POLICY_PUT_REFUSED) {
                return { status: APPLY_NODE_KIND, policy, count };
            }
            if (put == POLICY_PUT_ADDED) {
                count += 1;
            }
            i += 1;
        }
        i = 0;
        while (i < removes.size()) {
            if (policy_drop(mutate policy, removes.get(i).row)) {
                count -= 1;
            }
            i += 1;
        }
        if (count > POLICY_ENTRIES_MAX) {
            return { status: APPLY_FULL, policy, count };
        }
        cursor = batch.next;
    }
    return { status: APPLY_OK, policy, count };
}

fun onInternalMessage(in: InMessage) {}

// Every constant of the schema, in the order the wrapper reads them.
get fun schema_constants(): (int, int, int, int, int, int, int, int, int, coins, int, int, int, int, int) {
    return (
        GOV_CLASS_NORMAL, GOV_CLASS_CONSTITUTIONAL, GOV_CLASS_EMERGENCY,
        ACTION_BODY_MAX_CELLS, ACTION_BODY_MAX_BITS, ACTION_BODY_MAX_DEPTH, ACTION_SUB_OFFSET,
        POLICY_ENTRIES_MAX, POLICY_LIST_MAX, POLICY_VALUE_MAX, POLICY_VALUE_MARGIN,
        EMERGENCY_WDON_BITS, EMERGENCY_PAUSE_BITS, EMERGENCY_FREEZE_BITS, EMERGENCY_FREEZE_ACTION
    );
}

get fun policy_key_of(target: address, op: uint32): uint256 {
    return policy_key(target, op);
}

get fun action_op_of(body: cell): uint32? {
    return action_op(body);
}

get fun action_sub_of(body: cell): uint8? {
    return action_sub(body);
}

get fun emergency_shape(body: cell): bool {
    return emergency_shape_ok(body);
}

get fun body_fits(body: cell): bool {
    return action_body_fits(body);
}

get fun actions_echo(list: cell): cell? {
    val actions = action_list_decode(list);
    if (actions == null) {
        return null;
    }
    var rebuilt = beginCell().storeUint(actions.size(), 3);
    var i = 0;
    while (i < actions.size()) {
        rebuilt.storeRef(actions.get(i).toCell());
        i += 1;
    }
    return rebuilt.endCell();
}

// -1 malformed, 0 refused by the gpol rule, 1 accepted.
get fun item_verdict(node: Cell<PolicyItem>): int {
    val item = policy_item_decode(node);
    if (item == null) {
        return -1;
    }
    return policy_item_ok(item) ? 1 : 0;
}

fun link_refs(refs: array<PolicyRef>): Cell<PolicyRef>? {
    var head: Cell<PolicyRef>? = null;
    var i = refs.size();
    while (i > 0) {
        i -= 1;
        head = PolicyRef { row: refs.get(i).row, next: head }.toCell();
    }
    return head;
}

fun link_lowers(lowers: array<PolicyLower>): Cell<PolicyLower>? {
    var head: Cell<PolicyLower>? = null;
    var i = lowers.size();
    while (i > 0) {
        i -= 1;
        val lower = lowers.get(i);
        head = PolicyLower { row: lower.row, max: lower.max, next: head }.toCell();
    }
    return head;
}

// The number of rows and the list written again from them, or (-1, null) when the list is refused.
get fun items_echo(head: Cell<PolicyItem>?): (int, Cell<PolicyItem>?) {
    val items = policy_items_decode(head);
    if (items == null) {
        return (-1, null);
    }
    var rebuilt: Cell<PolicyItem>? = null;
    var i = items.size();
    while (i > 0) {
        i -= 1;
        val item = items.get(i);
        rebuilt = PolicyItem {
            row: item.row,
            min: item.min,
            max: item.max,
            class: item.class,
            emergency: item.emergency,
            permanent: item.permanent,
            next: rebuilt,
        }.toCell();
    }
    return (items.size(), rebuilt);
}

get fun refs_echo(head: Cell<PolicyRef>?): (int, Cell<PolicyRef>?) {
    val refs = policy_refs_decode(head);
    if (refs == null) {
        return (-1, null);
    }
    return (refs.size(), link_refs(refs));
}

get fun lowers_echo(head: Cell<PolicyLower>?): (int, Cell<PolicyLower>?) {
    val lowers = policy_lowers_decode(head);
    if (lowers == null) {
        return (-1, null);
    }
    return (lowers.size(), link_lowers(lowers));
}

// (removes, lowers) and the body written again from its keys, or (-1, -1, null) when it is refused.
get fun shrink_echo(body: cell): (int, int, Cell<GovPolicyShrink>?) {
    val shrink = policy_shrink_decode(body);
    if (shrink == null) {
        return (-1, -1, null);
    }
    val rebuilt = GovPolicyShrink { removes: link_refs(shrink.removes), lowers: link_lowers(shrink.lowers) };
    return (shrink.removes.size(), shrink.lowers.size(), rebuilt.toCell());
}

get fun policy_apply(script: Cell<PolicyBatch>?): (int, uint256, int) {
    val built = build_policy(script);
    return (built.status, policy_root(built.policy), built.count);
}

get fun policy_entry_at(script: Cell<PolicyBatch>?, target: address, op: uint32, sub: uint8?): (bool, PolicyEntry) {
    val entry = policy_find(build_policy(script).policy, { target, op, sub });
    if (entry == null) {
        return (false, { minValue: 0, maxValue: 0, class: 0, emergency: false, permanent: false });
    }
    return (true, entry);
}

get fun policy_entry_for_action(script: Cell<PolicyBatch>?, target: address, body: cell): (bool, PolicyEntry) {
    val entry = policy_entry_for(build_policy(script).policy, target, body);
    if (entry == null) {
        return (false, { minValue: 0, maxValue: 0, class: 0, emergency: false, permanent: false });
    }
    return (true, entry);
}

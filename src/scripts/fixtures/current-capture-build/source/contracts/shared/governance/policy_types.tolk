tolk 1.5.0

// policy_types.tolk
// The governance action list, the policy rows and the policy map: what Governance stores and what the
// deploy and web builders write (wrappers/utils/governanceActions.ts is the mirror).
// Every decoder is total: it returns null for anything but the one encoding of a value and never
// throws, so a caller can refuse a proposal with a status instead of losing the transaction.
//
// gov_action$_   target:MsgAddressInt value:Coins body:^Cell
// action_list$_  count:(## 3) actions:(count * ^GovAction)                      1 to 4 actions
// policy_item$_  target:MsgAddressInt op:uint32 sub:(Maybe uint8) min:Coins max:Coins class:(## 1)
//                emergency:Bool permanent:Bool next:(Maybe ^PolicyItem)
// policy_ref$_   target:MsgAddressInt op:uint32 sub:(Maybe uint8) next:(Maybe ^PolicyRef)
// policy_lower$_ target:MsgAddressInt op:uint32 sub:(Maybe uint8) max:Coins next:(Maybe ^PolicyLower)
// gov_policy_shrink#GPSH removes:(Maybe ^PolicyRef) lowers:(Maybe ^PolicyLower)
// policy_entry$_ min:Coins max:Coins class:(## 1) emergency:Bool permanent:Bool
// policy_plain$0 entry:PolicyEntry = PolicyNode;  policy_subs$1 subs:(HashmapE 8 PolicyEntry) = PolicyNode
// policy = HashmapE 256 PolicyNode, keyed by policy_key = hash(cell{target:MsgAddressInt op:uint32})
// Every address is addr_std without anycast in workchain 0, and every Coins is in its shortest form.

import "@stdlib/exotic-cells.tolk";
import "../../generated/op/dlmm.tolk";
import "../../generated/op/governance.tolk";
import "../../generated/op/t3.tolk";

// A policy entry is NORMAL or CONSTITUTIONAL; EMERGENCY is a class of proposal only.
const GOV_CLASS_NORMAL: int = 0;
const GOV_CLASS_CONSTITUTIONAL: int = 1;
const GOV_CLASS_EMERGENCY: int = 2;

const ACTION_BODY_MAX_CELLS: int = 30;
const ACTION_BODY_MAX_BITS: int = 7000;
const ACTION_BODY_MAX_DEPTH: int = 8;
// The uint8 right after op and query_id is the only sub-selector position.
const ACTION_SUB_OFFSET: int = 96;

// Entries of the whole policy; rows of one gpol list and keys of one gpsh.
const POLICY_ENTRIES_MAX: int = 256;
const POLICY_LIST_MAX: int = 16;
const POLICY_VALUE_MAX: coins = grams("100");
// maxValue >= 20 x minValue, so that a fee rise does not strand a row.
const POLICY_VALUE_MARGIN: int = 20;

// The three emergency shapes: exact bit length, no reference. A fourth needs a new release.
const EMERGENCY_WDON_BITS: int = 32;
// factory_pause: op, pool, paused = 1.
const EMERGENCY_PAUSE_BITS: int = 300;
// t3_gov: op, query_id, action = FREEZE_ADD, mask != 0.
const EMERGENCY_FREEZE_BITS: int = 107;
const EMERGENCY_FREEZE_ACTION: int = 2;

// addr_std, no anycast, workchain 0: the first 11 bits of every address of this protocol.
const POLICY_ADDRESS_HEAD_BITS: int = 11;
const POLICY_ADDRESS_HEAD: int = 0x400;

const POLICY_PUT_REFUSED: int = 0;
const POLICY_PUT_ADDED: int = 1;
const POLICY_PUT_REPLACED: int = 2;

struct GovAction {
    target: address;
    value: coins;
    // Starts with the 32-bit op of the target.
    body: cell;
}

// The head of every policy list node: `sub` selects inside the node of (target, op).
struct PolicyRowKey {
    target: address;
    op: uint32;
    sub: uint8?;
}

struct PolicyItem {
    row: PolicyRowKey;
    min: coins;
    max: coins;
    class: uint1;
    emergency: bool;
    permanent: bool;
    next: Cell<PolicyItem>?;
}

struct PolicyRef {
    row: PolicyRowKey;
    next: Cell<PolicyRef>?;
}

struct PolicyLower {
    row: PolicyRowKey;
    max: coins;
    next: Cell<PolicyLower>?;
}

// An action body with target = Governance; never an accepted message.
struct (0x47505348) GovPolicyShrink {
    removes: Cell<PolicyRef>?;
    lowers: Cell<PolicyLower>?;
}

struct PolicyShrink {
    removes: array<PolicyRef>;
    lowers: array<PolicyLower>;
}

struct PolicyEntry {
    minValue: coins;
    maxValue: coins;
    class: uint1;
    emergency: bool;
    permanent: bool;
}

struct (0b0) PolicyPlain {
    entry: PolicyEntry;
}

struct (0b1) PolicySubs {
    subs: map<uint8, PolicyEntry>;
}

// One node per (target, op): a plain entry or sub rows, never both, so neither can shadow the other.
type PolicyNode = PolicyPlain | PolicySubs;
type PolicyMap = map<uint256, PolicyNode>;

fun policy_key(target: address, op: uint32): uint256 {
    return beginCell().storeAddress(target).storeUint(op, 32).hash();
}

// An exotic cell has no layout of ours, and parsing one would throw.
fun policy_open(c: cell): slice? {
    val (opened, exotic) = c.beginParseSpecial();
    return exotic ? null : opened;
}

fun action_op(body: cell): uint32? {
    val opened = policy_open(body);
    if (opened == null || opened.remainingBitsCount() < 32) {
        return null;
    }
    return opened.preloadUint(32) as uint32;
}

fun action_sub(body: cell): uint8? {
    val opened = policy_open(body);
    if (opened == null || opened.remainingBitsCount() < ACTION_SUB_OFFSET + 8) {
        return null;
    }
    return opened.getMiddleBits(ACTION_SUB_OFFSET, 8).preloadUint(8) as uint8;
}

// The flag of a policy entry alone would let one wrong row turn the zero-delay class into an
// unpause or a payout: an EMERGENCY action must also be one of the three pausing bodies, bit for bit.
fun emergency_shape_ok(body: cell): bool {
    val opened = policy_open(body);
    if (opened == null || opened.remainingRefsCount() != 0 || opened.remainingBitsCount() < 32) {
        return false;
    }
    var rest = opened;
    val bits = rest.remainingBitsCount();
    val op = rest.loadUint(32);
    if (op == OP_WITHDRAWALS_ONLY_ON) {
        return bits == EMERGENCY_WDON_BITS;
    }
    if (op == OP_FACTORY_PAUSE) {
        return bits == EMERGENCY_PAUSE_BITS
            && rest.preloadUint(POLICY_ADDRESS_HEAD_BITS) == POLICY_ADDRESS_HEAD
            && rest.getLastBits(1).preloadUint(1) == 1;
    }
    if (op == OP_T3_GOV) {
        return bits == EMERGENCY_FREEZE_BITS
            && rest.getMiddleBits(ACTION_SUB_OFFSET - 32, 8).preloadUint(8) == EMERGENCY_FREEZE_ACTION
            && rest.getLastBits(3).preloadUint(3) != 0;
    }
    return false;
}

// Checked once, when a proposal is created: it bounds what Governance stores and later forwards.
fun action_body_fits(body: cell): bool {
    val (_, bits, _, counted) = body.calculateSize(ACTION_BODY_MAX_CELLS);
    return counted && bits! <= ACTION_BODY_MAX_BITS && body.depth() <= ACTION_BODY_MAX_DEPTH;
}

fun policy_take_target(mutate s: slice): address? {
    if (s.remainingBitsCount() < 267 || s.preloadUint(POLICY_ADDRESS_HEAD_BITS) != POLICY_ADDRESS_HEAD) {
        return null;
    }
    return s.loadAddress();
}

// A Coins field in its shortest form, the only one a builder writes: one amount, one encoding.
fun policy_take_coins(mutate s: slice): coins? {
    if (s.remainingBitsCount() < 4) {
        return null;
    }
    val bytes = s.preloadUint(4);
    if (s.remainingBitsCount() < 4 + 8 * bytes) {
        return null;
    }
    val amount = s.loadCoins();
    if (bytes > 0 && (amount >> (8 * (bytes - 1))) == 0) {
        return null;
    }
    return amount;
}

fun policy_take_row(mutate s: slice): PolicyRowKey? {
    val target = policy_take_target(mutate s);
    if (target == null || s.remainingBitsCount() < 33) {
        return null;
    }
    val op = s.loadUint(32) as uint32;
    if (!s.loadBool()) {
        return { target, op, sub: null };
    }
    if (s.remainingBitsCount() < 8) {
        return null;
    }
    return { target, op, sub: s.loadUint(8) as uint8 };
}

// The `next:(Maybe ^X)` that ends a list node: (true, next) only when the node ends exactly there.
fun policy_take_next<T>(s: slice): (bool, Cell<T>?) {
    if (s.remainingBitsCount() != 1) {
        return (false, null);
    }
    val linked = s.preloadUint(1);
    if (s.remainingRefsCount() != linked) {
        return (false, null);
    }
    return (true, linked == 1 ? s.preloadRef() as Cell<T> : null);
}

fun gov_action_decode(action: cell): GovAction? {
    val opened = policy_open(action);
    if (opened == null || opened.remainingRefsCount() != 1) {
        return null;
    }
    var rest = opened;
    val target = policy_take_target(mutate rest);
    if (target == null) {
        return null;
    }
    val value = policy_take_coins(mutate rest);
    if (value == null || rest.remainingBitsCount() != 0) {
        return null;
    }
    val body = rest.preloadRef();
    if (action_op(body) == null) {
        return null;
    }
    return { target, value, body };
}

// The actions in order, or null unless `list` is exactly an action_list of 1 to 4 actions. A list
// this accepts is the one a builder writes from the same fields, so it can be stored as it is.
fun action_list_decode(list: cell): array<GovAction>? {
    val opened = policy_open(list);
    if (opened == null || opened.remainingBitsCount() != 3) {
        return null;
    }
    var rest = opened;
    // The four references of a cell are the limit of a list.
    val count = rest.loadUint(3);
    if (count < 1 || rest.remainingRefsCount() != count) {
        return null;
    }
    var actions: array<GovAction> = [];
    repeat (count) {
        val action = gov_action_decode(rest.loadRef());
        if (action == null) {
            return null;
        }
        actions.push(action);
    }
    return actions;
}

fun policy_item_decode(node: Cell<PolicyItem>): PolicyItem? {
    val opened = policy_open(node as cell);
    if (opened == null) {
        return null;
    }
    var rest = opened;
    val row = policy_take_row(mutate rest);
    if (row == null) {
        return null;
    }
    val min = policy_take_coins(mutate rest);
    if (min == null) {
        return null;
    }
    val max = policy_take_coins(mutate rest);
    if (max == null || rest.remainingBitsCount() != 4) {
        return null;
    }
    val class = rest.loadUint(1) as uint1;
    val emergency = rest.loadBool();
    val permanent = rest.loadBool();
    val (ended, next) = policy_take_next<PolicyItem>(rest);
    if (!ended) {
        return null;
    }
    return { row, min, max, class, emergency, permanent, next };
}

fun policy_ref_decode(node: Cell<PolicyRef>): PolicyRef? {
    val opened = policy_open(node as cell);
    if (opened == null) {
        return null;
    }
    var rest = opened;
    val row = policy_take_row(mutate rest);
    if (row == null) {
        return null;
    }
    val (ended, next) = policy_take_next<PolicyRef>(rest);
    if (!ended) {
        return null;
    }
    return { row, next };
}

fun policy_lower_decode(node: Cell<PolicyLower>): PolicyLower? {
    val opened = policy_open(node as cell);
    if (opened == null) {
        return null;
    }
    var rest = opened;
    val row = policy_take_row(mutate rest);
    if (row == null) {
        return null;
    }
    val max = policy_take_coins(mutate rest);
    if (max == null) {
        return null;
    }
    val (ended, next) = policy_take_next<PolicyLower>(rest);
    if (!ended) {
        return null;
    }
    return { row, max, next };
}

// The rows of a list in order, or null when a node is malformed or the list holds more than 16.
fun policy_items_decode(head: Cell<PolicyItem>?): array<PolicyItem>? {
    var items: array<PolicyItem> = [];
    var node = head;
    while (node != null) {
        val item = policy_item_decode(node);
        if (item == null || items.size() == POLICY_LIST_MAX) {
            return null;
        }
        items.push(item);
        node = item.next;
    }
    return items;
}

fun policy_refs_decode(head: Cell<PolicyRef>?): array<PolicyRef>? {
    var refs: array<PolicyRef> = [];
    var node = head;
    while (node != null) {
        val ref = policy_ref_decode(node);
        if (ref == null || refs.size() == POLICY_LIST_MAX) {
            return null;
        }
        refs.push(ref);
        node = ref.next;
    }
    return refs;
}

fun policy_lowers_decode(head: Cell<PolicyLower>?): array<PolicyLower>? {
    var lowers: array<PolicyLower> = [];
    var node = head;
    while (node != null) {
        val lower = policy_lower_decode(node);
        if (lower == null || lowers.size() == POLICY_LIST_MAX) {
            return null;
        }
        lowers.push(lower);
        node = lower.next;
    }
    return lowers;
}

// The keys of a gpsh body, or null unless it is exactly gov_policy_shrink with at most 16 keys.
fun policy_shrink_decode(body: cell): PolicyShrink? {
    val opened = policy_open(body);
    if (opened == null || opened.remainingBitsCount() != 34 || opened.preloadUint(32) != OP_GOV_POLICY_SHRINK) {
        return null;
    }
    val flags = opened.getLastBits(2).preloadUint(2);
    if (opened.remainingRefsCount() != (flags >> 1) + (flags & 1)) {
        return null;
    }
    // The shape was checked above, so this load cannot throw.
    val shrink = GovPolicyShrink.fromSlice(opened);
    val removes = policy_refs_decode(shrink.removes);
    val lowers = policy_lowers_decode(shrink.lowers);
    if (removes == null || lowers == null || removes.size() + lowers.size() > POLICY_LIST_MAX) {
        return null;
    }
    return { removes, lowers };
}

// The only rows that may carry the emergency flag: the ops that have a pausing shape.
fun policy_emergency_row(row: PolicyRowKey): bool {
    if (row.sub == null) {
        return row.op == OP_WITHDRAWALS_ONLY_ON || row.op == OP_FACTORY_PAUSE;
    }
    return row.op == OP_T3_GOV && row.sub == EMERGENCY_FREEZE_ACTION;
}

// What gpol accepts of an item, apart from its target.
fun policy_item_ok(item: PolicyItem): bool {
    return item.max <= POLICY_VALUE_MAX
        && item.max >= POLICY_VALUE_MARGIN * item.min
        && (!item.emergency || policy_emergency_row(item.row));
}

// Rebuilt from validated fields. An emergency row is permanent whatever the item says: a vote that
// could remove a pause row would leave its target impossible to pause.
fun policy_entry_of(item: PolicyItem): PolicyEntry {
    return {
        minValue: item.min,
        maxValue: item.max,
        class: item.class,
        emergency: item.emergency,
        permanent: item.permanent || item.emergency,
    };
}

// What ghnd and its log commit to: 0 for the empty policy, else the hash of the dictionary root.
fun policy_root(policy: PolicyMap): uint256 {
    val root = policy.toLowLevelDict();
    return root == null ? 0 : root.hash();
}

// The entry of exactly this row: a key without `sub` names a plain entry and nothing else.
fun policy_find(policy: PolicyMap, row: PolicyRowKey): PolicyEntry? {
    val found = policy.get(policy_key(row.target, row.op));
    if (!found.isFound) {
        return null;
    }
    val node = found.loadValue();
    if (node is PolicyPlain) {
        return row.sub == null ? node.entry : null;
    }
    if (row.sub == null) {
        return null;
    }
    val entry = node.subs.get(row.sub);
    return entry.isFound ? entry.loadValue() : null;
}

// The entry that governs sending `body` to `target`, or null. A multiplexed op is selected by the
// byte after query_id and by nothing else; a plain op has one entry whatever follows its tag.
fun policy_entry_for(policy: PolicyMap, target: address, body: cell): PolicyEntry? {
    val op = action_op(body);
    if (op == null) {
        return null;
    }
    val found = policy.get(policy_key(target, op));
    if (!found.isFound) {
        return null;
    }
    val node = found.loadValue();
    if (node is PolicyPlain) {
        return node.entry;
    }
    val sub = action_sub(body);
    if (sub == null) {
        return null;
    }
    val entry = node.subs.get(sub);
    return entry.isFound ? entry.loadValue() : null;
}

// Upserts one row. Refused, and nothing written, when the node of (target, op) is of the other kind.
fun policy_put(mutate policy: PolicyMap, row: PolicyRowKey, entry: PolicyEntry): int {
    val key = policy_key(row.target, row.op);
    val found = policy.get(key);
    if (row.sub == null) {
        if (found.isFound && found.loadValue() is PolicySubs) {
            return POLICY_PUT_REFUSED;
        }
        policy.set(key, PolicyPlain { entry });
        return found.isFound ? POLICY_PUT_REPLACED : POLICY_PUT_ADDED;
    }
    var subs: map<uint8, PolicyEntry> = [];
    if (found.isFound) {
        val node = found.loadValue();
        if (node is PolicyPlain) {
            return POLICY_PUT_REFUSED;
        }
        subs = node.subs;
    }
    val replaced = subs.setAndGetPrevious(row.sub, entry).isFound;
    policy.set(key, PolicySubs { subs });
    return replaced ? POLICY_PUT_REPLACED : POLICY_PUT_ADDED;
}

// Removes one row. The node goes with its last sub row, so the root depends on the rows alone.
fun policy_drop(mutate policy: PolicyMap, row: PolicyRowKey): bool {
    val key = policy_key(row.target, row.op);
    val found = policy.get(key);
    if (!found.isFound) {
        return false;
    }
    val node = found.loadValue();
    if (node is PolicyPlain) {
        return row.sub == null && policy.delete(key);
    }
    if (row.sub == null) {
        return false;
    }
    var subs = node.subs;
    if (!subs.delete(row.sub)) {
        return false;
    }
    if (subs.isEmpty()) {
        policy.delete(key);
    } else {
        policy.set(key, PolicySubs { subs });
    }
    return true;
}

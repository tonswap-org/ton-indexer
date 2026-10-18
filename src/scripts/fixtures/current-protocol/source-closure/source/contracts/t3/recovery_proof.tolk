tolk 1.5.0

import "@gen/op/tep";
import "wallet_types";
import "wallet_budget";
import "@stdlib/exotic-cells";
import "@stdlib/gas-payments";
import "../generated/op/t3";
import "./recovery_types";
import "deposit_intent";
import "../shared/utils/rich_bounce";
import "../shared/jetton/tep74_codec";
fun previousBlocks(): tuple? asm "PREVBLOCKSINFOTUPLE";
fun trustedBlock(hash: int): bool {
    val p = previousBlocks();
    if (p == null) { return false; }
    var group = 0;
    repeat (p!.size()) {
        if (group == 0 || group == 2) {
            val rows = p!.get(group) as tuple;
            var i = 0;
            repeat (rows.size()) {
                val row = rows.get(i) as tuple;
                if ((row.get(0) as int) == -1 && (row.get(3) as int) == hash) { return true; }
                i += 1;
            }
        }
        group += 1;
    }
    return false;
}
fun ordinary(c: cell): slice {
    val (s, exotic) = c.beginParseSpecial();
    assert (!exotic) throw 860;
    return s;
}
fun blockStateHash(block: cell): int {
    var s = ordinary(block);
    assert (s.loadUint(32) == 0x11ef55aa) throw 861;
    s.skipBits(32); s.loadRef(); s.loadRef();
    val update = s.loadRef();
    s.loadRef(); s.assertEnd();
    var (u, exotic) = update.beginParseSpecial();
    assert (exotic && u.loadUint(8) == 4) throw 862;
    val oldHash = u.loadUint(256); val newHash = u.loadUint(256);
    val oldDepth = u.loadUint(16); val newDepth = u.loadUint(16);
    val oldRef = u.loadRef(); val newRef = u.loadRef(); u.assertEnd();
    assert (oldRef.hashOfLevel(0) == oldHash && newRef.hashOfLevel(0) == newHash
        && oldRef.depthOfLevel(0) == oldDepth && newRef.depthOfLevel(0) == newDepth) throw 863;
    return newHash;
}
fun stateParts(state: cell, hash: int, wc: int, accountId: int): (cell,cell?) {
    assert (state.hashOfLevel(0) == hash) throw 864;
    var s = ordinary(state);
    assert (s.loadUint(32) == 0x9023afe2) throw 865;
    s.skipBits(32);
    assert (s.loadUint(2) == 0) throw 866;
    val depth = s.loadUint(6); val workchain = s.loadInt(32); val prefix = s.loadUint(64);
    assert (depth <= 60 && workchain == wc) throw 867;
    if (depth > 0) { assert ((accountId >> (256 - depth)) == (prefix >> (64 - depth))) throw 868; }
    if (wc == -1) { assert (depth == 0 && prefix == 0) throw 869; }
    s.skipBits(32 + 32 + 32 + 64 + 32); s.loadRef(); s.loadBool();
    val accounts = s.loadRef(); s.loadRef();
    val extra = s.loadMaybeRef(); s.assertEnd();
    return (accounts, extra);
}
fun shardBlock(extra: cell, accountId: int): int {
    var s = ordinary(extra); assert (s.loadUint(16) == 0xcc26) throw 870;
    val hashes = s.loadAny<map<int32,cell>>();
    var node = hashes.mustGet(0); var depth = 0;
    while (true) {
        var b = ordinary(node);
        if (!b.loadBool()) {
            val tag = b.loadUint(4); assert (tag == 10 || tag == 11) throw 871;
            b.skipBits(32 + 32 + 64 + 64); return b.loadUint(256);
        }
        assert (depth < 60) throw 872;
        val left = b.loadRef(); val right = b.loadRef(); b.assertEnd();
        node = ((accountId >> (255 - depth)) & 1) == 0 ? left : right; depth += 1;
    }
    throw 873;
}
fun dictionaryWalk(root: cell, key: int, bits: int, budget: int): (cell,int,int,bool) {
    var node = root; var n = bits;
    repeat (budget) {
        var s = ordinary(node); var length = 0; var prefix = 0;
        if (!s.loadBool()) {
            while (s.loadBool()) { length += 1; assert (length <= n) throw 874; }
            if (length > 0) { prefix = s.loadUint(length); }
        } else {
            val same = s.loadBool(); var bit = false;
            if (same) { bit = s.loadBool(); }
            var width = 0; var rest = n;
            while (rest > 0) { width += 1; rest >>= 1; }
            length = s.loadUint(width); assert (length <= n) throw 875;
            if (same) { prefix = bit && length > 0 ? ((1 << (length - 1)) - 1) * 2 + 1 : 0; }
            else if (length > 0) { prefix = s.loadUint(length); }
        }
        assert (prefix == (key >> (n - length))) throw 876;
        n -= length;
        if (n == 0) { return (s.toCell(),key,0,true); }
        if (n < 256) { key &= (1 << n) - 1; }
        val left = s.loadRef(); val right = s.loadRef();
        n -= 1; node = ((key >> n) & 1) == 0 ? left : right;
        key &= (1 << n) - 1;
    }
    return (node,key,n,false);
}
fun dictionaryLeaf(root: cell, key: int, bits: int): slice {
    val (leaf,_,_,done) = dictionaryWalk(root,key,bits,bits+1);
    assert (done) throw 877; return ordinary(leaf);
}
fun accountBranch(mcBlock: cell, mcState: cell, scBlock: cell, scState: cell, owner: address): (cell,int) {
    val (wc, id) = owner.getWorkchainAndHash(); assert (wc == 0) throw 879;
    val (_, extra) = stateParts(mcState,blockStateHash(mcBlock),-1,0); assert (extra != null) throw 880;
    assert (scBlock.hashOfLevel(0) == shardBlock(extra!,id)) throw 881;
    val (accounts, _) = stateParts(scState,blockStateHash(scBlock),0,id);
    var a = ordinary(accounts); assert (a.loadBool()) throw 882;
    return (a.loadRef(),id);
}
fun proofTree(bundle: cell): cell {
    var (p, exotic) = bundle.beginParseSpecial();
    assert (exotic && p.loadUint(8) == 3) throw 883;
    val hash = p.loadUint(256); val depth = p.loadUint(16); val child = p.loadRef(); p.assertEnd();
    assert (child.hashOfLevel(0) == hash && child.depthOfLevel(0) == depth) throw 884;
    return child;
}
fun historicalBlock(bundle: cell, seqno: uint32): int {
    var b = ordinary(proofTree(bundle));
    val block = b.loadRef(); val state = b.loadRef(); b.assertEnd();
    assert (trustedBlock(block.hashOfLevel(0))) throw 878;
    val (_, extra) = stateParts(state,blockStateHash(block),-1,0); assert (extra != null) throw 880;
    var e = ordinary(extra!); assert (e.loadUint(16) == 0xcc26) throw 870;
    e.loadMaybeRef(); e.skipBits(256); e.loadRef();
    var info = ordinary(e.loadRef()); assert (info.loadUint(16) <= 1) throw 885;
    info.skipBits(32 + 32 + 1);
    assert (info.loadBool()) throw 886;
    var leaf = dictionaryLeaf(info.loadRef(),seqno,32);
    leaf.skipBits(1 + 64); leaf.loadBool(); leaf.skipBits(64);
    assert (leaf.loadUint(32) == seqno) throw 887;
    val hash = leaf.loadUint(256); leaf.skipBits(256); leaf.assertEnd();
    return hash;
}

struct TransactionLink {
    previousHash: uint256; previousLt: uint64; oldHash: uint256; newHash: uint256;
    successful: bool; messages: cell; outCount: uint15; hash: uint256; lt: uint64; description: cell
}
// A nonzero exit code alone is insufficient: COMMIT may preserve a prior state.
// Canonical aborted transactions retain no compute/action state or outgoing actions.
fun genericAborted(desc: cell): bool {
    var d = ordinary(desc);
    if (d.loadUint(4) != 0) { return false; }
    d.loadBool();
    if (d.loadBool()) {
        d.loadCoins(); if (d.loadBool()) { d.loadCoins(); }
        if (d.loadBool()) { d.loadBool(); }
    }
    if (d.loadBool()) {
        if (d.loadBool()) { d.loadCoins(); }
        d.loadCoins(); d.loadMaybeRef();
    }
    if (d.loadBool()) { d.skipBits(3); d.loadCoins(); d.loadRef(); }
    else { if (d.loadUint(2) == 3) { assert (!d.loadBool()) throw 927; } }
    d.loadMaybeRef();
    val aborted = d.loadBool();
    if (d.loadBool()) {
        val sent = d.loadBool();
        if (sent || d.loadBool()) {
            var bytes = d.loadUint(3); d.skipBits(bytes * 8);
            bytes = d.loadUint(3); d.skipBits(bytes * 8);
            d.loadCoins(); if (sent) { d.loadCoins(); }
        }
    }
    d.loadBool(); d.assertEnd(); return aborted;
}
fun genericSuccess(desc: cell): bool {
    var d = ordinary(desc);
    if (d.loadUint(4) != 0) { return false; }
    d.loadBool();
    if (d.loadBool()) {
        d.loadCoins(); if (d.loadBool()) { d.loadCoins(); }
        if (d.loadBool()) { return false; }
    }
    if (d.loadBool()) {
        if (d.loadBool()) { d.loadCoins(); }
        d.loadCoins(); d.loadMaybeRef();
    }
    if (!d.loadBool() || !d.loadBool()) { return false; }
    d.skipBits(2); d.loadCoins();
    var vm = ordinary(d.loadRef());
    val usedBytes = vm.loadUint(3); vm.skipBits(usedBytes * 8);
    val limitBytes = vm.loadUint(3); vm.skipBits(limitBytes * 8);
    if (vm.loadBool()) { val creditBytes = vm.loadUint(2); vm.skipBits(creditBytes * 8); }
    vm.skipBits(8); val exitCode = vm.loadInt(32);
    if (exitCode != 0 && exitCode != 1) { return false; }
    val action = d.loadMaybeRef();
    if (action != null) {
        var a = ordinary(action!);
        if (!a.loadBool() || !a.loadBool() || a.loadBool() || a.loadBool()) { return false; }
        if (a.loadBool()) { a.loadCoins(); }
        if (a.loadBool()) { a.loadCoins(); }
        if (a.loadInt(32) != 0) { return false; }
    }
    if (d.loadBool() || d.loadBool() || d.loadBool()) { return false; }
    d.assertEnd(); return true;
}
fun transactionLink(raw: cell, expectedHash: int, expectedLt: int, owner: address): TransactionLink {
    assert (raw.hashOfLevel(0) == expectedHash) throw 889;
    var t = ordinary(raw); assert (t.loadUint(4) == 7) throw 890;
    val (wc, id) = owner.getWorkchainAndHash();
    assert (wc == 0 && t.loadUint(256) == id && t.loadUint(64) == expectedLt) throw 891;
    val previousHash = t.loadUint(256); val previousLt = t.loadUint(64);
    assert (previousLt < expectedLt) throw 892;
    t.skipBits(32); val outCount = t.loadUint(15) as uint15; t.skipBits(2); val active = t.loadUint(2) == 2;
    val messages = t.loadRef(); t.loadCoins(); t.loadMaybeRef();
    var u = ordinary(t.loadRef()); assert (u.loadUint(8) == 0x72) throw 893;
    val oldHash = u.loadUint(256); val newHash = u.loadUint(256); u.assertEnd();
    val desc = t.loadRef(); t.assertEnd();
    return { previousHash, previousLt, oldHash, newHash, messages, outCount, successful: active && genericSuccess(desc),
        hash: expectedHash as uint256, lt: expectedLt as uint64, description: desc };
}
fun transactionWalk(owner: address, suffix: cell, lastHash: int, lastLt: int): TransactionLink {
    var hash = lastHash; var lt = lastLt; var node = suffix;
    repeat (4) {
        var s = ordinary(node); val raw = proofTree(s.loadRef()); val next = s.loadMaybeRef(); s.assertEnd();
        val link = transactionLink(raw,hash,lt,owner);
        if (next == null) { return link; }
        hash = link.previousHash; lt = link.previousLt; node = next!;
    }
    throw 894;
}

struct MessageFields { sender: address; recipient: address; body: cell; init: cell? }
fun readInit(mutate s: slice): cell {
    var b = beginCell();
    val split = s.loadBool(); b.storeBool(split); if (split) { b.storeUint(s.loadUint(5),5); }
    val special = s.loadBool(); b.storeBool(special); if (special) { b.storeUint(s.loadUint(2),2); }
    b.storeMaybeRef(s.loadMaybeRef()); b.storeMaybeRef(s.loadMaybeRef()); b.storeMaybeRef(s.loadMaybeRef());
    return b.endCell();
}
fun transactionMessage(link: TransactionLink, index: int): cell {
    var s = ordinary(link.messages); val incoming = s.loadMaybeRef();
    if (index == -1) { assert (incoming != null) throw 895; return incoming!; }
    assert (index >= 0 && index < 32768 && s.loadBool()) throw 896;
    var leaf = dictionaryLeaf(s.loadRef(),index,15);
    val result = leaf.loadRef(); leaf.assertEnd(); return result;
}
fun messageFields(message: cell, bounced: bool = false): MessageFields {
    var s = ordinary(message);
    assert (!s.loadBool() && s.loadBool()) throw 897;
    s.loadBool(); assert (s.loadBool() == bounced) throw 898;
    val sender = s.loadAddress(); val recipient = s.loadAddress();
    s.loadCoins(); s.loadMaybeRef(); s.loadCoins(); s.loadCoins(); s.skipBits(64 + 32);
    var init: cell? = null;
    if (s.loadBool()) {
        if (s.loadBool()) { init = s.loadRef(); }
        else { init = readInit(mutate s); }
    }
    var body: cell = createEmptyCell();
    if (s.loadBool()) { body = s.loadRef(); s.assertEnd(); }
    else { body = s.toCell(); }
    return { sender, recipient, body, init };
}
fun failedMessage(link: TransactionLink, recipient: address, sender: address, bodyHash: int, noReturnedTransfer: bool): int {
    assert (genericAborted(link.description)) throw 928;
    val incoming = transactionMessage(link,-1);
    val message = messageFields(incoming);
    assert (message.recipient == recipient && message.sender == sender
        && message.body.hashOfLevel(0) == bodyHash) throw 929;
    var body = ordinary(message.body);
    if (noReturnedTransfer && body.remainingBitsCount() >= 32 && body.preloadUint(32) == OP_TEP74_TRANSFER) {
        // A returned refusal already restores the holder's ordinary owed claim.
        var outputs = ordinary(link.messages); outputs.loadMaybeRef();
        assert (link.outCount == 0 && !outputs.loadBool()) throw 928; outputs.assertEnd();
    }
    return incoming.hashOfLevel(0);
}
fun routedFailure(link: TransactionLink, messageHash: int): void {
    assert (genericAborted(link.description)) throw 928;
    assert (transactionMessage(link,-1).hashOfLevel(0) == messageHash) throw 910;
}
// The admitting root binds and consumes its exact attempt.

fun accountState(account: cell, hash: int, wallet: address): slice? {
    assert (account.hashOfLevel(0) == hash) throw 899;
    var s = ordinary(account);
    if (!s.loadBool()) { s.assertEnd(); return null; }
    assert (s.loadAddress() == wallet) throw 900;
    val cellBytes = s.loadUint(3); s.skipBits(cellBytes * 8);
    val bitBytes = s.loadUint(3); s.skipBits(bitBytes * 8);
    val extra = s.loadUint(3); assert (extra <= 1) throw 901;
    if (extra == 1) { s.skipBits(256); }
    s.skipBits(32); if (s.loadBool()) { s.loadCoins(); }
    s.skipBits(64); s.loadCoins(); s.loadMaybeRef();
    return s;
}
fun pinnedData(init: slice, codeHash: int, prefix: int = 0): cell {
    var s = init;
    if (prefix == 0) { assert (!s.loadBool()) throw 902; }
    else { assert (s.loadBool() && s.loadUint(5) == prefix) throw 902; }
    assert (!s.loadBool()) throw 902;
    val code = s.loadMaybeRef(); val data = s.loadMaybeRef();
    assert (code != null && data != null && s.loadMaybeRef() == null) throw 903;
    s.assertEnd(); assert (code!.hashOfLevel(0) == codeHash) throw 904;
    ordinary(data!); return data!;
}
fun walletData(account: cell, hash: int, wallet: address, codeHash: int): cell {
    val state = accountState(account,hash,wallet); assert (state != null) throw 900;
    var s = state!; assert (s.loadBool()) throw 902; return pinnedData(s,codeHash);
}

fun reservePrefix(init: slice): int {
    var s = init;
    if (!s.loadBool()) { return 0; }
    assert (s.loadUint(5) == 8) throw 902;
    return 8;
}
fun reserveInitBalance(init: slice, codeHash: int, owner: address, master: address): coins {
    // Governed reserves and the sharded v2.1 reserve have distinct pinned StateInit profiles.
    val prefix = reservePrefix(init);
    var d = ordinary(pinnedData(init,codeHash,prefix));
    if (prefix == 0) { d.skipBits(4); }
    val balance = d.loadCoins();
    assert (d.loadAddress() == owner && d.loadAddress() == master) throw 905;
    d.assertEnd(); return balance;
}
fun reserveBalance(account: cell, hash: int, wallet: address, codeHash: int, owner: address, master: address): (coins,int) {
    val state = accountState(account,hash,wallet); assert (state != null) throw 900;
    var s = state!; assert (s.loadBool()) throw 902;
    return (reserveInitBalance(s,codeHash,owner,master),reservePrefix(s));
}
fun targetOldBalance(account: cell, hash: int, wallet: address, codeHash: int, owner: address, master: address, incoming: cell): (coins,int) {
    val state = accountState(account,hash,wallet);
    if (state != null) {
        var s = state!;
        if (s.preloadUint(1) == 1) { return reserveBalance(account,hash,wallet,codeHash,owner,master); }
        // Frozen prior reserve state is not an accepted credit proof.
        assert (s.loadUint(2) == 0) throw 919; s.assertEnd();
    }
    val init = messageFields(incoming).init; assert (init != null) throw 920;
    val (_,addressHash) = wallet.getWorkchainAndHash();
    val prefix = reservePrefix(ordinary(init!));
    if (prefix == 0) { assert (init!.hashOfLevel(0) == addressHash) throw 921; }
    else {
        val (_,ownerHash) = owner.getWorkchainAndHash();
        val suffix = (1 << 248) - 1;
        assert ((addressHash >> 248) == (ownerHash >> 248)
            && (init!.hashOfLevel(0) & suffix) == (addressHash & suffix)) throw 921;
    }
    val balance = reserveInitBalance(ordinary(init!),codeHash,owner,master);
    assert (balance == 0) throw 922; return (0,prefix);
}
// Evidence selection confers no authority. The admitting controller must pin CreditIdentity.

// A nonce changes only the expendable session address. No durable claim lives here.

fun sourceEvidence(config: CreditIdentity, source: TransactionLink, states: cell): int {
    var ids = ordinary(config.identities); val controller = ids.loadAddress(); val hub = ids.loadAddress(); val master = ids.loadAddress(); ids.assertEnd();
    var w = ordinary(config.wallets); val sourceWallet = w.loadAddress(); val targetWallet = w.loadAddress();
    val queryId = w.loadUint(64); val amount = w.loadCoins(); w.assertEnd(); assert (amount > 0) throw 906;
    assert (source.successful) throw 907;
    val command = messageFields(transactionMessage(source,-1));
    assert (command.sender == controller && command.recipient == sourceWallet
        && command.body.hashOfLevel(0) == config.requestHash) throw 908;
    var commandBody = ordinary(command.body);
    assert (commandBody.loadUint(32) == OP_TEP74_TRANSFER && commandBody.loadUint(64) == queryId
        && commandBody.loadCoins() == amount && commandBody.loadAddress() == hub) throw 909;
    assert (t3_request_intent(command.body).hash() == config.intent.hash()) throw 909;
    val emitted = transactionMessage(source,0); val delivery = messageFields(emitted);
    assert (delivery.sender == sourceWallet && delivery.recipient == targetWallet) throw 911;
    var body = ordinary(delivery.body);
    assert (body.loadUint(32) == OP_TEP74_INTERNAL_TRANSFER && body.loadUint(64) == queryId && body.loadCoins() == amount) throw 912;
    var a = ordinary(states); val before = a.loadRef(); val after = a.loadRef(); a.assertEnd();
    val (beforeBalance,beforePrefix) = reserveBalance(before,source.oldHash,sourceWallet,config.codeHash,controller,master);
    val (afterBalance,afterPrefix) = reserveBalance(after,source.newHash,sourceWallet,config.codeHash,controller,master);
    assert (beforePrefix == afterPrefix && beforeBalance - amount == afterBalance) throw 913;
    return emitted.hashOfLevel(0);
}
fun targetEvidence(config: CreditIdentity, target: TransactionLink, states: cell, messageHash: int): int {
    var ids = ordinary(config.identities); ids.loadAddress(); val hub = ids.loadAddress(); val master = ids.loadAddress(); ids.assertEnd();
    var w = ordinary(config.wallets); w.loadAddress(); val targetWallet = w.loadAddress();
    w.skipBits(64); val amount = w.loadCoins(); w.assertEnd();
    assert (target.successful) throw 907;
    val received = transactionMessage(target,-1); assert (received.hashOfLevel(0) == messageHash) throw 910;
    var a = ordinary(states); val before = a.loadRef(); val after = a.loadRef(); a.assertEnd();
    val (beforeBalance,beforePrefix) = targetOldBalance(before,target.oldHash,targetWallet,config.codeHash,hub,master,received);
    val (afterBalance,afterPrefix) = reserveBalance(after,target.newHash,targetWallet,config.codeHash,hub,master);
    assert (beforePrefix == afterPrefix && beforeBalance + amount == afterBalance) throw 913;
    return messageHash;
}

fun freshCreditData(data: cell, owner: address, master: address): T3WalletState {
    val st = T3WalletState.fromCell(data); val cfg = st.config.load();
    assert (cfg.owner == owner && cfg.master == master) throw 905;
    return st;
}
fun notificationEvidence(config: CreditIdentity, source: TransactionLink, states: cell): int {
    var ids = ordinary(config.identities); val owner = ids.loadAddress();
    assert (ids.loadAddress() == owner) throw 905; val master = ids.loadAddress(); ids.assertEnd();
    var w = ordinary(config.wallets); val wallet = w.loadAddress();
    assert (w.loadAddress() == owner) throw 905; val queryId = w.loadUint(64); val amount = w.loadCoins(); w.assertEnd();
    assert (source.successful && amount > 0) throw 907;
    val received = transactionMessage(source,-1); val delivery = messageFields(received);
    assert (delivery.recipient == wallet && delivery.body.hashOfLevel(0) == config.requestHash) throw 908;
    var b = ordinary(delivery.body); assert (b.loadUint(32) == OP_T3_WALLET_DELIVERY) throw 909;
    val attempt = (b.loadRef() as Cell<WalletAttempt>).load(); b.assertEnd(); val terms = attempt.terms.load(); val details = terms.details.load();
    assert (!terms.burn && terms.recipient == owner && terms.amount == amount && details.queryId == queryId && details.forwardValue > 0) throw 909;
    var a = ordinary(states); val before = a.loadRef(); val after = a.loadRef(); a.assertEnd();
    val next = freshCreditData(walletData(after,source.newHash,wallet,config.codeHash),owner,master);
    val priorState = accountState(before,source.oldHash,wallet); var prior: T3WalletState;
    if (priorState != null && priorState!.preloadUint(1) == 1) {
        prior = freshCreditData(walletData(before,source.oldHash,wallet,config.codeHash),owner,master);
    } else {
        if (priorState != null) { var old = priorState!; assert (old.loadUint(2) == 0) throw 919; old.assertEnd(); }
        assert (delivery.init != null) throw 920; val (_,id) = wallet.getWorkchainAndHash();
        assert (delivery.init!.hashOfLevel(0) == id) throw 921;
        prior = freshCreditData(pinnedData(ordinary(delivery.init!),config.codeHash),owner,master);
        assert (prior.balance == 0 && prior.protectedCredits == 0) throw 922;
    }
    assert (prior.config.hash() == next.config.hash() && next.balance == prior.balance + amount
        && next.protectedCredits == prior.protectedCredits + amount && next.acceptedTransfers == prior.acceptedTransfers) throw 913;
    val emitted = transactionMessage(source,0); val notification = messageFields(emitted);
    assert (notification.sender == wallet && notification.recipient == owner
        && notification.body.hashOfLevel(0) == t3_wallet_notification(terms).hashOfLevel(0)) throw 911;
    return emitted.hashOfLevel(0);
}

// A source refusal can be lost when its holder cannot execute the emitted bounce.
fun sourceBounceEvidence(config: CreditIdentity, source: TransactionLink): int {
    var ids = ordinary(config.identities); val owner = ids.loadAddress();
    assert (ids.loadAddress() == owner) throw 905; ids.loadAddress(); ids.assertEnd();
    var wallets = ordinary(config.wallets); val wallet = wallets.loadAddress();
    assert (wallets.loadAddress() == owner) throw 905;
    val queryId = wallets.loadUint(64); val amount = wallets.loadCoins(); wallets.assertEnd();
    assert (genericAborted(source.description) && source.outCount == 1 && amount > 0) throw 928;
    val command = messageFields(transactionMessage(source,-1));
    assert (command.sender == owner && command.recipient == wallet && command.body.hashOfLevel(0) == config.requestHash) throw 929;
    var request = ordinary(command.body);
    assert (request.loadUint(32) == OP_TEP74_TRANSFER && request.loadUint(64) == queryId && request.loadCoins() == amount) throw 929;
    request.loadAddress(); request.loadAddress();
    assert (!request.loadBool()) throw 929; request.loadCoins();
    if (request.loadBool()) { request.loadRef(); } request.assertEnd();
    val emitted = transactionMessage(source,0); val bounce = messageFields(emitted,true);
    assert (bounce.sender == wallet && bounce.recipient == owner && rich_bounce_is_canonical(ordinary(bounce.body))) throw 911;
    val rich = RichBounceBody.fromCell(bounce.body);
    assert (rich.originalBody.hashOfLevel(0) == config.requestHash) throw 911;
    return emitted.hashOfLevel(0);
}

fun proofWallet(config: CreditIdentity, source: bool): address {
    var w = ordinary(config.wallets); val first = w.loadAddress(); val second = w.loadAddress();
    return source ? first : second;
}
fun branchCursor(bundle: cell, owner: address, anchor: int): Cursor {
    var b = ordinary(proofTree(bundle)); val mcBlock = b.loadRef(); val mcState = b.loadRef();
    val scBlock = b.loadRef(); val scState = b.loadRef(); b.assertEnd();
    assert (mcBlock.hashOfLevel(0) == anchor) throw 923;
    val (root,key) = accountBranch(mcBlock,mcState,scBlock,scState,owner);
    return { hash: root.hashOfLevel(0) as uint256, key: key as uint256, bits: 256, txLt: 0 };
}
// Bounded proof session. Receivers authenticate the pristine session and current claim.
fun onInternalMessage(in: InMessage) {
    if (in.body.isEmpty()) { return; }
    var b = in.body; assert (b.loadUint(32) == OP_T3_PROOF_STEP) throw 914; val op = b.loadUint(8);
    if (op == 30 || op == 31) {
        val state = StagedProof.fromCell(contract.getData());
        assert (state.phase == (op == 30 ? 7 : 6)) throw 931;
        assert (op != 31 || state.evidence == 0) throw 931;
        val payload = b.loadRef(); val value = b.loadCoins(); b.assertEnd();
        assert (value > 0 && in.valueCoins >= calculateGasFee(0,250000)) throw 915;
        setGasLimit(250000);
        var identities = ordinary(state.config.load().credit.load().identities);
        var receiver = identities.loadAddress();
        if (op == 31) { receiver = identities.loadAddress(); }
        val routed = op == 30 && state.evidence == 0 && state.cursor.load().bits == 1;
        val certificateOp = state.evidence == 1 ? OP_T3_NOTIFICATION_CERTIFICATE : op == 31 ? OP_T3_CREDIT_CERTIFICATE
            : (routed ? OP_T3_ROUTED_FAILURE_CERTIFICATE : OP_T3_FAILURE_CERTIFICATE);
        var body = beginCell().storeUint(certificateOp,32).storeRef(state.config).storeRef(payload).storeRef(contract.getCode());
        if (op == 31 || routed || state.evidence == 1) { body.storeUint(state.messageHash,256); }
        val message = createMessage({ bounce: BounceMode.Only256BitsOfBody, dest: receiver, value, body });
        assert (in.valueCoins >= value + calculateGasFee(0,250000)) throw 915;
        reserveGramsOnBalance(max(contract.getOriginalBalance()-in.valueCoins,0), RESERVE_MODE_EXACT_AMOUNT | RESERVE_MODE_BOUNCE_ON_ACTION_FAIL);
        // Action-phase fee charging avoids a compute walk over the original request graph.
        // Insufficient forwarding funds revert this send; the completed proof stays reusable.
        message.send(SEND_MODE_PAY_FEES_SEPARATELY | SEND_MODE_BOUNCE_ON_ACTION_FAIL);
        // The certificate is reusable after stale witnesses or receiver rollback.
        // The receiver's exact current claim is the economic replay protection.
        return;
    }
    assert ((op >= 10 && op <= 17) || (op >= 20 && op <= 25)) throw 914;
    assert (in.valueCoins >= calculateGasFee(0,250000)) throw 915;
    setGasLimit(250000);
    var state = StagedProof.fromCell(contract.getData()); val session = state.config.load();
    val config = session.credit.load(); val targets = session.targets.load();
    val source = op < 20; val step = op % 10; val base = source ? 0 : 3;
    val intended = (source ? targets.source : targets.target).load();
    if (step == 0 || step == 5) {
        assert (state.phase == base) throw 916;
        val bundle = b.loadRef();
        if (step == 5) {
            val seqno = b.loadUint(32); val history = b.loadRef();
            assert (historicalBlock(history,seqno) == intended.anchor) throw 930;
        } else { assert (trustedBlock(intended.anchor)) throw 878; }
        b.assertEnd();
        state.cursor = branchCursor(bundle,proofWallet(config,source),intended.anchor).toCell(); state.phase = (base+1) as uint3;
    } else if (step == 1) {
        assert (state.phase == base+1) throw 916;
        val node = proofTree(b.loadRef()); b.assertEnd(); var cursor = state.cursor.load();
        assert (node.hashOfLevel(0) == cursor.hash) throw 917;
        val (next,key,bits,done) = dictionaryWalk(node,cursor.key,cursor.bits,64);
        if (done) {
            var leaf = ordinary(next); leaf.skipBits(5); leaf.loadCoins(); leaf.loadMaybeRef(); leaf.loadRef();
            cursor.hash = leaf.loadUint(256) as uint256; cursor.txLt = leaf.loadUint(64) as uint64; leaf.assertEnd();
            assert (cursor.txLt >= intended.lt && intended.lt > 0) throw 924;
            assert (cursor.txLt != intended.lt || cursor.hash == intended.hash) throw 925;
            cursor.key = 0; cursor.bits = 0; state.phase = (base+2) as uint3;
        } else { cursor.hash = next.hashOfLevel(0) as uint256; cursor.key = key as uint256; cursor.bits = bits as uint9; }
        state.cursor = cursor.toCell();
    } else if (step == 2 || step == 3 || step == 4 || (source && (step == 6 || step == 7))) {
        assert (state.phase == base+2) throw 916;
        val suffix = b.loadRef(); var cursor = state.cursor.load();
        val link = transactionWalk(proofWallet(config,source),suffix,cursor.hash,cursor.txLt);
        if (step == 2) {
            b.assertEnd(); assert (link.previousLt >= intended.lt && intended.lt > 0) throw 924;
            assert (link.previousLt != intended.lt || link.previousHash == intended.hash) throw 925;
            cursor.hash = link.previousHash; cursor.txLt = link.previousLt; state.cursor = cursor.toCell();
        } else if (step == 4) {
            b.assertEnd();
            assert (link.lt == intended.lt && link.hash == intended.hash) throw 926;
            if (source) {
                var ids = ordinary(config.identities); val sender = ids.loadAddress();
                val noReturnedTransfer = ids.loadAddress() == sender;
                if (noReturnedTransfer && proofWallet(config,true) != proofWallet(config,false)) {
                    val request = ordinary(messageFields(transactionMessage(link,-1)).body);
                    assert (request.remainingBitsCount() < 32 || request.preloadUint(32) != OP_TEP74_TRANSFER) throw 928;
                }
                state.messageHash = failedMessage(link,proofWallet(config,true),sender,config.requestHash,noReturnedTransfer) as uint256;
            } else { routedFailure(link,state.messageHash); }
            // The final cursor distinguishes a direct refusal from a debited delivery failure.
            cursor.bits = source ? 0 : 1; state.cursor = cursor.toCell();
            state.phase = 7;
        } else if (step == 7) {
            b.assertEnd(); assert (link.lt == intended.lt && link.hash == intended.hash) throw 926;
            assert (state.evidence == 0) throw 916;
            state.messageHash = sourceBounceEvidence(config,link) as uint256;
            state.evidence = 2; state.phase = 3;
        } else {
            val states = b.loadRef(); b.assertEnd();
            assert (link.lt == intended.lt && link.hash == intended.hash) throw 926;
            assert (state.evidence == 0) throw 916;
            state.messageHash = (step == 6 ? notificationEvidence(config,link,states) : source ? sourceEvidence(config,link,states)
                : targetEvidence(config,link,states,state.messageHash)) as uint256;
            state.evidence = step == 6 ? 1 : 0;
            state.phase = (base+3) as uint3;
        }
    } else { throw 914; }
    contract.setData(state.toCell());
}
get fun stage(): (int,int,Cursor) { val st = StagedProof.fromCell(contract.getData()); return (st.phase,st.messageHash,st.cursor.load()); }
get fun proofConfig(): cell { return StagedProof.fromCell(contract.getData()).config; }
get fun proofValue(): coins { return calculateGasFee(0,250000); }


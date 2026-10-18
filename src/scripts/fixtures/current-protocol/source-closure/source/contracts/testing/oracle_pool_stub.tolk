tolk 1.5.0

// Stand-in for a pool wherever the oracle protocol or one of its consumers is tested: a ring, the
// responder and one test hook in place of the handlers that move a real pool's active bin and health.
// Like a pool, it sends nothing except through oracle_serve.

import "../generated/op/oracle.tolk";
import "../shared/oracle/evidence.tolk";
import "../shared/oracle/responder.tolk";

struct Storage {
    binSpacing: uint16;
    eligible: bool;
    ring: cell;
}

// A test hook, not a protocol message, so it carries a plain number instead of a registry tag:
// op:uint32 value:int32 healthy:bool records the state from this second on.
const STUB_OP_OBSERVE: int = 1;

fun onInternalMessage(in: InMessage) {
    // Deploy and top-up.
    if (in.body.remainingBitsCount() < 32) {
        return;
    }
    var s = Storage.fromCell(contract.getData());
    val op = in.body.preloadUint(32);
    if (op == OP_ORACLE_QUERY) {
        oracle_serve(in.senderAddress, in.valueCoins, in.body, s.ring, s.eligible, s.binSpacing);
        return;
    }
    assert (op == STUB_OP_OBSERVE) throw 0xffff;
    var body = in.body;
    body.skipBits(32);
    val value = body.loadInt(32);
    val healthy = body.loadBool();
    body.assertEnd();
    s.ring = ring_touch(s.ring, blockchain.now(), value, healthy);
    contract.setData(s.toCell());
}

get fun oracle_evidence(at: int): cell {
    val s = Storage.fromCell(contract.getData());
    return oracle_evidence_cell(s.ring, s.eligible, s.binSpacing, blockchain.now(), at);
}

get fun twap_at(t: int, window: int): (bool, int, int, int) {
    val s = Storage.fromCell(contract.getData());
    return oracle_twap_at(s.ring, s.binSpacing, blockchain.now(), t, window);
}

get fun observation_bounds(): (int, int, int, int, bool) {
    return oracle_observation_bounds(Storage.fromCell(contract.getData()).ring);
}

get fun get_oracle_min_forward(): coins {
    return oracle_min_forward();
}

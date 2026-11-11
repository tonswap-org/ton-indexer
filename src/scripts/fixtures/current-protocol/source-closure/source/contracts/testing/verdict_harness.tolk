tolk 1.5.0

// Every verdict rule as a pure getter over an evidence cell, and the smallest consumer of the oracle
// protocol: it asks its bound pool and records the evidence it would act on.

import "../shared/oracle/evidence.tolk";
import "../shared/oracle/verdict.tolk";

struct Storage {
    pool: address;
    accepted: uint32;
    evidence: cell?;   // the last evidence the consumer acted on
}

// The consumer's continuation: when it asked.
struct AskEcho {
    sentAt: uint64;
}

// A test hook, not a protocol message, so it carries a plain number instead of a registry tag:
// op:uint32 at:uint64 asks the bound pool with the whole message value.
const HARNESS_OP_ASK: int = 1;

type PoolMessage = OracleResult | OracleQuery;

fun onInternalMessage(in: InMessage) {
    var s = Storage.fromCell(contract.getData());
    if (in.senderAddress == s.pool) {
        // Only the exact layout from the bound pool counts; everything else is ignored, never thrown at.
        if (in.body.remainingBitsCount() != ORACLE_RESULT_BITS || in.body.remainingRefsCount() != 2) {
            return;
        }
        val msg = lazy PoolMessage.fromSlice(in.body);
        match (msg) {
            OracleResult => {
                val (ok, e) = evidence_decode(msg.evidence);
                var echo = msg.echo.beginParse();
                if (!ok || echo.remainingBitsCount() != 64 || echo.remainingRefsCount() != 0) {
                    return;
                }
                if (!oracle_request_live(echo.loadUint(64), blockchain.now())) {
                    return;
                }
                s.accepted += 1;
                s.evidence = msg.evidence;
                contract.setData(s.toCell());
            }
            OracleQuery => {}
            else => {}
        }
        return;
    }
    if (in.body.remainingBitsCount() < 32) {
        return;
    }
    var body = in.body;
    assert (body.loadUint(32) == HARNESS_OP_ASK) throw 0xffff;
    val at = body.loadUint(64);
    body.assertEnd();
    val query = createMessage({
        bounce: BounceMode.Only256BitsOfBody,
        value: 0,
        dest: s.pool,
        body: OracleQuery { queryId: 0, at: at, echo: AskEcho { sentAt: blockchain.now() }.toCell() },
    });
    query.send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
}

fun onBouncedMessage(in: InMessageBounced) {}

get fun consumer(): (address, int, cell?) {
    val s = Storage.fromCell(contract.getData());
    return (s.pool, s.accepted, s.evidence);
}

// The fields as stored, without the checks of evidence_decode, so that a rule can be asked about
// evidence no pool would build.
fun raw(c: cell): Evidence {
    return Evidence.fromCell(c);
}

get fun decode(c: cell): (bool, int, int, int, int, int, int, int) {
    val (ok, e) = evidence_decode(c);
    return (ok, e.servedAt, e.at, e.flags, e.spot, e.short, e.medium, e.long);
}

get fun fresh(c: cell, nowTs: int): bool {
    return oracle_fresh(raw(c), nowTs);
}

get fun request_live(sentAt: int, nowTs: int): bool {
    return oracle_request_live(sentAt, nowTs);
}

get fun priced(c: cell, nowTs: int): bool {
    return oracle_priced(raw(c), nowTs);
}

get fun admission(c: cell, nowTs: int): bool {
    return verdict_admission(raw(c), nowTs);
}

get fun voluntary_exit(c: cell, nowTs: int): bool {
    return verdict_exit(raw(c), nowTs);
}

get fun fill(c: cell, isBuy: bool): int {
    return verdict_fill(raw(c), isBuy);
}

get fun median(c: cell): int {
    return verdict_median(raw(c));
}

get fun forced(c: cell, nowTs: int): (bool, int) {
    return verdict_forced(raw(c), nowTs);
}

get fun market_buy(c: cell, nowTs: int): (bool, int) {
    return verdict_market_buy(raw(c), nowTs);
}

get fun expiry(c: cell, expiryTs: int): (bool, int, int) {
    return verdict_expiry(raw(c), expiryTs);
}

get fun expiry_window(m0: int, l0: int, m1: int, l1: int): int {
    return verdict_expiry_window(m0, l0, m1, l1);
}

get fun buy_cutoff(): int {
    return OPTION_BUY_CUTOFF;
}

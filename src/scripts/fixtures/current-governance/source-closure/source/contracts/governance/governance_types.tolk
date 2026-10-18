tolk 1.5.0

import "genesis_types"
import "../shared/jetton/jetton_sweep"
import "../shared/jetton/jetton_slots"
import "../shared/governance/policy_types"

const GOV_MAX_LOCKS = 16384
const GOV_MAX_PROPOSALS = 48
const GOV_OWED_CAP = 512
const GOV_PROPOSAL_FEE = grams("1")
const GOV_BOOTSTRAP_WINDOW = 2592000

struct GovernanceAssets { jetton: Cell<JettonLedger>; sweeps: Cell<JettonSweeps>; treasury: address? }
struct GovernanceTreasury { treasury: address }
struct GovernanceToken { merkleClaim: address; genesisTotal: uint120; supplyBase: uint120 }
struct GovernanceLock {
    amount: coins
    bucket: uint32
    commitUntil: uint32
    prevCommit: uint32
    commitChangedAt: uint32
    voteLock: uint32
    proposal: uint32
    proposeAfter: uint32
    voteMask: uint16
    voteStamp: uint32
}
struct GovernanceStake {
    totalLocked: coins
    lockCount: uint16
    deferredMax: coins
    mature: coins
    matureThrough: uint32
    buckets: map<uint32, coins>
    expired: coins
    expiredThrough: uint32
    expiring: map<uint32, coins>
    locks: map<address, GovernanceLock>
}
struct GovernanceTally { quorum: coins; partQ: coins; yes: uint122; no: uint122 }
struct (0x47564556) GovVoteEvent { id: uint32; voter: address; support: uint2; q: coins; v: uint122 }
struct GovernanceProposal {
    proposer: address
    class: uint2
    queued: bool
    slot: uint4
    start: uint32
    decidedAt: uint32
    valueTotal: coins
    descriptionHash: uint256
    tally: Cell<GovernanceTally>
    actions: cell
}
struct GovernanceSlots {
    s0: uint32; s1: uint32; s2: uint32; s3: uint32
    s4: uint32; s5: uint32; s6: uint32; s7: uint32
    s8: uint32; s9: uint32; s10: uint32; s11: uint32
    s12: uint32; s13: uint32; s14: uint32; s15: uint32
}
struct GovernanceProps {
    nextId: uint32
    live: uint8
    escrow: coins
    slots: GovernanceSlots
    proposals: map<uint32, GovernanceProposal>
}
struct GovernanceStorage {
    phase: uint8
    bootstrap: address?
    bootstrapDeadline: uint32
    salt: uint64
    handoffBucket: uint32
    assets: Cell<GovernanceAssets>
    ts: GovernanceToken?
    policy: PolicyMap
    policyCount: uint16
    stake: Cell<GovernanceStake>
    props: Cell<GovernanceProps>
}

fun governance_bucket(): int {
    val config = blockchain.configParam(19);
    if (config != null) {
        var s = config!.beginParse();
        if (s.remainingBitsCount() == 32 && s.remainingRefsCount() == 0 && s.loadInt(32) == -3) { return 600; }
    }
    return 86400;
}
fun GovernanceStorage.load(): GovernanceStorage { return GovernanceStorage.fromCell(contract.getData()); }
fun GovernanceStorage.save(self) { contract.setData(self.toCell()); }
fun GovernanceStorage.supply(self, stake: GovernanceStake): coins {
    return self.ts == null ? 0 : min(self.ts!.genesisTotal, self.ts!.supplyBase + stake.deferredMax);
}
fun GovernanceSlots.at(self, index: int): uint32 {
    return self.toCell().beginParse().getMiddleBits(index * 32, 32).preloadUint(32) as uint32;
}
fun GovernanceSlots.put(mutate self, index: int, id: uint32) {
    var result = beginCell();
    var old = self.toCell().beginParse();
    var i = 0;
    repeat (16) {
        val previous = old.loadUint(32);
        result.storeUint(i == index ? id : previous, 32);
        i += 1;
    }
    self = GovernanceSlots.fromCell(result.endCell());
}

fun GovernanceStorage.ledger(self): JettonLedger { return self.assets.load().jetton.load(); }
fun GovernanceStorage.setLedger(mutate self, ledger: JettonLedger) {
    var assets = self.assets.load(); assets.jetton = ledger.toCell(); self.assets = assets.toCell();
}

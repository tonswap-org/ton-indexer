tolk 1.5.0

import "@stdlib/exotic-cells"
import "../shared/jetton/jetton_slots"
import "../shared/jetton/jetton_sweep"
import "../shared/jetton/tep74_codec"
import "../shared/utils/error_codes"
import "@gen/op/governance"

const MC_PROTOCOL = 1
const MC_LEAF_BITS = 779

struct Campaign {
    campaignId: uint256
    root: uint256
    count: uint32
    total: uint120
    start: uint32
}

struct (0x4d434c46) MerkleLeaf {
    campaignId: uint256
    index: uint32
    recipient: address
    amount: uint120
    cliffSeconds: uint32
    vestingSeconds: uint32
    flags: uint8
}

struct (0x4d434c4d) MerkleClaim {
    queryId: uint64
    index: uint32
    proof: cell
}

struct (0x4d435250) ClaimedReport { deferred: uint120 }

struct VestGroup {
    a0: uint120
    a1: uint120
    a2: uint120
    a3: uint120
    a4: uint120
    a5: uint120
    a6: uint120
    a7: uint120
}

struct MerkleClaimAssets {
    ledger: Cell<JettonLedger>
    sweeps: Cell<JettonSweeps>
    treasury: address
}

struct MerkleClaimStorage {
    campaign: Cell<Campaign>
    governance: address
    assets: Cell<MerkleClaimAssets>
    bitmap: map<uint16, uint256>
    vesting: map<uint32, VestGroup>
    acceptedTotal: uint120
    acceptedDeferred: uint120
}

struct RemintConfig { governance: address; emissionsSplitter: address }
struct RemintStorage {
    jetton: Cell<JettonLedger>
    cfg: Cell<RemintConfig>
    rateBps: uint16
    day: uint32
    burnedToday: coins
    burnedYesterday: coins
    minted: bool
}

// This throws only on caller-funded claim/getter paths, never after token credit.
fun merkle_claim_leaf(campaign: Campaign, proof: cell, index: uint32): MerkleLeaf {
    var (s, exotic) = proof.beginParseSpecial();
    assert (exotic && s.remainingBitsCount() == 280 && s.remainingRefsCount() == 1) throw ERR_GOVERNANCE_CONFIG;
    assert (s.loadUint(8) == 3 && s.loadUint(256) == campaign.root) throw ERR_GOVERNANCE_CONFIG;
    val depth = s.loadUint(16);
    val root = s.loadRef();
    assert (root.hashOfLevel(0) == campaign.root && root.depthOfLevel(0) == depth) throw ERR_GOVERNANCE_CONFIG;
    assert (index < campaign.count) throw ERR_GOVERNANCE_CONFIG;
    val leaves = createMapFromLowLevelDict<uint32, cell>(root);
    val entry = leaves.get(index);
    assert (entry.isFound) throw ERR_GOVERNANCE_CONFIG;
    val encoded = entry.loadValue();
    var (leafBody, leafExotic) = encoded.beginParseSpecial();
    assert (!leafExotic && leafBody.remainingBitsCount() == MC_LEAF_BITS && leafBody.remainingRefsCount() == 0) throw ERR_GOVERNANCE_CONFIG;
    assert (leafBody.loadUint(32) == OP_MERKLE_LEAF) throw ERR_GOVERNANCE_CONFIG;
    val campaignId = leafBody.loadUint(256);
    val leafIndex = leafBody.loadUint(32);
    val recipient = leafBody.tryLoadStdAddress();
    assert (recipient != null) throw ERR_GOVERNANCE_CONFIG;
    val amount = leafBody.loadUint(120);
    val cliffSeconds = leafBody.loadUint(32);
    val vestingSeconds = leafBody.loadUint(32);
    val flags = leafBody.loadUint(8);
    assert (campaignId == campaign.campaignId && leafIndex == index && amount > 0 && flags <= MC_PROTOCOL) throw ERR_GOVERNANCE_CONFIG;
    return { campaignId, index, recipient: recipient!, amount, cliffSeconds, vestingSeconds, flags };
}

fun merkle_vested(amount: uint120, cliff: uint32, vesting: uint32, start: uint32, at: uint32): uint120 {
    val elapsed = at - start;
    if (elapsed < cliff) { return 0; }
    if (vesting == 0) { return amount; }
    return amount * min(elapsed - cliff, vesting) / vesting;
}

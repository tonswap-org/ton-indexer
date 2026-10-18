tolk 1.5.0

struct CreditIdentity { identities: cell; requestHash: uint256; intent: cell; wallets: cell; codeHash: uint256 }
struct ProofTransaction { hash: uint256; lt: uint64; anchor: uint256 }
struct ProofTargets { source: Cell<ProofTransaction>; target: Cell<ProofTransaction> }
struct ProofConfig { sessionNonce: uint256; credit: Cell<CreditIdentity>; targets: Cell<ProofTargets> }
struct Cursor { hash: uint256; key: uint256; bits: uint9; txLt: uint64 }
struct StagedProof { config: Cell<ProofConfig>; phase: uint3; messageHash: uint256; cursor: Cell<Cursor>; evidence: uint2 }

// Authenticate only the pristine session, never caller-supplied completed state.
fun t3_proof_initial_state(config: Cell<ProofConfig>): Cell<StagedProof> {
    val cursor: Cursor = { hash: 0, key: 0, bits: 0, txLt: 0 };
    return StagedProof { config, phase: 0, messageHash: 0, cursor: cursor.toCell(), evidence: 0 }.toCell();
}
fun t3_proof_address(config: Cell<ProofConfig>, code: cell): address {
    return AutoDeployAddress { workchain: 0, stateInit: { code, data: t3_proof_initial_state(config) } }.calculateAddress();
}

// The rare certificate carries code; recipients retain only its immutable hash.
fun t3_checked_proof_address(config: Cell<ProofConfig>, suppliedCode: cell, pinnedHash: uint256): address {
    assert (suppliedCode.hash() == pinnedHash) throw 979;
    return t3_proof_address(config,suppliedCode);
}

#pragma once

#include "auto/tl/lite_api.h"
#include "block/check-proof.h"
#include "block/mc-config.h"

namespace tonlib {

// This helper verifies commitments to an already accepted master block. Only
// LastBlock's verified sync/chain result may supply accepted_master; this is not
// a validator-chain verifier and must never be called with an RPC-reported head.
struct VerifiedAdmissionProof {
  ton::BlockIdExt accepted_master;
  ton::BlockIdExt shard;
  block::AccountState::Info account;
  std::unique_ptr<block::ConfigInfo> config;
  td::Ref<vm::Tuple> prev_blocks_info;
  ton::UnixTime master_utime{0};
  ton::LogicalTime master_lt{0};
  ton::UnixTime shard_utime{0};
  ton::LogicalTime shard_lt{0};
};

constexpr size_t admission_max_proof_bytes = 4 * 1024 * 1024;
constexpr int admission_max_proof_cells = 32768;

// Also usable immediately before releasing a result after asynchronous work.
td::Status validate_admission_proof_times(ton::UnixTime trusted_host_now, ton::UnixTime master_utime,
                                          ton::UnixTime shard_utime);

// Raw responses are retained by the actor for immutable evidence. This function
// neither consumes nor modifies their proof bytes and performs no network I/O.
td::Result<VerifiedAdmissionProof> verify_admission_proof(
    const ton::BlockIdExt& accepted_master, const block::StdAddress& address,
    const ton::lite_api::liteServer_accountState& account_response,
    const ton::lite_api::liteServer_configInfo& config_response, ton::UnixTime trusted_host_now,
    int expected_global_id);

}  // namespace tonlib

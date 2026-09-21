#pragma once

#include "tonlib/VerifiedAdmissionProof.h"

namespace ton::tonlib_api { class ton_blockIdExt; class blocks_header; class raw_fullAccountState; }
namespace tonlib_api = ton::tonlib_api;

namespace tonlib {

inline constexpr td::int64 kAdmissionGasMax = 1000000;
// Thread-safe once initialization, also called before worker readiness.
td::Status initialize_admission_vm();
// Header/account objects must come from official verified exact-block APIs.
td::Status validate_admission_readiness(const tonlib_api::ton_blockIdExt& accepted,
  const tonlib_api::blocks_header& header, const tonlib_api::raw_fullAccountState& account,
  td::Slice expected_code_hash, ton::UnixTime host_now);

struct VerifiedAdmissionVmResult {
  td::Ref<vm::Stack> stack;
  td::Ref<vm::Cell> code;
  td::Ref<vm::Cell> data;
  td::Ref<vm::Cell> context;
  td::Ref<vm::Cell> arguments;
  td::int64 gas_used;
  int exit_code;
  bool data_unchanged;
  bool actions_empty;
};

// No network, mutable contract state, latest configuration, or gas escalation.
// The proof is constructed by verify_admission_proof after LastBlock acceptance.
td::Result<VerifiedAdmissionVmResult> execute_verified_admission(
    const VerifiedAdmissionProof& proof, const block::StdAddress& address,
    td::Slice expected_code_hash, td::Slice method, td::Ref<vm::Stack> arguments);

}  // namespace tonlib

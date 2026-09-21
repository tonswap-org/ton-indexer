#include "tonlib/VerifiedAdmissionProof.h"

#include "common/global-version.h"
#include "ton/lite-tl.hpp"
#include "vm/boc.h"
#include "vm/excno.hpp"

namespace tonlib {

td::Status validate_admission_proof_times(ton::UnixTime trusted_host_now, ton::UnixTime master_utime,
                                          ton::UnixTime shard_utime) {
  if (!trusted_host_now || !master_utime || !shard_utime) {
    return td::Status::Error("admission proof has a missing authenticated clock");
  }
  for (auto value : {master_utime, shard_utime}) {
    auto age = static_cast<td::int64>(trusted_host_now) - static_cast<td::int64>(value);
    if (age > 30 || age < -3) {
      return td::Status::Error("admission proof clock is stale or in the future");
    }
  }
  if (shard_utime > master_utime) {
    return td::Status::Error("admission account shard is newer than its accepted master");
  }
  return td::Status::OK();
}

td::Result<VerifiedAdmissionProof> verify_admission_proof(
    const ton::BlockIdExt& accepted_master, const block::StdAddress& address,
    const ton::lite_api::liteServer_accountState& account_response,
    const ton::lite_api::liteServer_configInfo& config_response, ton::UnixTime trusted_host_now,
    int expected_global_id) {
  // AccountState::validate supports a wildcard reference for other callers.
  // Admission requires the full, nonzero, consensus-accepted master identity.
  if (!accepted_master.is_valid_full() || !accepted_master.is_masterchain_ext() || !accepted_master.seqno()) {
    return td::Status::Error("admission requires an exact accepted master block");
  }
  if (!account_response.id_ || !account_response.shardblk_ || !config_response.id_) {
    return td::Status::Error("admission proof response is missing a block identity");
  }
  if (ton::create_block_id(account_response.id_) != accepted_master ||
      ton::create_block_id(config_response.id_) != accepted_master) {
    return td::Status::Error("admission account and config must use the exact accepted master");
  }
  size_t bytes = 0;
  int cells = 0;
  unsigned proof_index = 0;
  const int root_counts[] = {2, 2, 1, 1, 1};
  for (const auto* value : {&account_response.shard_proof_, &account_response.proof_, &account_response.state_,
                            &config_response.state_proof_, &config_response.config_proof_}) {
    if (value->empty() || value->size() > admission_max_proof_bytes - bytes) {
      return td::Status::Error("admission proof is empty or exceeds its bounded input size");
    }
    bytes += value->size();
    // Use the maintained BOC header parser before allocating/deserializing its
    // cell graph. Actual cell, CRC and Merkle validation still follows below.
    vm::BagOfCells::Info header;
    auto declared_size = header.parse_serialized_header(value->as_slice());
    if (declared_size <= 0 || static_cast<size_t>(declared_size) != value->size() || !header.valid ||
        header.root_count != root_counts[proof_index++] || header.cell_count <= 0 ||
        header.cell_count > admission_max_proof_cells - cells) {
      return td::Status::Error("admission proof BOC has invalid bounds or root count");
    }
    cells += header.cell_count;
  }
  try {
    block::AccountState account;
    account.blk = accepted_master;
    account.shard_blk = ton::create_block_id(account_response.shardblk_);
    account.shard_proof = account_response.shard_proof_.clone();
    account.proof = account_response.proof_.clone();
    account.state = account_response.state_.clone();
    TRY_RESULT(info, account.validate(accepted_master, address));
    if (info.root.is_null()) {
      return td::Status::Error("admission account is uninitialized");
    }
    TRY_RESULT(state, block::check_extract_state_proof(accepted_master, config_response.state_proof_.as_slice(),
                                                        config_response.config_proof_.as_slice()));
    TRY_RESULT(config, block::ConfigInfo::extract_config(
                           std::move(state), accepted_master,
                           block::ConfigInfo::needLibraries | block::ConfigInfo::needPrevBlocks |
                               block::ConfigInfo::needCapabilities));
    if (config->get_global_blockchain_id() != expected_global_id) {
      return td::Status::Error("admission configuration belongs to another network");
    }
    if (config->get_global_version() < 4 || config->get_global_version() > ton::SUPPORTED_VERSION) {
      return td::Status::Error("admission configuration has an unsupported VM version");
    }
    TRY_RESULT(prev_blocks, config->get_prev_blocks_info());
    if (prev_blocks.is_null()) {
      return td::Status::Error("admission configuration is missing previous block context");
    }
    TRY_STATUS(validate_admission_proof_times(trusted_host_now, config->utime, info.gen_utime));
    VerifiedAdmissionProof result;
    result.accepted_master = accepted_master;
    result.shard = account.shard_blk;
    result.master_utime = config->utime;
    result.master_lt = config->lt;
    result.shard_utime = info.gen_utime;
    result.shard_lt = info.gen_lt;
    result.account = std::move(info);
    result.config = std::move(config);
    result.prev_blocks_info = std::move(prev_blocks);
    return std::move(result);
  } catch (vm::VmError& error) {
    return td::Status::Error(PSLICE() << "admission proof VM error: " << error.get_msg());
  } catch (vm::VmVirtError& error) {
    return td::Status::Error(PSLICE() << "admission proof virtualization error: " << error.get_msg());
  } catch (const std::exception& error) {
    return td::Status::Error(PSLICE() << "admission proof decode error: " << error.what());
  }
}

}  // namespace tonlib

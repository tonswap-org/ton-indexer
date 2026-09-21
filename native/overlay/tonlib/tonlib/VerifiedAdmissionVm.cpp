#include "tonlib/VerifiedAdmissionVm.h"

#include "block/block-auto.h"
#include "block/block-parse.h"
#include "block/transaction.h"
#include "smc-envelope/SmartContract.h"
#include "td/utils/Random.h"
#include "vm/vm.h"
#include <mutex>
#include "auto/tl/tonlib_api.h"

namespace tonlib {
namespace {

td::Result<td::Ref<vm::Tuple>> make_context(const VerifiedAdmissionProof& proof,
                                          const block::gen::Account::Record_account& account,
                                          const block::CurrencyCollection& balance, td::Ref<vm::Cell> code,
                                          td::RefInt256 due_payment) {
  // This is the maintained LiteServer prepare_vm_c7 construction at upstream
  // 3d478cbde854be03a18ab2a59f8fc3c565cf7d14. Unlike SmartContract's convenience
  // defaults, its clock/LT, due payment, code, libraries and config are proven.
  const auto& config = proof.config;
  td::Bits256 seed;
  td::Random::secure_bytes(seed.as_slice());
  td::RefInt256 random{true};
  if (!random.unique_write().import_bits(seed.cbits(), 256, false)) {
    return td::Status::Error("ADMISSION_CONTEXT: random seed import failed");
  }
  std::vector<vm::StackEntry> tuple = {
      td::make_refint(0x076ef1ea), td::make_refint(0), td::make_refint(0),
      td::make_refint(proof.shard_utime), td::make_refint(proof.shard_lt),
      td::make_refint(proof.shard_lt), std::move(random), balance.as_vm_tuple(),
      td::make_ref<vm::CellSlice>(account.addr->clone()), config->get_root_cell()};
  const auto version = config->get_global_version();
  if (version >= 4) {
    tuple.push_back(vm::StackEntry::maybe(code));
    tuple.push_back(block::CurrencyCollection::zero().as_vm_tuple());
    tuple.push_back(td::zero_refint());
    if (proof.prev_blocks_info.is_null()) {
      return td::Status::Error("ADMISSION_CONTEXT: missing authenticated previous blocks");
    }
    tuple.push_back(proof.prev_blocks_info);
  }
  if (version >= 6) {
    tuple.push_back(vm::StackEntry::maybe(config->get_unpacked_config_tuple(proof.shard_utime)));
    tuple.push_back(std::move(due_payment));
    auto precompiled = config->get_precompiled_contracts_config().get_contract(code->get_hash().bits());
    tuple.push_back(precompiled ? td::make_refint(precompiled.value().gas_usage) : vm::StackEntry());
  }
  if (version >= 11) {
    tuple.push_back(block::transaction::Transaction::prepare_in_msg_params_tuple(nullptr, {}, {}));
  }
  return vm::make_tuple_ref(td::make_cnt_ref<std::vector<vm::StackEntry>>(std::move(tuple)));
}

td::Result<td::Ref<vm::Cell>> serialize_stack(const vm::Stack& stack) {
  vm::CellBuilder builder;
  if (!stack.serialize(builder)) {
    return td::Status::Error("ADMISSION_INPUT: stack serialization failed");
  }
  return builder.finalize();
}

}  // namespace

td::Status initialize_admission_vm() {
  static std::once_flag initialized;
  static td::Status status;
  std::call_once(initialized, [] {
    status = vm::init_vm(false);
    if (status.is_ok()) vm::DictionaryBase::get_empty_dictionary();
  });
  return status.clone();
}

td::Status validate_admission_readiness(const tonlib_api::ton_blockIdExt& accepted,
  const tonlib_api::blocks_header& header, const tonlib_api::raw_fullAccountState& account,
  td::Slice expected_code_hash, ton::UnixTime host_now) {
  auto same = [&](const tonlib_api::ton_blockIdExt* id) {
    return id && id->workchain_ == accepted.workchain_ && id->shard_ == accepted.shard_ &&
      id->seqno_ == accepted.seqno_ && id->root_hash_ == accepted.root_hash_ && id->file_hash_ == accepted.file_hash_;
  };
  if (accepted.workchain_ != -1 || accepted.shard_ != static_cast<td::int64>(ton::shardIdAll) ||
      accepted.seqno_ <= 0 || accepted.root_hash_.size() != 32 || accepted.file_hash_.size() != 32 ||
      accepted.root_hash_.find_first_not_of('\0') == std::string::npos ||
      accepted.file_hash_.find_first_not_of('\0') == std::string::npos ||
      !same(header.id_.get()) || !same(account.block_id_.get()) || header.global_id_ != -3 ||
      header.gen_utime_ <= 0 || header.gen_utime_ > 0xffffffffLL ||
      account.sync_utime_ <= 0 || account.sync_utime_ > 0xffffffffLL ||
      !account.frozen_hash_.empty() || account.code_.empty() || account.data_.empty() || expected_code_hash.size() != 32)
    return td::Status::Error("ADMISSION_READINESS: exact authenticated head/account identity required");
  vm::BagOfCells::Info info;const auto length=info.parse_serialized_header(account.code_);
  if (account.code_.size() > admission_max_proof_bytes || length <= 0 ||
      static_cast<size_t>(length) != account.code_.size() || !info.valid || info.root_count != 1 ||
      info.cell_count <= 0 || info.cell_count > admission_max_proof_cells)
    return td::Status::Error("ADMISSION_READINESS: qualified code BOC exceeds bounds");
  TRY_RESULT(code,vm::std_boc_deserialize(account.code_));
  if (code.is_null() || code->get_hash().as_slice() != expected_code_hash)
    return td::Status::Error("ADMISSION_READINESS: qualified engine code differs");
  return validate_admission_proof_times(host_now,static_cast<ton::UnixTime>(header.gen_utime_),
                                      static_cast<ton::UnixTime>(account.sync_utime_));
}

td::Result<VerifiedAdmissionVmResult> execute_verified_admission(
    const VerifiedAdmissionProof& proof, const block::StdAddress& address,
    td::Slice expected_code_hash, td::Slice method, td::Ref<vm::Stack> arguments) {
  const char* phase = "input";
  auto execute = [&]() -> td::Result<VerifiedAdmissionVmResult> {
  if (expected_code_hash.size() != 32 || arguments.is_null() || proof.config == nullptr ||
      proof.account.root.is_null()) {
    return td::Status::Error("ADMISSION_INPUT: missing qualified identity, arguments or proof");
  }
  const bool open = method == "open_order_preflight";
  if ((!open && method != "close_order_preflight") || arguments->depth() != (open ? 6 : 5)) {
    return td::Status::Error("ADMISSION_INPUT: exact admission getter and argument count required");
  }
  if (address.workchain != 0) {
    return td::Status::Error("ADMISSION_IDENTITY: basechain engine required");
  }
  const auto input = arguments->extract_contents();
  const auto payload_index = open ? 2u : 1u;
  const auto payload = input[payload_index].as_cell();
  const auto value = input[payload_index + 1].as_int();
  const auto evaluated_at = input[payload_index + 3].as_int();
  if (input[0].as_slice().is_null() || payload.is_null() ||
      input[payload_index + 2].as_cell().is_null() || value.is_null() || evaluated_at.is_null() ||
      !value->unsigned_fits_bits(120) || value->sgn() <= 0 || !evaluated_at->unsigned_fits_bits(32) ||
      evaluated_at->to_long() > proof.shard_utime ||
      static_cast<td::int64>(proof.shard_utime) - evaluated_at->to_long() > 30 ||
      (open && (input[1].as_int().is_null() || !input[1].as_int()->unsigned_fits_bits(120) ||
                input[1].as_int()->sgn() <= 0))) {
    return td::Status::Error("ADMISSION_INPUT: invalid payload, value or safety timestamp");
  }
  if (vm::load_cell_slice(payload).prefetch_ulong(32) != (open ? 0x4f50454e : 0x434c4f53)) {
    return td::Status::Error("ADMISSION_INPUT: payload opcode differs from the selected getter");
  }
  phase = "account";
  block::gen::Account::Record_account account;
  block::gen::AccountStorage::Record storage;
  block::gen::StorageInfo::Record storage_info;
  block::gen::StateInit::Record state_init;
  block::CurrencyCollection balance;
  if (!(tlb::unpack_cell(proof.account.root, account) && tlb::csr_unpack(account.storage, storage) &&
        balance.validate_unpack(storage.balance) && storage.state->prefetch_ulong(1) == 1 &&
        storage.state.write().advance(1) && tlb::csr_unpack(storage.state, state_init) &&
        tlb::csr_unpack(account.storage_stat, storage_info))) {
    return td::Status::Error("ADMISSION_ACCOUNT: active account required");
  }
  auto code = state_init.code->prefetch_ref();
  auto data = state_init.data->prefetch_ref();
  auto account_libraries = state_init.library->prefetch_ref();
  if (code.is_null() || data.is_null() || code->get_hash().as_slice() != expected_code_hash) {
    return td::Status::Error("ADMISSION_IDENTITY: qualified code hash mismatch");
  }
  td::RefInt256 due_payment = td::zero_refint();
  if (storage_info.due_payment.write().fetch_long(1)) {
    due_payment = block::tlb::t_Grams.as_integer(storage_info.due_payment);
    if (due_payment.is_null()) {
      return td::Status::Error("ADMISSION_ACCOUNT: invalid due payment");
    }
  }
  phase = "c7";
  TRY_RESULT(c7, make_context(proof, account, balance, code, due_payment));
  phase = "context-serialization";
  vm::Stack c7_stack;
  c7_stack.push_tuple(c7);
  TRY_RESULT(context, serialize_stack(c7_stack));
  TRY_RESULT(arguments_cell, serialize_stack(*arguments));
  phase = "libraries";
  const auto version = proof.config->get_global_version();
  std::vector<td::Ref<vm::Cell>> libraries;
  if (proof.config->get_libraries_root().not_null()) {
    libraries.push_back(proof.config->get_libraries_root());
  }
  if (account_libraries.not_null() && version < 15) {
    libraries.push_back(account_libraries);
  }
  phase = "method";
  ton::SmartContract::Args method_args;
  method_args.set_method_id(method);
  TRY_RESULT(method_id, method_args.get_method_id());
  arguments.write().push_smallint(method_id);
  // Both limits are fixed. ACCEPT cannot raise this VM above kAdmissionGasMax.
  phase = "vm-initialization";
  TRY_STATUS(initialize_admission_vm());
  phase = "vm-construction";
  vm::VmState vm{code, version, std::move(arguments), vm::GasLimits{kAdmissionGasMax, kAdmissionGasMax},
                 1, data, vm::VmLog::Null(), std::move(libraries)};
  vm.set_c7(std::move(c7));
  phase = "execution";
  const int exit_code = ~vm.run();
  phase = "effects";
  const auto gas = vm.get_gas_limits();
  const auto final_data = vm.get_c4();
  const auto final_actions = vm.get_d(5);
  const bool data_unchanged = final_data.not_null() && final_data->get_hash() == data->get_hash();
  const bool actions_empty = final_actions.not_null() && vm::load_cell_slice(final_actions).empty_ext();
  if (exit_code == 0 && (!data_unchanged || !actions_empty)) {
    return td::Status::Error("ADMISSION_EFFECT: getter modified storage or emitted actions");
  }
  phase = "result";
  if (exit_code == 0) {
    const auto output = vm.get_stack_ref()->extract_contents();
    if (output.size() != 5) {
      return td::Status::Error("ADMISSION_RESULT: exact five-field admission tuple required");
    }
    for (const auto& field : output) {
      if (field.as_int().is_null()) {
        return td::Status::Error("ADMISSION_RESULT: non-integer result field");
      }
    }
    td::RefInt256 payload_hash{true};
    payload_hash.unique_write().import_bits(payload->get_hash().bits(), 256, false);
    if ((td::cmp(output[0].as_int(), td::make_refint(-1)) != 0 &&
         td::cmp(output[0].as_int(), td::make_refint(0)) != 0) ||
        td::cmp(output[1].as_int(), td::make_refint(proof.shard_utime)) != 0 ||
        td::cmp(output[2].as_int(), payload_hash) != 0) {
      return td::Status::Error("ADMISSION_RESULT: result does not bind payload and authenticated clock");
    }
  }
  return VerifiedAdmissionVmResult{vm.get_stack_ref(), std::move(code), std::move(data), std::move(context),
                                    std::move(arguments_cell), gas.gas_consumed(), exit_code,
                                    data_unchanged, actions_empty};
  };
  auto result = TRY_VM(execute());
  if (result.is_error() && result.error().message().str().rfind("ADMISSION_", 0) != 0)
    return result.move_as_error_prefix(PSLICE() << "ADMISSION_CONTEXT: " << phase << ": ");
  return result;
}

}  // namespace tonlib

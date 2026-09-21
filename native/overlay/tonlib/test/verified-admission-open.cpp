#include "tonlib/VerifiedAdmissionVm.h"
#include "td/utils/tests.h"
#include "td/utils/PathView.h"
#include "td/utils/base64.h"
#include "td/utils/crypto.h"
#include "td/utils/filesystem.h"
#include "td/utils/misc.h"
#include "ton/lite-tl.hpp"
#include "smc-envelope/SmartContract.h"
#include "vm/vm.h"

namespace {
td::Bits256 hash(td::Slice value) {
  auto bytes = td::base64_decode(value).move_as_ok();
  return td::Bits256{td::Slice(bytes).ubegin()};
}
ton::BlockIdExt master() {
  return {-1, ton::shardIdAll, 84779529,
          hash("j1v6K4MRd2zbJgBZhZYofmlpiIav8B9x2CuuYdve3dU="),
          hash("DsEg9tlqSb5MRtu/AjTJJp9CdF2I1L9923x8mA4Ceo4=")};
}
ton::BlockIdExt shard() {
  return {0, ton::shardIdAll, 90012040,
          hash("iE7RKNvVHMHR7xHM4cgDdFyU+Kf5O3VPQ3v+s4OeOmc="),
          hash("VLpunZbfx8+p4yhPLpVHAHI8RHcBvsOgLNlxqRjBbVU=")};
}
block::StdAddress engine() {
  return block::StdAddress::parse("0:0816eb1798823310dffa9888ea1ff7f9168fdedbbc5b6f1f003720a6dcd169b1").move_as_ok();
}
auto code_hash() {
  return td::hex_decode("ba7b83da91ae84064521a916bf6125b343ace2182dbace9f2548dfda367171db").move_as_ok();
}
td::BufferSlice fixture(td::Slice name, td::Slice sha) {
  auto bytes = td::read_file(td::PathView(__FILE__).parent_dir().str() +
                            "fixtures/admission-execution/" + name.str() + ".boc").move_as_ok();
  ASSERT_EQ(td::sha256(bytes.as_slice()), td::hex_decode(sha).move_as_ok());
  return bytes;
}
tonlib::VerifiedAdmissionProof proof() {
  // Existing immutable capture09 proof; no rewritten engine data or new trust
  // anchor. Its historical clock is explicit and is never a live acceptance.
  auto account = ton::create_tl_object<ton::lite_api::liteServer_accountState>(
      ton::create_tl_lite_block_id(master()), ton::create_tl_lite_block_id(shard()),
      fixture("shard_proof", "fdce1c172c9f26bd7224379a3fc51aca1ca24fe431f86373ec051135531a54ec"),
      fixture("account_proof", "c51ed44629048759a14f321073a3b97ef02a0deb46dce9ad31a7fab95e321ddd"),
      fixture("account_state", "f093fd43fc1e74a112fddc13c5745246ad782cae714bff5a6d6216840a1c03d6"));
  auto config = ton::create_tl_object<ton::lite_api::liteServer_configInfo>(
      642, ton::create_tl_lite_block_id(master()),
      fixture("config_state_proof", "4ae59de3ab549306605c3b4c58682578380b4b47229ab64cb7cb2694f52cce51"),
      fixture("config_proof", "dabdae743b840814fd6a604e90cfabcc8647c1b8da3e9eb27d5a35da9beafb4b"));
  return tonlib::verify_admission_proof(master(), engine(), *account, *config, 1789399530, -3).move_as_ok();
}
td::Ref<vm::Cell> cell(td::Slice base64) {
  return vm::std_boc_deserialize(td::base64_decode(base64).move_as_ok()).move_as_ok();
}
td::Ref<vm::Stack> close_arguments() {
  auto root = vm::std_boc_deserialize(
      fixture("arguments", "599282f5a2a4d1277927290d7cb71dbfc403dba8280037677e7f4672022da948")).move_as_ok();
  auto slice = vm::load_cell_slice(root);
  td::Ref<vm::Stack> result{true};
  ASSERT_TRUE(result.write().deserialize(slice));
  ASSERT_EQ(result->depth(), 5);
  return result;
}
td::Ref<vm::Stack> open_arguments(bool fresh_owner = true, td::int64 amount = 1) {
  const auto captured = close_arguments()->extract_contents();
  // Exact deployed OpenPosition layout (buildOpenPositionBody): opcode, query
  // uint64, market uint32, signed size128, margin/limit coins, leverage uint32,
  // optional referrer. Query1789399530001, market1, size/margin1e9,
  // limit1.01e9, leverage1000 as in the original approved wallet request, no
  // referrer. This is a local unsigned request.
  auto payload = cell("te6cckEBAQEAMAAAW09QRU4AAAGgoIX6EQAAAAEAAAAAAAAAAAAAAAA7msoAQ7msoAQ8M2CAAAAD6CCrDoXj");
  ASSERT_EQ(payload->get_hash().as_slice(),
            td::hex_decode("5acf02d5ac3229eb161f95a840627f333f6b58c40dc1dc7d0ca00bc06cea4f97").move_as_ok());
  td::Ref<vm::Stack> result{true};
  result.write().push_cellslice(fresh_owner ? vm::load_cell_slice_ref(
      cell("te6cckEBAQEAJAAAQ4ACIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIjBaejMR")) : captured[0].as_slice());
  // The default positive amount below margin deliberately exercises a valid
  // denial. The funded case supplies the original approved margin+fee amount;
  // neither case changes authenticated trader collateral or engine state.
  result.write().push_smallint(amount);  // transferred T3 amount, margin is 1e9
  result.write().push_cell(std::move(payload));
  result.write().push_smallint(1100000000);  // native forward value
  result.write().push_cell(captured[3].as_cell());  // unchanged oracle safety
  result.write().push_int(captured[4].as_int());  // historical evaluatedAt
  ASSERT_EQ(result->depth(), 6);
  return result;
}

void diagnose_denial(const tonlib::VerifiedAdmissionProof& proof,
                    const tonlib::VerifiedAdmissionVmResult& result) {
  // Failure-only offline diagnostics use the exact verified code/data and
  // serialized c7 produced by admission. They do not alter the state fixture or
  // introduce any additional callable getter in the production worker.
  for (auto method : {"engine_config", "market_state"}) {
    auto slice = vm::load_cell_slice(result.context);
    vm::Stack context;
    ASSERT_TRUE(context.deserialize(slice));
    td::Ref<vm::Stack> args{true};
    if (td::Slice(method) == "market_state") args.write().push_smallint(1);
    ton::SmartContract::Args selector;
    selector.set_method_id(td::Slice(method));
    args.write().push_smallint(selector.get_method_id().move_as_ok());
    std::vector<td::Ref<vm::Cell>> libraries;
    if (proof.config->get_libraries_root().not_null()) libraries.push_back(proof.config->get_libraries_root());
    vm::VmState machine{result.code, proof.config->get_global_version(), args,
                        vm::GasLimits{tonlib::kAdmissionGasMax, tonlib::kAdmissionGasMax},
                        1, result.data, vm::VmLog::Null(), std::move(libraries), context.pop_tuple()};
    ASSERT_EQ(~machine.run(), 0);
    ASSERT_EQ(machine.get_c4()->get_hash(), result.data->get_hash());
    const auto fields = machine.get_stack_ref()->extract_contents();
    for (size_t index = 0; index < fields.size(); ++index) {
      LOG(INFO) << "Funded OPEN failure diagnostic " << method << "[" << index << "]=" << fields[index].to_string();
    }
  }
}
}

TEST(VerifiedAdmissionOpen, AuthenticatedSixArgumentDenial) {
  auto state = proof();
  for (bool fresh_owner : {true, false}) {
    auto args = open_arguments(fresh_owner);
    const auto payload_hash = args->extract_contents()[2].as_cell()->get_hash();
    auto result = tonlib::execute_verified_admission(
        state, engine(), code_hash(), "open_order_preflight", args).move_as_ok();
    ASSERT_EQ(result.exit_code, 0);
    ASSERT_EQ(result.stack->depth(), 5);
    const auto output = result.stack->extract_contents();
    ASSERT_EQ(output[0].as_int()->to_long(), 0);
    ASSERT_EQ(output[1].as_int()->to_long(), 1789399530LL);
    td::RefInt256 expected_hash{true};
    ASSERT_TRUE(expected_hash.unique_write().import_bits(payload_hash.bits(), 256, false));
    ASSERT_EQ(td::cmp(output[2].as_int(), expected_hash), 0);
    ASSERT_EQ(output[3].as_int()->to_long(), 1000000000LL);
    ASSERT_EQ(output[4].as_int()->to_long(), 1789399526LL);
    ASSERT_TRUE(result.data_unchanged);
    ASSERT_TRUE(result.actions_empty);
    ASSERT_TRUE(result.gas_used > 0 && result.gas_used < tonlib::kAdmissionGasMax);
    LOG(INFO) << "Authenticated retained OPEN fresh_owner=" << fresh_owner
              << " accepted=" << output[0].as_int()->to_long() << " gas=" << result.gas_used;
  }
}

TEST(VerifiedAdmissionOpen, AuthenticatedFundedOpen) {
  auto state = proof();
  // Exact original approved amount: margin1e9 plus the qualified opening fee
  // allowance3030000. Only the caller/request is constructed; engine code,
  // data, account/config proofs and oracle safety are the unchanged capture.
  auto args = open_arguments(true, 1003030000);
  const auto payload_hash = args->extract_contents()[2].as_cell()->get_hash();
  auto result = tonlib::execute_verified_admission(
      state, engine(), code_hash(), "open_order_preflight", args).move_as_ok();
  ASSERT_EQ(result.exit_code, 0);
  ASSERT_EQ(result.stack->depth(), 5);
  const auto output = result.stack->extract_contents();
  LOG(INFO) << "Authenticated funded OPEN accepted=" << output[0].as_int()->to_long()
            << " gas=" << result.gas_used;
  if (output[0].as_int()->to_long() != -1) diagnose_denial(state, result);
  ASSERT_EQ(output[0].as_int()->to_long(), -1);
  ASSERT_EQ(output[1].as_int()->to_long(), 1789399530LL);
  td::RefInt256 expected_hash{true};
  ASSERT_TRUE(expected_hash.unique_write().import_bits(payload_hash.bits(), 256, false));
  ASSERT_EQ(td::cmp(output[2].as_int(), expected_hash), 0);
  ASSERT_EQ(output[3].as_int()->to_long(), 1000000000LL);
  ASSERT_EQ(output[4].as_int()->to_long(), 1789399526LL);
  ASSERT_TRUE(result.data_unchanged);
  ASSERT_TRUE(result.actions_empty);
  ASSERT_TRUE(result.gas_used > 0 && result.gas_used < tonlib::kAdmissionGasMax);
}

TEST(VerifiedAdmissionOpen, ExactInputBoundsBeforeExecution) {
  auto state = proof();
  auto wrong_opcode = open_arguments();
  wrong_opcode.write().at(3) = vm::StackEntry(close_arguments()->extract_contents()[1].as_cell());
  tonlib::execute_verified_admission(state, engine(), code_hash(), "open_order_preflight", wrong_opcode).ensure_error();
  for (auto amount : {td::make_refint(0), td::make_refint(-1), td::make_refint(1) << 120}) {
    auto args = open_arguments();
    args.write().at(4) = vm::StackEntry(amount);
    tonlib::execute_verified_admission(state, engine(), code_hash(), "open_order_preflight", args).ensure_error();
  }
  auto wrong_type = open_arguments();
  wrong_type.write().at(4) = vm::StackEntry(vm::CellBuilder{}.finalize());
  tonlib::execute_verified_admission(state, engine(), code_hash(), "open_order_preflight", wrong_type).ensure_error();
  auto wrong_count = open_arguments();
  wrong_count.write().pop();
  tonlib::execute_verified_admission(state, engine(), code_hash(), "open_order_preflight", wrong_count).ensure_error();
  tonlib::execute_verified_admission(state, engine(), code_hash(), "close_order_preflight", open_arguments()).ensure_error();
}

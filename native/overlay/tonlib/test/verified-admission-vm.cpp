#include "tonlib/VerifiedAdmissionVm.h"
#include "td/utils/tests.h"
#include "vm/vm.h"
#include "td/utils/PathView.h"
#include "td/utils/base64.h"
#include "td/utils/crypto.h"
#include "td/utils/filesystem.h"
#include "td/utils/misc.h"
#include "ton/lite-tl.hpp"
#include "smc-envelope/SmartContract.h"
#include "auto/tl/tonlib_api.h"

namespace {
td::Bits256 hash(td::Slice base64) { auto b=td::base64_decode(base64).move_as_ok(); return td::Bits256{td::Slice(b).ubegin()}; }
ton::BlockIdExt master() { return {-1,ton::shardIdAll,84779529,hash("j1v6K4MRd2zbJgBZhZYofmlpiIav8B9x2CuuYdve3dU="),hash("DsEg9tlqSb5MRtu/AjTJJp9CdF2I1L9923x8mA4Ceo4=")}; }
ton::BlockIdExt shard() { return {0,ton::shardIdAll,90012040,hash("iE7RKNvVHMHR7xHM4cgDdFyU+Kf5O3VPQ3v+s4OeOmc="),hash("VLpunZbfx8+p4yhPLpVHAHI8RHcBvsOgLNlxqRjBbVU=")}; }
block::StdAddress address() { return block::StdAddress::parse("0:0816eb1798823310dffa9888ea1ff7f9168fdedbbc5b6f1f003720a6dcd169b1").move_as_ok(); }
td::BufferSlice fixture(td::Slice name, td::Slice sha) {
  auto b=td::read_file(td::PathView(__FILE__).parent_dir().str()+"fixtures/admission-execution/"+name.str()+".boc").move_as_ok();
  ASSERT_EQ(td::sha256(b.as_slice()),td::hex_decode(sha).move_as_ok()); return b;
}
auto account_response() { return ton::create_tl_object<ton::lite_api::liteServer_accountState>(ton::create_tl_lite_block_id(master()),ton::create_tl_lite_block_id(shard()),
  fixture("shard_proof","fdce1c172c9f26bd7224379a3fc51aca1ca24fe431f86373ec051135531a54ec"),fixture("account_proof","c51ed44629048759a14f321073a3b97ef02a0deb46dce9ad31a7fab95e321ddd"),fixture("account_state","f093fd43fc1e74a112fddc13c5745246ad782cae714bff5a6d6216840a1c03d6")); }
auto config_response() { return ton::create_tl_object<ton::lite_api::liteServer_configInfo>(642,ton::create_tl_lite_block_id(master()),
  fixture("config_state_proof","4ae59de3ab549306605c3b4c58682578380b4b47229ab64cb7cb2694f52cce51"),fixture("config_proof","dabdae743b840814fd6a604e90cfabcc8647c1b8da3e9eb27d5a35da9beafb4b")); }
tonlib::VerifiedAdmissionProof proof() { auto a=account_response();auto c=config_response();return tonlib::verify_admission_proof(master(),address(),*a,*c,1789399530,-3).move_as_ok(); }
td::Ref<vm::Stack> arguments() {
  auto cell=vm::std_boc_deserialize(fixture("arguments","599282f5a2a4d1277927290d7cb71dbfc403dba8280037677e7f4672022da948")).move_as_ok();
  auto slice=vm::load_cell_slice(cell);td::Ref<vm::Stack> result{true};ASSERT_TRUE(result.write().deserialize(slice));ASSERT_EQ(result->depth(),5);return result;
}
auto code_hash() { return td::hex_decode("ba7b83da91ae84064521a916bf6125b343ace2182dbace9f2548dfda367171db").move_as_ok(); }
}

TEST(VerifiedAdmissionVm, WorkerInitializationExecutesRealOpcodes) {
  tonlib::initialize_admission_vm().ensure();
  // PUSHINT 1; PUSHINT 2; ADD. No SmartContract helper implicitly initializes
  // the opcode dispatch table for this regression.
  auto code = vm::CellBuilder{}.store_long(0x7172a0, 24).finalize();
  vm::VmState machine{code, 15, td::Ref<vm::Stack>{true}, vm::GasLimits{1000,1000},
                      1, vm::CellBuilder{}.finalize()};
  ASSERT_EQ(~machine.run(), 0);
  ASSERT_EQ(machine.get_stack_ref()->depth(), 1);
  ASSERT_EQ(machine.get_stack_ref()->fetch(0).as_int()->to_long(), 3);
  ASSERT_TRUE(machine.get_gas_limits().gas_consumed() > 0);
}

TEST(VerifiedAdmissionVm, AcceptCannotRaiseHardGasMaximum) {
  tonlib::initialize_admission_vm().ensure();
  // ACCEPT; PUSHINT 1; PUSHINT 2; ADD. The low initial-limit control succeeds
  // only when gas_max is higher. Equal initial/max limits must exhaust.
  auto code = vm::CellBuilder{}.store_long(0xf8007172a0, 40).finalize();
  for (td::int64 maximum : {60, 1000}) {
    vm::VmState machine{code, 15, td::Ref<vm::Stack>{true}, vm::GasLimits{60, maximum},
                        1, vm::CellBuilder{}.finalize()};
    const auto exit = ~machine.run();
    if (maximum == 60) {
      ASSERT_EQ(exit, -14);
      ASSERT_TRUE(machine.get_gas_limits().gas_consumed() > 60);
    } else {
      ASSERT_EQ(exit, 0);
      ASSERT_EQ(machine.get_stack_ref()->fetch(0).as_int()->to_long(), 3);
    }
  }
}

TEST(VerifiedAdmissionVm, CapturedCompleteContextAcceptedAndDenied) {
  auto p=proof();
  ASSERT_EQ(p.master_utime,1789399530U);ASSERT_EQ(p.shard_utime,1789399530U);
  ASSERT_EQ(p.shard_lt,96548839000001ULL);ASSERT_EQ(p.config->get_global_version(),15);
  auto accepted=tonlib::execute_verified_admission(p,address(),code_hash(),"close_order_preflight",arguments()).move_as_ok();
  ASSERT_EQ(accepted.exit_code,0);ASSERT_EQ(accepted.gas_used,507666);
  ASSERT_TRUE(accepted.data_unchanged);ASSERT_TRUE(accepted.actions_empty);
  ASSERT_EQ(accepted.stack->fetch(4).as_int()->to_long(),-1);
  // Exact native funding boundary at this immutable authenticated state.
  for (td::int64 value : {1100000000LL,1139999999LL,1140000000LL}) {
    auto args=arguments();args.write().at(2)=vm::StackEntry(td::make_refint(value));
    auto result=tonlib::execute_verified_admission(p,address(),code_hash(),"close_order_preflight",args).move_as_ok();
    ASSERT_EQ(result.exit_code,0);ASSERT_EQ(result.stack->fetch(4).as_int()->to_long(),value==1140000000LL?-1:0);
    ASSERT_TRUE(result.data_unchanged);ASSERT_TRUE(result.actions_empty);
    LOG(INFO)<<"Authenticated retained CLOSE value="<<value<<" gas="<<result.gas_used;
  }
}

TEST(VerifiedAdmissionVm, CapturedExactContextHardGasReplay) {
  auto p=proof();
  auto result=tonlib::execute_verified_admission(p,address(),code_hash(),"close_order_preflight",arguments()).move_as_ok();
  auto recorded=vm::std_boc_deserialize(fixture("context","f4df251a11088e7ec8cd93ae01ea942ea4f822cff69538731e481dc4d7d9d860")).move_as_ok();
  auto slice=vm::load_cell_slice(recorded);vm::Stack context;ASSERT_TRUE(context.deserialize(slice));
  auto c7=context.pop_tuple();auto info=(*c7)[0].as_tuple();
  ASSERT_EQ((*info)[3].as_int()->to_long(),1789399530LL);
  ASSERT_EQ((*info)[4].as_int()->to_long(),96548839000001LL);
  ASSERT_EQ((*info)[5].as_int()->to_long(),96548839000001LL);
  ASSERT_EQ((*info)[10].as_cell()->get_hash(),result.code->get_hash());
  ASSERT_EQ((*info)[9].as_cell()->get_hash(),p.config->get_root_cell()->get_hash());
  for (td::int64 cap : {300000,1000000}) {
    auto args=arguments();ton::SmartContract::Args selector;selector.set_method_id("close_order_preflight");args.write().push_smallint(selector.get_method_id().move_as_ok());
    std::vector<td::Ref<vm::Cell>> libraries;if(p.config->get_libraries_root().not_null())libraries.push_back(p.config->get_libraries_root());
    vm::VmState machine{result.code,15,args,vm::GasLimits{cap,cap},1,result.data,vm::VmLog::Null(),std::move(libraries),c7};
    const int exit=~machine.run();ASSERT_EQ(exit,cap==300000?-14:0);
    ASSERT_EQ(machine.get_gas_limits().gas_consumed(),cap==300000?300005:507666);
    if(exit==0)ASSERT_EQ(machine.get_c4()->get_hash(),result.data->get_hash());
  }
}

TEST(VerifiedAdmissionVm, CapturedProofContextAndArgumentMutations) {
  auto p=proof();auto wrong=code_hash();wrong[0]^=1;
  tonlib::execute_verified_admission(p,address(),wrong,"close_order_preflight",arguments()).ensure_error();
  tonlib::execute_verified_admission(p,address(),code_hash(),"engine_config",arguments()).ensure_error();
  auto stale=arguments();stale.write().at(0)=vm::StackEntry(td::make_refint(1789399499));
  tonlib::execute_verified_admission(p,address(),code_hash(),"close_order_preflight",stale).ensure_error();
  auto future=arguments();future.write().at(0)=vm::StackEntry(td::make_refint(1789399531));
  tonlib::execute_verified_admission(p,address(),code_hash(),"close_order_preflight",future).ensure_error();
  auto a=account_response();auto c=config_response();
  tonlib::verify_admission_proof(master(),address(),*a,*c,1789399561,-3).ensure_error();
  tonlib::verify_admission_proof(master(),address(),*a,*c,1789399530,-239).ensure_error();
  c->config_proof_.as_slice()[c->config_proof_.size()/2]^=1;
  tonlib::verify_admission_proof(master(),address(),*a,*c,1789399530,-3).ensure_error();
}

TEST(VerifiedAdmissionVm, ReadinessRequiresExactAuthenticatedHeadAccountAndClock) {
  auto p=proof();
  auto execution=tonlib::execute_verified_admission(p,address(),code_hash(),"close_order_preflight",arguments()).move_as_ok();
  auto id=[] { auto m=master(); return tonlib_api::make_object<tonlib_api::ton_blockIdExt>(
    m.id.workchain,static_cast<td::int64>(m.id.shard),m.id.seqno,m.root_hash.as_slice().str(),m.file_hash.as_slice().str()); };
  for (int mutation=0;mutation<15;++mutation) {
    auto accepted=id();auto header=tonlib_api::make_object<tonlib_api::blocks_header>();
    auto account=tonlib_api::make_object<tonlib_api::raw_fullAccountState>();
    header->id_=id();header->global_id_=-3;header->gen_utime_=1789399530;
    account->block_id_=id();account->sync_utime_=1789399530;
    account->code_=vm::std_boc_serialize(execution.code).move_as_ok().as_slice().str();
    account->data_=vm::std_boc_serialize(execution.data).move_as_ok().as_slice().str();
    switch(mutation) {
      case 1: header->id_->seqno_++;break;
      case 2: account->block_id_->root_hash_[0]^=1;break;
      case 3: header->global_id_=-239;break;
      case 4: header->gen_utime_-=31;account->sync_utime_-=31;break;
      case 5: account->sync_utime_-=31;break;
      case 6: header->gen_utime_+=4;break;
      case 7: account->sync_utime_++;break;
      case 8: account->frozen_hash_="frozen";break;
      case 9: account->code_.clear();break;
      case 10: account->data_.clear();break;
      case 11: account->code_.push_back('x');break;
      case 12: account->code_=vm::std_boc_serialize(vm::CellBuilder{}.finalize()).move_as_ok().as_slice().str();break;
      case 13: accepted->seqno_=0;break;
      case 14: account->block_id_=nullptr;break;
    }
    auto status=tonlib::validate_admission_readiness(*accepted,*header,*account,code_hash(),1789399530);
    if(mutation==0)status.ensure();else status.ensure_error();
  }
}

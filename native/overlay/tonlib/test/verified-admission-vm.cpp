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

namespace {
// The read boundary is synthetic; code/data come from the retained verified
// execution fixture. These tests exercise startup orchestration, not live trust.
struct StartupRound {
  ton::UnixTime master_time{1789399603};
  ton::UnixTime shard_time{1789399602};
  int mutation{0};
  bool network_error{false};
};
struct StartupFixture {
  std::vector<StartupRound> rounds;
  ton::UnixTime now{1789399604};
  unsigned syncs{0}, headers{0}, accounts{0}, observations{0}, checks{0}, expire_at{0};
  std::string calls;
  std::string code, data;
  std::vector<td::int64> observed_master_ages;
  StartupFixture(std::vector<StartupRound> values) : rounds(std::move(values)) {
    auto p = proof();
    auto execution = tonlib::execute_verified_admission(
        p, address(), code_hash(), "close_order_preflight", arguments()).move_as_ok();
    code = vm::std_boc_serialize(execution.code).move_as_ok().as_slice().str();
    data = vm::std_boc_serialize(execution.data).move_as_ok().as_slice().str();
  }
  auto id() const {
    auto m = master();
    return tonlib_api::make_object<tonlib_api::ton_blockIdExt>(m.id.workchain,
        static_cast<td::int64>(m.id.shard), m.id.seqno + syncs,
        m.root_hash.as_slice().str(), m.file_hash.as_slice().str());
  }
  void require_id(const tonlib_api::ton_blockIdExt& value) {
    auto expected = id();
    ASSERT_EQ(value.seqno_, expected->seqno_);
    ASSERT_EQ(value.root_hash_, expected->root_hash_);
    ASSERT_EQ(value.file_hash_, expected->file_hash_);
  }
  auto reads() {
    tonlib::AdmissionStartupReads result;
    result.sync = [&]() -> td::Result<tonlib_api::object_ptr<tonlib_api::ton_blockIdExt>> {
      ASSERT_TRUE(syncs < rounds.size());
      calls += 's';
      if (rounds[syncs++].network_error) return td::Status::Error("LITE_SERVER_NETWORK: fixture");
      return id();
    };
    result.header = [&](const tonlib_api::ton_blockIdExt& accepted)
        -> td::Result<tonlib_api::object_ptr<tonlib_api::blocks_header>> {
      require_id(accepted); ++headers; calls += 'h';
      const auto& round = rounds[syncs - 1];
      if (round.mutation == 8) return td::Status::Error("fixture invalid Merkle proof");
      auto header = tonlib_api::make_object<tonlib_api::blocks_header>();
      header->id_ = id(); header->global_id_ = -3; header->gen_utime_ = round.master_time;
      if (round.mutation == 1) header->id_->seqno_--;
      return std::move(header);
    };
    result.account = [&](const tonlib_api::ton_blockIdExt& accepted)
        -> td::Result<tonlib_api::object_ptr<tonlib_api::raw_fullAccountState>> {
      require_id(accepted); ++accounts; calls += 'a';
      const auto& round = rounds[syncs - 1];
      auto account = tonlib_api::make_object<tonlib_api::raw_fullAccountState>();
      account->block_id_ = id(); account->sync_utime_ = round.shard_time;
      account->code_ = code; account->data_ = data;
      if (round.mutation == 2) account->code_ = vm::std_boc_serialize(vm::CellBuilder{}.finalize()).move_as_ok().as_slice().str();
      if (round.mutation == 3) account->block_id_->root_hash_[0] ^= 1;
      if (round.mutation == 4) account->frozen_hash_ = "frozen";
      if (round.mutation == 5) account->code_.push_back('x');
      if (round.mutation == 6) account->sync_utime_ = 0;
      return std::move(account);
    };
    result.host_now = [&] { calls += 't'; return now; };
    result.within_deadline = [&] { return !expire_at || ++checks < expire_at; };
    result.observe_clock = [&](unsigned round, td::int32 seqno, ton::UnixTime host,
        ton::UnixTime master_time, ton::UnixTime, const td::Status&) {
      ASSERT_EQ(round, syncs); ASSERT_EQ(seqno, id()->seqno_); ASSERT_EQ(host, now);
      ++observations; observed_master_ages.push_back(static_cast<td::int64>(host) - master_time);
    };
    return result;
  }
};
}

TEST(VerifiedAdmissionVm, StartupRefreshesOnlyAuthenticatedPastStaleState) {
  StartupFixture fixture({{1789399530, 1789399529}, {}});
  auto ready = tonlib::authenticate_admission_startup(fixture.reads(), code_hash()).move_as_ok();
  ASSERT_EQ(fixture.calls, "shatshat");
  ASSERT_EQ(fixture.syncs, 2u); ASSERT_EQ(fixture.observations, 2u);
  ASSERT_EQ(fixture.observed_master_ages[0], 74); ASSERT_EQ(fixture.observed_master_ages[1], 1);
  ASSERT_EQ(ready->block_id_->seqno_, fixture.id()->seqno_);
  ASSERT_EQ(ready->master_utime_, 1789399603); ASSERT_EQ(ready->shard_utime_, 1789399602);
}

TEST(VerifiedAdmissionVm, StartupSharesThreeRoundBoundWithNetworkFailures) {
  StartupRound stale{1789399530, 1789399529}, network{}; network.network_error = true;
  for (auto rounds : {std::vector<StartupRound>{stale, stale, stale},
                      std::vector<StartupRound>{network, stale, stale},
                      std::vector<StartupRound>{stale, network, network}}) {
    StartupFixture fixture(std::move(rounds));
    tonlib::authenticate_admission_startup(fixture.reads(), code_hash()).ensure_error();
    ASSERT_EQ(fixture.syncs, 3u);
    ASSERT_EQ(fixture.headers, fixture.accounts);
  }
  StartupFixture fixture({network, {}});
  tonlib::authenticate_admission_startup(fixture.reads(), code_hash()).ensure();
  ASSERT_EQ(fixture.calls, "sshat");
}

TEST(VerifiedAdmissionVm, StartupNeverRefreshesInvalidIdentityCodeProofOrClock) {
  for (int mutation : {1, 2, 3, 4, 5, 6, 8}) {
    StartupFixture fixture({{1789399530, 1789399529, mutation}});
    auto failed = tonlib::authenticate_admission_startup(fixture.reads(), code_hash());
    ASSERT_TRUE(failed.is_error()); ASSERT_TRUE(failed.error().code() != tonlib::admission_past_stale_clock);
    ASSERT_EQ(fixture.syncs, 1u); ASSERT_EQ(fixture.observations, 0u);
  }
  // A stale clock must not hide a future clock or impossible master/shard order.
  for (auto round : {StartupRound{1789399608, 1789399529},
                     StartupRound{1789399530, 1789399608},
                     StartupRound{1789399530, 1789399531}}) {
    StartupFixture fixture({round});
    auto failed = tonlib::authenticate_admission_startup(fixture.reads(), code_hash());
    ASSERT_TRUE(failed.is_error()); ASSERT_TRUE(failed.error().code() != tonlib::admission_past_stale_clock);
    ASSERT_EQ(fixture.syncs, 1u); ASSERT_EQ(fixture.observations, 1u);
  }
}

TEST(VerifiedAdmissionVm, StartupNeverRenewsOriginalDeadline) {
  for (unsigned expired = 1; expired <= 6; ++expired) {
    StartupFixture fixture({{1789399530, 1789399529}, {}});
    fixture.expire_at = expired;
    tonlib::authenticate_admission_startup(fixture.reads(), code_hash()).ensure_error();
    ASSERT_TRUE(fixture.syncs <= 1);
    ASSERT_EQ(fixture.checks, expired);
  }
  StartupFixture fixture(std::vector<StartupRound>{StartupRound{}}); fixture.expire_at = 5;
  tonlib::authenticate_admission_startup(fixture.reads(), code_hash()).ensure_error();
  ASSERT_EQ(fixture.syncs, 1u);  // Even fresh state cannot publish after expiry.
}

TEST(VerifiedAdmissionVm, ClockRefreshClassificationPreservesExactBoundaries) {
  tonlib::validate_admission_proof_times(100, 100, 70).ensure();
  tonlib::validate_admission_proof_times(100, 103, 103).ensure();
  auto past = tonlib::validate_admission_proof_times(100, 100, 69);
  ASSERT_TRUE(past.is_error()); ASSERT_EQ(past.code(), tonlib::admission_past_stale_clock);
  for (auto times : {std::pair<ton::UnixTime, ton::UnixTime>{104, 69}, {69, 104}, {68, 69}, {100, 0}}) {
    auto failed = tonlib::validate_admission_proof_times(100, times.first, times.second);
    ASSERT_TRUE(failed.is_error()); ASSERT_TRUE(failed.code() != tonlib::admission_past_stale_clock);
  }
}

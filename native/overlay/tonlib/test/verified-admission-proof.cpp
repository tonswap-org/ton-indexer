#include "tonlib/VerifiedAdmissionProof.h"

#include "block/block-auto.h"
#include "td/utils/PathView.h"
#include "td/utils/base64.h"
#include "td/utils/crypto.h"
#include "td/utils/filesystem.h"
#include "td/utils/misc.h"
#include "td/utils/tests.h"
#include "ton/lite-tl.hpp"

namespace {

td::Bits256 hash256(td::Slice base64) {
  auto bytes = td::base64_decode(base64).move_as_ok();
  CHECK(bytes.size() == 32);
  return td::Bits256{td::Slice(bytes).ubegin()};
}

ton::BlockIdExt captured_master() {
  return {ton::masterchainId, ton::shardIdAll, 84748194,
          hash256("aDUS8rJWED5bbitiKeH/UhRj6ErbdRD5MpSxlEENLFw="),
          hash256("6w8J+sz5xij2OYrf9GMbn7jTA2NxJ9sxMH/WBrX/FbE=")};
}

ton::BlockIdExt captured_shard() {
  return {0, ton::shardIdAll, 89980765, hash256("HHiEqw9EeR70W3KuCVRwcWExSPzyaJ2YdZqKu6JrIsM="),
          hash256("3SZohopmscmqCwxhGeSVzyfBMhNO3ogMXmNdpuajWmc=")};
}

block::StdAddress captured_address() {
  return block::StdAddress::parse("0:0816eb1798823310dffa9888ea1ff7f9168fdedbbc5b6f1f003720a6dcd169b1")
      .move_as_ok();
}

td::BufferSlice fixture(td::Slice name, td::Slice expected_sha256) {
  auto path = td::PathView(__FILE__).parent_dir().str() + "fixtures/admission-proof/" + name.str();
  auto bytes = td::read_file(path).move_as_ok();
  ASSERT_EQ(td::sha256(bytes.as_slice()), td::hex_decode(expected_sha256).move_as_ok());
  return bytes;
}

auto captured_account() {
  return ton::create_tl_object<ton::lite_api::liteServer_accountState>(
      ton::create_tl_lite_block_id(captured_master()), ton::create_tl_lite_block_id(captured_shard()),
      fixture("shard-proof.boc", "2432807ddd42b1b74d7e7290fbb70ad245f5fb57e72c334addf758c22bf97ae4"),
      fixture("account-proof.boc", "c2a7e96887febba55914575be04c8ac2298ed5c81b46c769ac91d247f4a531f1"),
      fixture("account-state.boc", "c59effdc19f53f242498b0907740c009f1039aadf6d4d42232c3e3a47719158b"));
}

auto captured_config() {
  return ton::create_tl_object<ton::lite_api::liteServer_configInfo>(
      0, ton::create_tl_lite_block_id(captured_master()),
      fixture("config-state-proof.boc", "3334ba664eb368859f3cc14593153b14373a8d807b85fec3493fadace5041a02"),
      fixture("config-proof.boc", "5b70a7d2a29aa18b8fea9cdda3afeabe91d42f74a3e201010ce6411c268113ad"));
}

auto verify(const ton::lite_api::liteServer_accountState& account,
            const ton::lite_api::liteServer_configInfo& config) {
  // A retained historical master is a test input, not a fresh consensus anchor.
  return tonlib::verify_admission_proof(captured_master(), captured_address(), account, config, 1789387015, -3);
}

auto verify_account(const ton::lite_api::liteServer_accountState& response, const block::StdAddress& address) {
  block::AccountState account;
  account.blk = ton::create_block_id(response.id_);
  account.shard_blk = ton::create_block_id(response.shardblk_);
  account.shard_proof = response.shard_proof_.clone();
  account.proof = response.proof_.clone();
  account.state = response.state_.clone();
  return account.validate(captured_master(), address);
}

}  // namespace

TEST(VerifiedAdmissionProof, AuthenticatedClockBounds) {
  using tonlib::validate_admission_proof_times;
  validate_admission_proof_times(1000, 970, 970).ensure();
  validate_admission_proof_times(1000, 1003, 1003).ensure();
  validate_admission_proof_times(1000, 1000, 970).ensure();
  validate_admission_proof_times(1000, 969, 969).ensure_error();
  validate_admission_proof_times(1000, 1000, 969).ensure_error();
  validate_admission_proof_times(1000, 1004, 1004).ensure_error();
  validate_admission_proof_times(1000, 1000, 1001).ensure_error();
  validate_admission_proof_times(0, 1, 1).ensure_error();
  validate_admission_proof_times(1000, 0, 1000).ensure_error();
  validate_admission_proof_times(1000, 1000, 0).ensure_error();
  validate_admission_proof_times(~0U, ~0U, ~0U).ensure();
  validate_admission_proof_times(~0U, 1, 1).ensure_error();
  validate_admission_proof_times(1, ~0U, ~0U).ensure_error();
}

TEST(VerifiedAdmissionProof, ExactAcceptedMasterRequired) {
  auto account = captured_account();
  auto config = captured_config();
  for (auto seqno : {0U, ~0U}) {
    auto master = captured_master();
    master.id.seqno = seqno;
    auto result = tonlib::verify_admission_proof(master, captured_address(), *account, *config, 1789387015, -3);
    ASSERT_TRUE(result.is_error());
    ASSERT_EQ(result.error().message().str(), "admission requires an exact accepted master block");
  }
  auto zero_hash = captured_master();
  zero_hash.root_hash.set_zero();
  tonlib::verify_admission_proof(zero_hash, captured_address(), *account, *config, 1789387015, -3).ensure_error();
  tonlib::verify_admission_proof(captured_shard(), captured_address(), *account, *config, 1789387015, -3)
      .ensure_error();
  ++account->id_->seqno_;
  auto wrong_account = verify(*account, *config);
  ASSERT_TRUE(wrong_account.is_error());
  ASSERT_EQ(wrong_account.error().message().str(),
            "admission account and config must use the exact accepted master");
  account = captured_account();
  ++config->id_->seqno_;
  auto wrong_config = verify(*account, *config);
  ASSERT_TRUE(wrong_config.is_error());
  ASSERT_EQ(wrong_config.error().message().str(),
            "admission account and config must use the exact accepted master");
  config->id_ = nullptr;
  verify(*account, *config).ensure_error();
}

TEST(VerifiedAdmissionProof, CapturedAccountAndConfigCommitments) {
  auto account = captured_account();
  auto config = captured_config();
  block::AccountState state;
  state.blk = captured_master();
  state.shard_blk = captured_shard();
  state.shard_proof = account->shard_proof_.clone();
  state.proof = account->proof_.clone();
  state.state = account->state_.clone();
  auto info = state.validate(captured_master(), captured_address()).move_as_ok();
  ASSERT_EQ(info.root->get_hash().as_slice().str(),
            td::hex_decode("f60e85f772cd4d6292ff80b6ca4d12e53a85fdbc4d7cbb860540e616bd44c232").move_as_ok());
  auto config_state = block::check_extract_state_proof(captured_master(), config->state_proof_.as_slice(),
                                                       config->config_proof_.as_slice())
                          .move_as_ok();
  block::gen::ShardStateUnsplit::Record master_state;
  ASSERT_TRUE(tlb::unpack_cell(config_state, master_state));
  auto config_info = block::Config::extract_from_state(std::move(config_state), block::ConfigInfo::needCapabilities)
                         .move_as_ok();
  ASSERT_EQ(master_state.global_id, -3);
  ASSERT_EQ(config_info->get_global_version(), 15);
  ASSERT_EQ(master_state.gen_utime, 1789387015U);
  tonlib::validate_admission_proof_times(1789387015, master_state.gen_utime, info.gen_utime).ensure();
  // The original mode0 capture did not request prevblocks. It must not become a
  // qualified execution context by inventing/defaulting the missing dictionary.
  auto incomplete = verify(*account, *config);
  ASSERT_TRUE(incomplete.is_error());
  auto reason = incomplete.error().message().str();
  ASSERT_TRUE(reason.find("virtualization") != std::string::npos || reason.find("prev") != std::string::npos);
  LOG(INFO) << "Captured mode0 proof rejected as incomplete context: " << incomplete.error();
}

TEST(VerifiedAdmissionProof, CapturedProofMutationsAndBounds) {
  auto account = captured_account();
  auto config = captured_config();
  auto original = account->state_.as_slice().str();
  account->state_.as_slice()[account->state_.size() / 2] ^= 1;
  verify_account(*account, captured_address()).ensure_error();
  verify(*account, *config).ensure_error();
  account = captured_account();
  auto wrong_address = captured_address();
  wrong_address.addr.set_zero();
  verify_account(*account, wrong_address).ensure_error();
  config->config_proof_.as_slice()[config->config_proof_.size() / 2] ^= 1;
  block::check_extract_state_proof(captured_master(), config->state_proof_.as_slice(),
                                    config->config_proof_.as_slice())
      .ensure_error();
  verify(*account, *config).ensure_error();
  config = captured_config();
  config->state_proof_ = account->proof_.clone();
  verify(*account, *config).ensure_error();
  config = captured_config();
  account->state_ = td::BufferSlice(original + "x");
  auto trailing = verify(*account, *config);
  ASSERT_TRUE(trailing.is_error());
  ASSERT_EQ(trailing.error().message().str(), "admission proof BOC has invalid bounds or root count");
  account->state_ = td::BufferSlice(tonlib::admission_max_proof_bytes + 1);
  auto oversized = verify(*account, *config);
  ASSERT_TRUE(oversized.is_error());
  ASSERT_EQ(oversized.error().message().str(), "admission proof is empty or exceeds its bounded input size");
  account->state_ = td::BufferSlice();
  verify(*account, *config).ensure_error();
}

#include "tonlib/Client.h"
#include "tonlib/VerifiedAdmissionVm.h"
#include "auto/tl/tonlib_api_json.h"
#include "td/utils/JsonBuilder.h"
#include "td/utils/base64.h"
#include "td/utils/logging.h"
#include "tl/tl_json.h"

#include <chrono>
#include <atomic>
#include <thread>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cerrno>
#include <ctime>
#include <fcntl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <mach/mach.h>
#include <unistd.h>

namespace {
constexpr size_t kInputBytes = 256 * 1024;
constexpr size_t kOutputBytes = 8 * 1024 * 1024;
constexpr size_t kConfigBytes = 1024 * 1024;
constexpr unsigned kMaximumJobs = 128;
std::atomic<std::int64_t> deadline_milliseconds{0};
std::atomic<std::int64_t> last_validated_progress_milliseconds{0};
std::atomic<bool> initializing{true};
std::int32_t validated_progress_seqno{0};

std::int64_t monotonic_milliseconds() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::steady_clock::now().time_since_epoch()).count();
}

void deadline_after(std::chrono::seconds duration) {
  deadline_milliseconds.store(monotonic_milliseconds() + duration.count() * 1000);
}

[[noreturn]] void fail(const char* message) {
  std::fprintf(stderr, "ADMISSION_WORKER: %s\n", message);
  std::_Exit(70);
}

void set_bound(int resource, rlim_t value) {
  rlimit limit{value, value};
  if (setrlimit(resource, &limit) != 0) {
    std::fprintf(stderr, "resource=%d errno=%d\n", resource, errno);
    fail("cannot apply required process resource bound");
  }
}

void start_watchdog() {
  // macOS rejects finite RLIMIT_AS and denies unprivileged footprint limits.
  // This is a measured footprint watchdog (20ms), not an OS allocation limit.
  // Fixed VM gas and BOC/stack/cell bounds limit work inside each interval.
  deadline_after(std::chrono::seconds(600));
  last_validated_progress_milliseconds.store(monotonic_milliseconds());
  const auto owned_parent = getppid();
  std::thread([owned_parent] {
    for (;;) {
      if (getppid() != owned_parent) fail("owned supervisor exited");
      task_vm_info_data_t information{};
      mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
      if (task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&information), &count) !=
          KERN_SUCCESS) {
        fail("cannot measure owned worker memory");
      }
      if (information.phys_footprint > 512ULL * 1024 * 1024) {
        fail("worker memory budget exceeded");
      }
      if (monotonic_milliseconds() > deadline_milliseconds.load()) {
        fail("worker monotonic deadline exceeded");
      }
      if (initializing.load() &&
          monotonic_milliseconds() - last_validated_progress_milliseconds.load() > 120000) {
        fail("authenticated cold startup stalled");
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
  }).detach();
}

std::string read_config(const char* path) {
  int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) {
    fail("cannot open pinned configuration");
  }
  struct stat metadata {};
  if (fstat(fd, &metadata) || !S_ISREG(metadata.st_mode) || metadata.st_nlink != 1 ||
      metadata.st_uid != geteuid() || (metadata.st_mode & 0022) || metadata.st_size <= 0 ||
      static_cast<size_t>(metadata.st_size) > kConfigBytes) {
    close(fd);
    fail("invalid configuration file ownership, size, type or mode");
  }
  std::string value(static_cast<size_t>(metadata.st_size), '\0');
  size_t offset = 0;
  while (offset < value.size()) {
    auto count = read(fd, &value[offset], value.size() - offset);
    if (count <= 0) {
      close(fd);
      fail("configuration read was incomplete");
    }
    offset += static_cast<size_t>(count);
  }
  char extra;
  if (read(fd, &extra, 1) != 0) {
    close(fd);
    fail("configuration changed during read");
  }
  close(fd);
  return value;
}

bool read_job(std::string& value) {
  value.clear();
  for (;;) {
    const int character = std::getc(stdin);
    if (character == EOF) {
      if (!value.empty()) {
        fail("truncated request line");
      }
      return false;
    }
    if (character == '\n') {
      if (value.empty()) {
        fail("empty request");
      }
      return true;
    }
    if (!character || value.size() == kInputBytes) {
      fail("request exceeds byte bound or contains NUL");
    }
    value.push_back(static_cast<char>(character));
  }
}

tonlib_api::object_ptr<tonlib_api::Object> receive(tonlib::Client& client, std::uint64_t id,
                                                std::chrono::seconds duration) {
  auto deadline = std::chrono::steady_clock::now() + duration;
  unsigned updates = 0;
  while (std::chrono::steady_clock::now() < deadline) {
    auto response = client.receive(0.1);
    if (!response.object) {
      continue;
    }
    if (response.id == id) {
      return std::move(response.object);
    }
    if (response.id != 0 || ++updates > 10000) {
      fail("unexpected response identity or unbounded update stream");
    }
    if (response.object->get_id() == tonlib_api::updateSyncState::ID) {
      const auto& state = static_cast<const tonlib_api::updateSyncState&>(*response.object).sync_state_;
      if (state && state->get_id() == tonlib_api::syncStateInProgress::ID) {
        const auto current = static_cast<const tonlib_api::syncStateInProgress&>(*state).current_seqno_;
        // LastBlock advances this field only after validating a proof chain.
        if (current > validated_progress_seqno) {
          validated_progress_seqno = current;
          last_validated_progress_milliseconds.store(monotonic_milliseconds());
        }
      }
      auto progress = td::json_encode<std::string>(td::ToJson(*response.object));
      if (progress.size() > 1024) {
        fail("malformed sync progress");
      }
      std::fprintf(stderr, "ADMISSION_SYNC_PROGRESS: %s\n", progress.c_str());
    }
  }
  // A supervisor also terminates the owned process on its monotonic deadline.
  // _Exit avoids waiting on pending ADNL handles after a timeout.
  fail("request deadline exceeded");
}

void emit(const tonlib_api::Object& response) {
  auto encoded = td::json_encode<std::string>(td::ToJson(response));
  if (encoded.size() > kOutputBytes) {
    fail("result exceeds output byte bound");
  }
  std::fwrite(encoded.data(), 1, encoded.size(), stdout);
  std::fputc('\n', stdout);
  std::fflush(stdout);
}
}  // namespace

int main(int argc, char** argv) {
  if (argc != 4) {
    fail("expected pinned config path, engine address and code hash");
  }
  // Limits apply only to this owned worker, never to the indexer or wallet.
  set_bound(RLIMIT_CORE, 0);
  set_bound(RLIMIT_CPU, 120);
  set_bound(RLIMIT_STACK, 8 * 1024 * 1024);
  set_bound(RLIMIT_NOFILE, 64);
  start_watchdog();
  if (tonlib::initialize_admission_vm().is_error()) fail("official TVM initialization failed");
  auto config = read_config(argv[1]);
  auto expected_hash = td::base64_decode(td::Slice(argv[3], std::strlen(argv[3])));
  if (expected_hash.is_error() || expected_hash.ok().size() != 32) {
    fail("qualified code hash must be exactly 32 bytes");
  }
  tonlib::Client::execute({0, tonlib_api::make_object<tonlib_api::setLogVerbosityLevel>(0)});
  tonlib::Client client;
  client.send({1, tonlib_api::make_object<tonlib_api::init>(
                      tonlib_api::make_object<tonlib_api::options>(
                          tonlib_api::make_object<tonlib_api::config>(std::move(config), "testnet", false, true),
                          tonlib_api::make_object<tonlib_api::keyStoreTypeInMemory>()))});
  auto initialized = receive(client, 1, std::chrono::seconds(600));
  if (initialized->get_id() != tonlib_api::options_info::ID) {
    emit(*initialized);
    fail("initialization failed");
  }
  // sync uses LastBlock; blocks.getMasterchainInfo is deliberately unreachable.
  tonlib_api::object_ptr<tonlib_api::Object> synced;
  for (unsigned attempt = 0; attempt < 3; ++attempt) {
    client.send({2, tonlib_api::make_object<tonlib_api::sync>()});
    synced = receive(client, 2, std::chrono::seconds(600));
    if (synced->get_id() != tonlib_api::error::ID) {
      break;
    }
    const auto& error = static_cast<const tonlib_api::error&>(*synced);
    if (error.message_.find("LITE_SERVER_NETWORK") != 0) {
      break;
    }
    // Startup only: preserve LastBlock's validated progress while the official
    // transport excludes the failed server. Never retry an admission execution.
    std::fprintf(stderr, "ADMISSION_STARTUP_NETWORK: %s\n", error.message_.c_str());
  }
  if (synced->get_id() != tonlib_api::ton_blockIdExt::ID) {
    emit(*synced);
    fail("authenticated initialization sync failed");
  }
  const auto& accepted = static_cast<const tonlib_api::ton_blockIdExt&>(*synced);
  const auto accepted_id = [&] { return tonlib_api::make_object<tonlib_api::ton_blockIdExt>(
      accepted.workchain_, accepted.shard_, accepted.seqno_, accepted.root_hash_, accepted.file_hash_); };
  // Official getBlockHeader verifies the Merkle proof against this exact accepted
  // ID. Exact withBlock raw account validates its shard/account proof and exposes
  // info.gen_utime as sync_utime; neither response supplies a new trust anchor.
  client.send({3, tonlib_api::make_object<tonlib_api::blocks_getBlockHeader>(accepted_id())});
  auto header = receive(client, 3, std::chrono::seconds(5));
  if (header->get_id() != tonlib_api::blocks_header::ID) { emit(*header); fail("authenticated readiness header failed"); }
  client.send({4, tonlib_api::make_object<tonlib_api::withBlock>(accepted_id(),
      tonlib_api::make_object<tonlib_api::raw_getAccountState>(
          tonlib_api::make_object<tonlib_api::accountAddress>(argv[2])))});
  auto account = receive(client, 4, std::chrono::seconds(5));
  if (account->get_id() != tonlib_api::raw_fullAccountState::ID) { emit(*account); fail("authenticated readiness account failed"); }
  const auto& verified_header = static_cast<const tonlib_api::blocks_header&>(*header);
  const auto& verified_account = static_cast<const tonlib_api::raw_fullAccountState&>(*account);
  auto readiness = tonlib::validate_admission_readiness(accepted, verified_header, verified_account,
      expected_hash.ok(), static_cast<ton::UnixTime>(std::time(nullptr)));
  if (readiness.is_error()) { std::fprintf(stderr,"%s\n",readiness.error().message().c_str()); fail("authenticated readiness validation failed"); }
  emit(*tonlib_api::make_object<tonlib_api::smc_verifiedAdmissionReady>(accepted_id(),
      verified_header.gen_utime_, verified_account.sync_utime_, expected_hash.ok()));
  initializing.store(false);
  deadline_after(std::chrono::seconds(900));
  std::string input;
  for (unsigned job = 0; job < kMaximumJobs && read_job(input); ++job) {
    deadline_after(std::chrono::seconds(5));
    auto json = td::json_decode(input);
    if (json.is_error()) {
      fail("request JSON is invalid");
    }
    tonlib_api::object_ptr<tonlib_api::Function> function;
    if (from_json(function, json.move_as_ok()).is_error() || !function ||
        function->get_id() != tonlib_api::smc_runGetMethodVerified::ID) {
      fail("only verified admission execution is permitted");
    }
    const auto& request = static_cast<const tonlib_api::smc_runGetMethodVerified&>(*function);
    if (!request.account_address_ || request.account_address_->account_address_ != argv[2] ||
        request.expected_code_hash_ != expected_hash.ok()) {
      fail("request differs from qualified engine identity");
    }
    const auto id = static_cast<std::uint64_t>(job) + 5;
    client.send({id, std::move(function)});
    auto response = receive(client, id, std::chrono::seconds(5));
    if (response->get_id() != tonlib_api::smc_verifiedRunResult::ID &&
        response->get_id() != tonlib_api::error::ID) {
      fail("unexpected admission response type");
    }
    emit(*response);
    deadline_after(std::chrono::seconds(900));
  }
  std::_Exit(0);
}

import assert from "node:assert/strict";
import { parseLedgerLaunchpadCodeHashes } from "../config/ledgerLaunchpad";

const hashes = { fixedCodeHash: "a".repeat(64), walletCodeHash: "b".repeat(64), bondingCodeHash: "c".repeat(64), auctionCodeHash: "d".repeat(64) };
assert.deepEqual(parseLedgerLaunchpadCodeHashes(JSON.stringify(hashes)), hashes);
assert.equal(parseLedgerLaunchpadCodeHashes(undefined), undefined);
assert.equal(parseLedgerLaunchpadCodeHashes(" \n "), undefined);
for (const value of [
  null, [], {}, true, "hash", { fixedCodeHash: hashes.fixedCodeHash },
  { fixedCodeHash: hashes.fixedCodeHash, walletCodeHash: hashes.walletCodeHash },
  { ...hashes, factoryCodeHash: "c".repeat(64) },
  { ...hashes, fixedCodeHash: "A".repeat(64) },
  { ...hashes, walletCodeHash: "g".repeat(64) },
  { ...hashes, walletCodeHash: "b".repeat(63) },
  { ...hashes, walletCodeHash: 123 },
  { ...hashes, fixedCodeHash: ` ${hashes.fixedCodeHash}` },
]) assert.throws(() => parseLedgerLaunchpadCodeHashes(JSON.stringify(value)), /LEDGER_LAUNCHPAD_CODE_HASHES_JSON/);
assert.throws(() => parseLedgerLaunchpadCodeHashes("{"), /must be valid JSON/);
console.log("Launchpad qualification configuration checks passed");

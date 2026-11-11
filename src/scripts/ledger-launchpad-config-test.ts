import assert from "node:assert/strict";
import { validateLaunchpadCodeHashes } from "../ledger/bindings";

const hashes = { fixedCodeHash: "a".repeat(64), walletCodeHash: "b".repeat(64), bondingCodeHash: "c".repeat(64), auctionCodeHash: "d".repeat(64) };
assert.deepEqual(validateLaunchpadCodeHashes(hashes), hashes);
for (const value of [
  undefined, null, [], {}, true, "hash", " \n ", JSON.stringify(hashes), { fixedCodeHash: hashes.fixedCodeHash },
  { fixedCodeHash: hashes.fixedCodeHash, walletCodeHash: hashes.walletCodeHash },
  { ...hashes, factoryCodeHash: "c".repeat(64) },
  { ...hashes, fixedCodeHash: "A".repeat(64) },
  { ...hashes, walletCodeHash: "g".repeat(64) },
  { ...hashes, walletCodeHash: "b".repeat(63) },
  { ...hashes, walletCodeHash: 123 },
  { ...hashes, fixedCodeHash: ` ${hashes.fixedCodeHash}` },
]) assert.throws(() => validateLaunchpadCodeHashes(value), /Launchpad binding/);
console.log("Launchpad qualification configuration checks passed");

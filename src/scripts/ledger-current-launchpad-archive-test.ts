import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { currentCaptureSha256 as sha } from './current-capture-build';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';
import { decodeCurrentLaunchpadOperations } from '../ledger/currentLaunchpad';
import { currentLaunchpadBindingFromManifest, verifyLaunchpadTransaction } from '../ledger/currentLaunchpadProof';
const bytes = readFileSync(join(__dirname, 'fixtures/current-launchpad-native/archive-business-originals.json.gz'));
assert.equal(sha(bytes), '3abd6ed45b048e6b9472edda21e2a196d165762b61d9015e2d590cd11cf664b5');
const corpus = JSON.parse(gunzipSync(bytes).toString()); assert.equal(corpus.schema, 'tonswap-launchpad-archive-business-originals-v1');
let checks = 0;
for (const c of corpus.cases) {
  const pins = runtimeManifestFixture();
  assert.equal(c.fixtureAuthorityHash, pins.contracts.T3Hub!.codeHash);
  for (const role of ['T3Hub', 'SaleFactory'] as const) assert.equal(c.release.contracts[role].codeHash, pins.contracts[role]!.codeHash);
  for (const role of ['T3Wallet', 'T3RecoveryProof', 'SaleFixed', 'JettonV21Minter', 'JettonV21Wallet'] as const) assert.equal(c.release.templates[role], pins.templates[role]);
  const binding = currentLaunchpadBindingFromManifest(c.release), select = (rows = c.transactions) => decodeCurrentLaunchpadOperations(c.owner, binding, rows).filter(o => o.economics.kind === 'archive-claim');
  const found = select(); assert.equal(found.length, 1); const e = found[0].economics;
  assert.equal(e.outcome, 'delivered', e.issues.join(',')); assert.equal(e.owedRetiredRaw, '1000000000');
  assert.equal(e.cash.length, 1); const cash = e.cash[0];
  assert.equal(cash.amountRaw, e.owedRetiredRaw); assert.equal(cash.to, e.recoveryBeneficiary);
  assert.equal(cash.root, c.release.contracts.T3Hub.address); assert.equal(cash.from, e.child);
  assert.notEqual(e.owner, e.recoveryBeneficiary, 'Permissionless claim initiator is distinct from economic beneficiary');
  assert.deepEqual(e.paidIn, {}); assert.deepEqual(e.paidOut, {}); checks++;
  for (const missingHash of [cash.debitTransaction, cash.creditTransaction]) {
    const missing = select(c.transactions.filter((r: any) => verifyLaunchpadTransaction(r).hash !== missingHash));
    assert.equal(missing.length, 1); assert.notEqual(missing[0].economics.outcome, 'delivered');
    assert.deepEqual(missing[0].economics.cash, []); checks++;
  }
  assert.equal(select(c.transactions.filter((r: any) => verifyLaunchpadTransaction(r).hash !== e.dispatch.hash)).length, 0); checks++;
  console.log(c.file.split('/').slice(-3).join('/'), 'original archive liability retirement and exact beneficiary payout');
}
console.log(`Current Launchpad archive ${checks} original owner/physical payout checks passed; complete account history is a separate archive qualification.`);

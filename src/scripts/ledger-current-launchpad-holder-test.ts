import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { currentCaptureSha256 as sha, readCurrentCaptureManifest, assertCurrentCaptureTargets } from './current-capture-build';
import { decodeCurrentLaunchpadOperations } from '../ledger/currentLaunchpad';
import { currentLaunchpadBindingFromManifest, verifyLaunchpadTransaction } from '../ledger/currentLaunchpadProof';
import { currentLaunchpadProjectionFixture } from './support/currentLaunchpadFixture';
import { projectOwnerLedger } from '../ledger/project';

async function main() {
  const root = join(__dirname, 'fixtures/current-launchpad-holder-native'), indexBytes = readFileSync(join(root, 'index.json'));
  assert.equal(sha(indexBytes), '003061e9b54e612b08e4a0a5e3ddbf63d4fc92922eb53a3e4fe1f60c523c2056');
  const index = JSON.parse(indexBytes.toString()); assert.equal(index.schema, 'tonswap-current-launchpad-holder-fixtures-v1');
  const read = (file: string) => {
    const entry = index.files.find((f: any) => f.file === file); assert(entry);
    const bytes = readFileSync(join(root, file)); assert.equal(sha(bytes), entry.sha256);
    const raw = file.endsWith('.json.gz') ? gunzipSync(bytes) : bytes;
    if (entry.originalSha256) { assert.equal(sha(raw), entry.originalSha256); assert.equal(raw.length, entry.originalBytes); }
    return raw;
  };
  for (const file of index.files) read(file.file);
  for (const kind of ['capture', 'proof']) {
    const receipt = JSON.parse(read(`${kind}/producer-receipt.json`).toString()), inventory = read(`${kind}/source-inventory.json`), log = read(`${kind}/producer.log`);
    assert.equal(receipt.exitCode, 0); assert.deepEqual(receipt.changedSources, []); assert.equal(receipt.sourceLockSha256, sha(inventory)); assert.equal(receipt.logSha256, sha(log));
    assert.match(log.toString(), /^\s+Tests\s+4 passed \(4\)$/m); assert.doesNotMatch(log.toString(), /\b(?:failed|skipped)\b/i);
    for (const output of receipt.outputs) assert.equal(sha(read(`${kind}/${output.path}.gz`)), output.sha256);
  }
  const build = join(__dirname, 'fixtures/current-capture-build'), snapshot = readCurrentCaptureManifest({ nativeRoot: join(build, 'source'), artifactRoot: join(build, 'artifacts'), manifestPath: join(build, 'manifest.json'), expectedManifestSha256: '9d56c4bf5045e35207f01061f34f26eef6253fdc0b3a619d78cc21249bd319f5' });
  assertCurrentCaptureTargets(snapshot, ['T3Hub', 'T3Wallet', 'T3RecoveryProof', 'SaleFactory', 'SaleFixed']);
  const corpus = JSON.parse(read('collector.json.gz').toString()); let checks = 0;
  for (const c of corpus.cases) {
    const config = c.name.endsWith('x6') ? 'x6' : 'default';
    const world = JSON.parse(read(`capture/captures/${c.name}/0-${config}-complete.json.gz`).toString());
    const proof = JSON.parse(read(`proof/captures/${c.name}.json.gz`).toString());
    assert.equal(sha(read(`capture/captures/${c.name}/0-${config}-complete.json.gz`)), c.completeSha256);
    assert.equal(proof.sourceSha256, c.completeSha256);
    assert.equal(world.fixtureAuthority.codeHash, snapshot.manifest.targets.T3Hub.codeHash);
    const binding = currentLaunchpadBindingFromManifest(c.manifest), rows = [...world.completeTransactions, ...proof.transactions];
    const dispatch = verifyLaunchpadTransaction(proof.claimDispatch), select = (evidence = rows) => decodeCurrentLaunchpadOperations(proof.owner, binding, evidence).find(o => o.economics.dispatch.hash === dispatch.hash && o.economics.kind === 'holder-claim');
    const operation = select(); assert(operation, c.name); const e = operation.economics;
    assert.equal(e.outcome, 'delivered', `${c.name}: ${e.issues}`);
    assert.equal(e.recoveredAccountingRaw, c.response.candidates[0].amountRaw);
    assert.equal(e.recoveryBeneficiary, proof.owner); assert.deepEqual(e.cash, []); assert.deepEqual(e.paidIn, {}); assert.deepEqual(e.paidOut, {}); checks++;
    const input = currentLaunchpadProjectionFixture({ binding, request: { owner: proof.owner }, completeTransactions: rows }), projected = await projectOwnerLedger(input);
    const event = projected.events.find(e => e.settlement?.currentLaunchpad?.dispatch.hash === dispatch.hash && e.settlement.currentLaunchpad.kind === 'holder-claim');
    assert(event); assert.equal(event.settlement!.status, 'confirmed', `${c.name}: ${event.issues}`);
    assert(!event.movements.some(m => m.asset.kind === 'jetton'), 'Restored receipt accounting is not a token payout'); checks++;
    assert(!select(rows.filter(row => verifyLaunchpadTransaction(row).hash !== dispatch.hash))); checks++;
    const claim = rows.find(row => { const t = verifyLaunchpadTransaction(row); return t.account === e.child && t.tx.inMessage?.body.bits.length! >= 32 && t.tx.inMessage!.body.beginParse().preloadUint(32) === 0x4a52434d; }); assert(claim);
    const missing = select(rows.filter(row => row !== claim)); assert(missing); assert.equal(missing.economics.outcome, 'unresolved'); assert.equal(missing.economics.recoveredAccountingRaw, '0'); checks++;
    console.log(c.name, 'original owner claim restores accounting without cash');
  }
  console.log(`Current Launchpad holder ${checks} production-Hub accounting/projection/original-intent checks passed.`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });

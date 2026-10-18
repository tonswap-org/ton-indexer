import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { collectLaunchpadWalletClaimEvidence, readLaunchpadWalletClaimRequest } from '../runtime/launchpadWalletClaimEvidence';
import { collectLaunchpadOperationEvidence } from '../runtime/launchpadOperationEvidence';
import { originalProductCaptureAdapter } from './current-launchpad-native-evidence-test';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import { verifyOrderTransaction } from '../orders/evidence';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function main() {
  const [input, output] = process.argv.slice(2); assert(input && output && [input, output].every(isAbsolute));
  const cases: unknown[] = [], now = Date.now;
  try {
    for (const folder of readdirSync(input).sort()) {
      const dir = join(input, folder), files = readdirSync(dir), complete = files.filter(f => f.endsWith('-complete.json')); assert.equal(complete.length, 1);
      const capturePath = join(dir, complete[0]), originalPath = join(dir, 'original.json'), bytes = readFileSync(capturePath), originalBytes = readFileSync(originalPath);
      const c = JSON.parse(bytes.toString()), original = JSON.parse(originalBytes.toString()), request = original.request, manifest = c.release as RuntimeReleaseManifest;
      assert.equal(c.schema, 'tonswap-launchpad-native-capture-v1'); assert.equal(original.schema, 'tonswap-launchpad-wallet-native-capture-v1');
      assert.equal(manifest.contracts.T3Hub!.address, c.bindings.t3Root); assert.equal(manifest.contracts.T3Hub!.codeHash, c.bindings.t3MasterHash);
      assert.equal(manifest.templates.T3Wallet, c.bindings.t3WalletHash); assert.equal(manifest.contracts.SaleFactory!.address, c.bindings.factory);
      Date.now = () => c.head.utime * 1000;
      const a = originalProductCaptureAdapter(c), parsed = readLaunchpadWalletClaimRequest(request, manifest);
      const response = await collectLaunchpadOperationEvidence(manifest, a.source, a.store, parsed);
      const walletClaims = await collectLaunchpadWalletClaimEvidence(manifest, a.source, a.store, parsed);
      assert(response.coverage.complete, `${folder} operation ${JSON.stringify(response.coverage)}`);
      assert(walletClaims.coverage.complete, `${folder} claims ${JSON.stringify(walletClaims.coverage)}`);
      const records = walletClaims.wallets.flatMap(w => w.claims.records); assert.equal(records.length, original.expectedClaimCount, folder);
      for (const group of walletClaims.wallets.filter(w => w.claims.records.length)) {
        assert.equal(group.role, original.role); assert.equal(group.wallet.address, original.wallet);
        for (const record of group.claims.records) {
          assert.equal(record.owner, original.walletOwner); assert.equal(record.recipient, original.recipient);
          assert.equal(record.failed, original.stage === 'marked'); assert.equal(record.attempt, '0');
          const tx = verifyOrderTransaction(record.transferTransaction); assert.equal(tx.tx.lt.toString(), record.originLt); assert(tx.succeeded);
          assert(response.transactions.some(row => row.account === record.transferTransaction.account && verifyOrderTransaction(row).hash === tx.hash));
        }
      }
      if (original.stage === 'unmarked') assert.equal(walletClaims.wallets.flatMap(w => w.claims.failures).length, 1);
      a.control.missingAccount = original.wallet;
      assert(!(await collectLaunchpadWalletClaimEvidence(manifest, a.source, a.store, parsed)).coverage.complete); a.control.missingAccount = '';
      const wrong = readLaunchpadWalletClaimRequest({ ...request, dispatch: { ...request.dispatch, hash: '0'.repeat(64) } }, manifest);
      assert(!(await collectLaunchpadWalletClaimEvidence(manifest, a.source, a.store, wrong)).coverage.complete);
      cases.push({ file: folder, capturePath, sourceSha256: sha(bytes), originalPath, originalSha256: sha(originalBytes), request, manifest,
        expectedClaimCount: original.expectedClaimCount, role: original.role, stage: original.stage, response, walletClaims });
      console.log(folder, response.transactions.length, 'original transactions;', records.length, 'selected claims');
    }
    assert(cases.length > 0);
    writeFileSync(output, JSON.stringify({ schema: 'tonswap-native-launchpad-wallet-recovery-collector-test-v1', input,
      qualification: 'Production native Hub, wallet and reserve original execution boundaries; synthetic sandbox consensus/source adapter only.', cases }, null, 2) + '\n', { flag: 'wx' });
    console.log('Completed', cases.length, 'native wallet recovery snapshots');
  } finally { Date.now = now; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

/** Original native execution cells under a synthetic consensus/source adapter.
 * Positive sparse witnesses require native failed-transfer captures. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { verifyOrderTransaction } from '../orders/evidence';
import { collectLaunchpadWalletClaimEvidence, readLaunchpadWalletClaimRequest } from '../runtime/launchpadWalletClaimEvidence';
import { launchpadCaptureAdapter } from './current-launchpad-native-evidence-test';
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
async function main() {
  const [completeDir, requestDir, output] = process.argv.slice(2);
  assert(completeDir && requestDir && output && [completeDir, requestDir, output].every(isAbsolute));
  const exports: unknown[] = [], now = Date.now;
  try {
    for (const file of readdirSync(completeDir).filter(file => file.endsWith('-complete.json')).sort()) {
      const originalBytes = readFileSync(join(completeDir, file)), c = JSON.parse(originalBytes.toString());
      Date.now = () => c.head.utime * 1000;
      const requestFiles = readdirSync(requestDir).filter(name => name.startsWith(file.replace('-complete.json', '-')) && name.endsWith('.json')).sort();
      assert(requestFiles.length > 0);
      for (const requestFile of requestFiles) {
        const requestBytes = readFileSync(join(requestDir, requestFile)), original = JSON.parse(requestBytes.toString()), request = original.request;
        const a = launchpadCaptureAdapter(c, request), parsed = readLaunchpadWalletClaimRequest(request, a.manifest);
        const response = await collectLaunchpadWalletClaimEvidence(a.manifest, a.source, a.store, parsed);
        assert(response.coverage.complete, `${requestFile}: ${JSON.stringify(response.coverage)}`);
        assert(response.wallets.length <= 2); assert.equal(new Set(response.wallets.map(w => w.wallet.address)).size, response.wallets.length);
        const records = response.wallets.flatMap(w => w.claims.records), failures = response.wallets.flatMap(w => w.claims.failures);
        assert.equal(records.length, original.expectedClaimCount ?? c.expectedClaimCount ?? 0, requestFile);
        records.forEach(record => { const tx = verifyOrderTransaction(record.transferTransaction); assert.equal(tx.tx.lt.toString(), record.originLt); assert(tx.succeeded); });
        if (original.expectedRoles) assert.deepEqual(response.wallets.filter(w => w.claims.records.length).map(w => w.role).sort(), original.expectedRoles.sort());
        a.control.missingAccount = request.factory;
        assert(!(await collectLaunchpadWalletClaimEvidence(a.manifest, a.source, a.store, parsed)).coverage.complete); a.control.missingAccount = '';
        const wrong = readLaunchpadWalletClaimRequest({ ...request, dispatch: { ...request.dispatch, hash: '0'.repeat(64) } }, a.manifest);
        assert(!(await collectLaunchpadWalletClaimEvidence(a.manifest, a.source, a.store, wrong)).coverage.complete);
        const abort = new AbortController(); abort.abort(); await assert.rejects(collectLaunchpadWalletClaimEvidence(a.manifest, a.source, a.store, parsed, abort.signal));
        exports.push({ file: requestFile, sourceSha256: sha(originalBytes), requestSha256: sha(requestBytes), request, manifest: a.manifest, response });
        console.log(requestFile, response.wallets.length, 'canonical wallet groups;', records.length, 'claims;', failures.length, 'failure witnesses');
      }
    }
    assert(exports.length > 0);
    writeFileSync(output, JSON.stringify({ schema: 'tonswap-native-launchpad-wallet-collector-test-v1',
      qualification: 'Unchanged original native execution cells and exact current getter observations; synthetic sandbox release/head adapter, no deployment or consensus qualification.',
      completeDir, requestDir, cases: exports }, null, 2) + '\n', { flag: 'wx' });
    console.log('Completed', exports.length, 'original request wallet-claim checks');
  } finally { Date.now = now; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

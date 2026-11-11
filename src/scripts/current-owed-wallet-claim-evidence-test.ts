/** Original native execution with a synthetic exact-head transport adapter.
 * Invoke with the frozen capture directory; no public-chain admission claimed. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readOwedWalletClaimRequest, collectOwedWalletClaimEvidence } from '../runtime/owedWalletClaimEvidence';
import { ProductEvidenceError } from '../runtime/productEvidence';
import { verifyOrderTransaction } from '../orders/evidence';
import { currentOwedNativeAdapter } from './support/currentOwedNativeAdapter';
import { currentOwedFixture } from './support/currentOwedFixture';

async function main() {
  const [directory, output, mode] = process.argv.slice(2);
  assert(!directory || isAbsolute(directory)); assert(!output || isAbsolute(output));
  assert(mode === undefined || mode === '--baseline');
  const accepts = (name: string) => /^(direct|archive)-(delivered|refused)-(default|x6)\.json$/.test(name)
    || /^protected-(failed|marked|delivered)-(default|x6)\.json$/.test(name);
  const priority = (name: string) => name.startsWith('protected-failed-') ? 0 : name.startsWith('protected-marked-') ? 1 : 2;
  const cases = directory ? (function* () {
    for (const file of readdirSync(directory).filter(accepts).sort((a, b) => priority(a) - priority(b) || a.localeCompare(b))) {
      const bytes = readFileSync(join(directory, file)); yield { file, bytes, capture: JSON.parse(bytes.toString()) };
    }
  })() : currentOwedFixture().cases();
  const responseDirectory = output ? join(dirname(output), `${basename(output, '.json')}-responses`) : null;
  if (responseDirectory) mkdirSync(responseDirectory);
  const results: unknown[] = [], realNow = Date.now;
  try {
    for (const { file, bytes, capture } of cases) {
      if (!accepts(file)) continue;
      assert.equal(capture.schema, 'tonswap-current-owed-native-v1');
      const a = currentOwedNativeAdapter(capture), p = capture.plan;
      Date.now = () => a.head.utime * 1000;
      const request = { ...p.scope, kind: p.kind, queryId: p.queryId, amountRaw: p.amountRaw, bodyBoc: p.bodyBoc,
        bodyHash: p.bodyHash, valueNano: p.valueNano, dispatch: capture.dispatch };
      const parsed = readOwedWalletClaimRequest(request, a.manifest);
      const collect = () => collectOwedWalletClaimEvidence(a.manifest, a.source, a.store, parsed);
      // A source-wallet refusal never created a protected debit. Its owner
      // keeps the holder owed entry; no frozen source tree can invent a retry.
      if (file.includes('-refused-')) {
        await assert.rejects(collect, error => error instanceof ProductEvidenceError && error.status === 503);
        results.push({ file, sha256: createHash('sha256').update(bytes).digest('hex'), status: 'unavailable-source-wallet' });
        continue;
      }
      const result = await collect(); assert.equal(result.coverage.complete, true, JSON.stringify(result.coverage));
      const responseBytes = JSON.stringify(result, null, 2) + '\n';
      if (responseDirectory) writeFileSync(join(responseDirectory, file), responseBytes, { flag: 'wx' });
      assert.deepEqual(result.request, { kind: p.kind, owner: p.scope.owner, holder: p.scope.holder, slot: p.scope.slot, bodyHash: p.bodyHash });
      const failed = file.startsWith('protected-failed-'), marked = file.startsWith('protected-marked-');
      assert.equal(result.claims.records.length, failed || marked ? 1 : 0, 'Only a current failed original debit can be retried');
      if (failed || marked) {
        const record = result.claims.records[0];
        assert.equal(record.owner, p.scope.holder); assert.equal(record.recipient, p.scope.owner);
        assert.equal(record.amountRaw, p.amountRaw); assert.equal(record.queryId, p.queryId);
        assert.equal(record.burn, false); assert.equal(record.cancelled, false); assert.equal(record.failed, marked);
        assert.equal(result.claims.failures.length, 1);
        assert.equal(record.transferTransaction.account, result.wallet.address);
        const original = verifyOrderTransaction(record.transferTransaction);
        a.control.missingBoundary = `${result.wallet.address}:${original.tx.lt}:${original.hash}`;
        const missingTransfer = await collect(); assert.equal(missingTransfer.coverage.complete, false); assert.equal(missingTransfer.claims.records.length, 0);
        a.control.missingBoundary = '';
        const changedAmount = readOwedWalletClaimRequest({ ...request, amountRaw: String(BigInt(p.amountRaw) + 1n) }, a.manifest);
        const wrong = await collectOwedWalletClaimEvidence(a.manifest, a.source, a.store, changedAmount);
        assert.equal(wrong.coverage.complete, false); assert.equal(wrong.claims.records.length, 0);
        assert(wrong.coverage.gaps.some(g => g.code === 'original_owed_transfer_mismatch'));
        if (p.kind === 'direct' && BigInt(p.amountRaw) > 1n) {
          const reviewedLower = readOwedWalletClaimRequest({ ...request, amountRaw: String(BigInt(p.amountRaw) - 1n) }, a.manifest);
          const increased = await collectOwedWalletClaimEvidence(a.manifest, a.source, a.store, reviewedLower);
          assert.equal(increased.coverage.complete, true); assert.equal(increased.claims.records.length, 1);
          assert.equal(increased.claims.records[0].amountRaw, record.amountRaw, 'CLMJ retains the actual original whole-balance debit');
        }
      }
      a.control.missingBoundary = `${p.scope.owner}:${capture.dispatch.lt}:${capture.dispatch.hash}`;
      const missing = await collect(); assert.equal(missing.coverage.complete, false); assert.equal(missing.claims.records.length, 0);
      a.control.missingBoundary = '';
      const changedDispatch = readOwedWalletClaimRequest({ ...request, dispatch: { ...capture.dispatch, hash: 'ff'.repeat(32) } }, a.manifest);
      const wrong = await collectOwedWalletClaimEvidence(a.manifest, a.source, a.store, changedDispatch);
      assert.equal(wrong.coverage.complete, false); assert.equal(wrong.claims.records.length, 0);
      results.push({ file, sha256: createHash('sha256').update(bytes).digest('hex'), records: result.claims.records.length,
        failures: result.claims.failures.length, responseSha256: createHash('sha256').update(responseBytes).digest('hex'),
        missingOriginalRefused: true, substitutedDispatchRefused: true });
      console.log(file, result.claims.records.length, 'current selected claims; missing/substituted original refused');
    }
  } finally { Date.now = realNow; }
  assert.equal(results.length, mode === '--baseline' ? 8 : 14, 'Complete default/x6 corpus required');
  if (output) writeFileSync(output, JSON.stringify({ schema: 'tonswap-owed-wallet-claim-native-check-v1',
    publicQualification: false, scope: 'Original native transactions; synthetic transport and consensus anchors', results }, null, 2) + '\n', { flag: 'wx' });
  console.log(`${results.length} current owed-wallet native cases passed.`);
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

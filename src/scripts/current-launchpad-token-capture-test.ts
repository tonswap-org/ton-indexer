import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Cell } from '@ton/core';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';
import { originalProductCaptureAdapter } from './current-launchpad-native-evidence-test';
import { collectLaunchpadTokenEvidence, readLaunchpadTokenRequest } from '../runtime/launchpadTokenEvidence';
import { verifyOrderTransaction } from '../orders/evidence';
async function main() {
  const [directory, output] = process.argv.slice(2); assert(directory && isAbsolute(directory));
  const cases: unknown[] = [], now = Date.now;
  try {
    for (const file of readdirSync(directory).filter(f => f.endsWith('-creator-complete.json')).sort()) {
      const bytes = readFileSync(join(directory, file)), c = JSON.parse(bytes.toString()), p = c.request, a = originalProductCaptureAdapter(c);
      Date.now = () => a.head.utime * 1000;
      const base = runtimeManifestFixture(), manifest = { ...base, network: 'ton:localnet' as const, releaseId: p.releaseId, manifestHash: p.manifestHash };
      assert.equal(Cell.fromBase64(c.artifacts.minter).hash().toString('hex'), manifest.templates.JettonV21Minter);
      assert.equal(Cell.fromBase64(c.artifacts.wallet).hash().toString('hex'), manifest.templates.JettonV21Wallet);
      const parsed = readLaunchpadTokenRequest(p, manifest), response = await collectLaunchpadTokenEvidence(manifest, a.source, a.store, parsed);
      assert(response.coverage.complete, JSON.stringify(response.coverage)); response.transactions.forEach(verifyOrderTransaction);
      assert(response.transactions.some(row => row.account === p.wallet && verifyOrderTransaction(row).succeeded));
      a.control.missingAccount = p.root;
      assert(!(await collectLaunchpadTokenEvidence(manifest, a.source, a.store, parsed)).coverage.complete); a.control.missingAccount = '';
      const wrong = readLaunchpadTokenRequest({ ...p, dispatch: { ...p.dispatch, hash: '0'.repeat(64) } }, manifest);
      assert(!(await collectLaunchpadTokenEvidence(manifest, a.source, a.store, wrong)).coverage.complete);
      const wrongWallet = readLaunchpadTokenRequest({ ...p, wallet: p.owner }, manifest);
      await assert.rejects(collectLaunchpadTokenEvidence(manifest, a.source, a.store, wrongWallet));
      const abort = new AbortController(); abort.abort(); await assert.rejects(collectLaunchpadTokenEvidence(manifest, a.source, a.store, parsed, abort.signal));
      cases.push({ file, sourceSha256: createHash('sha256').update(bytes).digest('hex'), request: p, manifest, refusedAccounts: a.refusedAccounts, response });
      console.log(file, 'complete original creator mint', response.transactions.length);
    }
    assert(cases.length > 0);
    if (output) { assert(isAbsolute(output)); writeFileSync(output, JSON.stringify({ schema: 'tonswap-native-creator-token-collector-test-v1',
      qualification: 'Unchanged original native cells and actual same-head observations under explicit synthetic source/head/release adapter. Installed minter/wallet bytes match current code pins. Not deployment/consensus authority.', directory, cases }, null, 2) + '\n', { flag: 'wx' }); }
  } finally { Date.now = now; }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

/** Original retained native cells under an explicit synthetic chain adapter.
 * No fixture envelope is manufactured or relabelled as live consensus. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Cell } from '@ton/core';
import { hashReleaseManifest } from '../config/runtimeManifest';
import { boundaryState } from '../runtime/physicalEvidence';
import { readOrderWalletClaimRequest, collectOrderWalletClaimEvidence } from '../runtime/orderWalletClaimEvidence';
import type { CurrentOrderSettlementSpotRequest } from '../runtime/spotOperationRequest';
import { verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { t3Attempt, t3PathRoot } from '../ledger/currentT3Wire';
import { originalOrderCreations, scopedSpotEvidenceManifest, spotEvidenceFixtureAdapter } from './current-spot-operation-evidence-test';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function main() {
  const path = process.argv[2], output = process.argv[3]; assert(path && isAbsolute(path));
  const bytes = readFileSync(path), capture = JSON.parse(bytes.toString());
  for (const artifact of Object.values(capture.artifacts) as any[]) {
    const original = readFileSync(artifact.file); assert.equal(sha(original), artifact.bocSha256);
    const roots = Cell.fromBoc(original); assert.equal(roots.length, 1); assert.equal(roots[0].hash().toString('hex'), artifact.codeHash);
  }
  const exported: unknown[] = [], originalNow = Date.now;
  let tested = 0, selectedClaims = 0;
  try {
    for (const [index, c] of capture.cases.entries() as IterableIterator<[number, any]>) {
      const rows = c.transactions as OrderTransactionEvidence[]; rows.forEach(verifyOrderTransaction);
      const manifest = scopedSpotEvidenceManifest(c.pool.address, c.pool.dataBoc, c.tokens);
      const factory = c.currentAccounts.find((r: any) => r.address === c.factory), order = c.currentAccounts.find((r: any) => r.address === c.order);
      manifest.contracts.SpotOrderFactory = { address: c.factory, codeHash: Cell.fromBase64(boundaryState(c.factory, factory.shardAccountBoc, 1).state.codeBoc!).hash().toString('hex') };
      manifest.templates.SpotOrder = Cell.fromBase64(boundaryState(c.order, order.shardAccountBoc, 1).state.codeBoc!).hash().toString('hex');
      manifest.orderKeeper = { address: c.keeper }; manifest.manifestHash = hashReleaseManifest(manifest);
      const request: CurrentOrderSettlementSpotRequest = { kind: 'order-settlement', network: 'localnet', releaseId: manifest.releaseId,
        manifestHash: manifest.manifestHash, owner: c.owner, factory: c.factory, order: c.order, nonce: c.nonce, pool: c.pool.address,
        inputRoot: c.tokens[c.side].root, termsBoc: c.termsBoc, termsHash: Cell.fromBase64(c.termsBoc).hash().toString('hex'), funding: c.funding, creations: originalOrderCreations(rows, c.factory, c.owner, c.nonce) };
      if (c.side !== 0) { assert.throws(() => readOrderWalletClaimRequest(request, manifest), { status: 400 }); continue; }
      if (!c.funding) continue; // An uncreated input wallet has no claim history.
      tested++; Date.now = () => c.now * 1000;
      const parsed = readOrderWalletClaimRequest(request, manifest), a = spotEvidenceFixtureAdapter(manifest, c.currentAccounts.filter((account: any) => {
        const state = boundaryState(account.address, account.shardAccountBoc, 1).state;
        // Unrelated x6 vendor-wallet library references are not part of this T3
        // recovery read; leave their original capture bytes intact.
        return !state.codeBoc || !Cell.fromBase64(state.codeBoc).isExotic;
      }), rows, c.now, c.getters);
      const response = await collectOrderWalletClaimEvidence(manifest, a.source, a.store, parsed);
      assert.equal(response.coverage.complete, true, `${index} ${c.scenario}: ${JSON.stringify(response.coverage)}`);
      assert.equal(response.order.address, c.order); assert.equal(response.wallet.address, c.wallets.orderPay);
      assert.deepEqual(response.request, { kind: 'order-settlement', owner: c.owner, order: c.order, nonce: c.nonce,
        termsHash: request.termsHash, fundingBodyHash: c.funding.bodyHash });
      assert.deepEqual(response.asOf, { masterchainSeqno: 1, unixTime: c.now, blockRootHash: '1'.repeat(64) });
      assert(response.claims.records.length <= 32 && response.claims.failures.length <= 32 && Buffer.byteLength(JSON.stringify(response)) <= 8 * 1024 * 1024);
      for (const record of response.claims.records) {
        const original = verifyOrderTransaction(record.transferTransaction);
        assert.equal(record.transferTransaction.account, c.wallets.orderPay); assert.equal(String(original.tx.lt), record.originLt);
        assert(!record.burn && record.owner === c.order);
        assert.equal(t3PathRoot(BigInt(record.id), Cell.fromBase64(record.recordBoc), Cell.fromBase64(record.proofBoc)).toString(16).padStart(64, '0'), response.claims.root);
        const attempt = t3Attempt(Cell.fromBase64(record.recordBoc).refs[0]);
        assert(record.failed || response.claims.failures.some(f => f.attemptHash === attempt.cell.hash().toString('hex')));
        selectedClaims++;
      }
      if (c.expectedClaimCount !== undefined) assert.equal(response.claims.records.length, c.expectedClaimCount);
      else if (!String(c.scenario).includes('recovery')) assert.equal(response.claims.records.length, 0, 'successful transfers do not become recovery candidates');
      for (const missingAccount of [c.order, c.wallets.orderPay, c.factory]) {
        a.control.missingAccount = missingAccount;
        const missing = await collectOrderWalletClaimEvidence(manifest, a.source, a.store, parsed);
        assert.equal(missing.coverage.complete, false, missingAccount); assert.equal(missing.claims.records.length, 0);
      }
      a.control.missingAccount = c.wallets.ownerReceive ?? c.wallets.owner?.[1];
      assert.equal((await collectOrderWalletClaimEvidence(manifest, a.source, a.store, parsed)).coverage.complete, true,
        'unrelated output history cannot gate the order input-wallet recovery proof');
      a.control.missingAccount = '';
      const changed = readOrderWalletClaimRequest({ ...request, funding: { ...request.funding!, hash: '0'.repeat(64) } }, manifest);
      const wrongFunding = await collectOrderWalletClaimEvidence(manifest, a.source, a.store, changed);
      assert(!wrongFunding.coverage.complete && wrongFunding.coverage.gaps.some(g => g.code === 'original_funding_dispatch_unobserved'));
      assert.equal(wrongFunding.claims.records.length, 0);
      const unfunded = await collectOrderWalletClaimEvidence(manifest, a.source, a.store, readOrderWalletClaimRequest({ ...request, funding: null }, manifest));
      assert(!unfunded.coverage.complete && unfunded.claims.records.length === 0);
      const before = a.control.reads; await collectOrderWalletClaimEvidence(manifest, a.source, a.store, parsed); assert(a.control.reads > before);
      await assert.rejects(collectOrderWalletClaimEvidence(manifest, a.source, a.store, parsed, AbortSignal.abort()), { name: 'AbortError' });
      exported.push({ index, scenario: c.scenario, request, manifest, response });
      console.log(index, c.scenario, 'records', response.claims.records.length, 'failures', response.claims.failures.length);
    }
    assert(tested > 0);
    if (output) { assert(isAbsolute(output)); writeFileSync(output, JSON.stringify({ schema: 'tonswap-order-wallet-claim-collector-test-v1',
      scope: 'Original native account/transaction facts, synthetic current-head and getter adapter. No live release qualification.',
      capturePath: path, captureSha256: sha(bytes), tested, selectedClaims, cases: exported }, null, 2) + '\n', { flag: 'wx' }); }
    console.log(`Order wallet claims: ${tested} original funded T3 cases, ${selectedClaims} selected current failed claims, release/head/current reads and missing-history/funding refusal passed.`);
  } finally { Date.now = originalNow; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

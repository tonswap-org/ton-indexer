/** Original sandbox facts; the source/getter adapter does not claim consensus. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { Cell } from '@ton/core';
import { hashReleaseManifest } from '../config/runtimeManifest';
import { boundaryState } from '../runtime/physicalEvidence';
import { collectSpotOperationEvidence } from '../runtime/spotOperationEvidence';
import { readSpotOperationRequest, type CurrentOrderSettlementSpotRequest } from '../runtime/spotOperationRequest';
import { verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { scopedSpotEvidenceManifest, spotEvidenceFixtureAdapter } from './current-spot-operation-evidence-test';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function main() {
  const path = process.argv[2], output = process.argv[3], selected = process.argv[4]?.split(',').map(Number); assert(path && isAbsolute(path));
  if (selected) assert(selected.length > 0 && selected.every(n => Number.isSafeInteger(n) && n >= 0));
  const bytes = readFileSync(path), capture = JSON.parse(bytes.toString());
  for (const artifact of Object.values(capture.artifacts) as any[]) {
    const original = readFileSync(artifact.file); assert.equal(sha(original), artifact.bocSha256);
    assert.equal(Cell.fromBoc(original)[0].hash().toString('hex'), artifact.codeHash);
  }
  const exported: unknown[] = [], originalNow = Date.now;
  try {
    for (const [index, c] of capture.cases.entries() as IterableIterator<[number, any]>) {
      if (selected && !selected.includes(index)) continue;
      const rows = c.transactions as OrderTransactionEvidence[]; rows.forEach(verifyOrderTransaction);
      const manifest = scopedSpotEvidenceManifest(c.pool.address, c.pool.dataBoc, c.tokens);
      const currentFactory = c.currentAccounts.find((row: any) => row.address === c.factory);
      const currentOrder = c.currentAccounts.find((row: any) => row.address === c.order);
      const factoryState = boundaryState(c.factory, currentFactory.shardAccountBoc, 1).state;
      const orderState = boundaryState(c.order, currentOrder.shardAccountBoc, 1).state;
      manifest.contracts.SpotOrderFactory = { address: c.factory, codeHash: Cell.fromBase64(factoryState.codeBoc!).hash().toString('hex') };
      manifest.templates.SpotOrder = Cell.fromBase64(orderState.codeBoc!).hash().toString('hex');
      manifest.orderKeeper = { address: c.keeper }; manifest.manifestHash = hashReleaseManifest(manifest);
      const request: CurrentOrderSettlementSpotRequest = { kind: 'order-settlement', network: 'localnet', releaseId: manifest.releaseId,
        manifestHash: manifest.manifestHash, owner: c.owner, factory: c.factory, order: c.order, nonce: c.nonce,
        pool: c.pool.address, inputRoot: c.tokens[c.side].root, termsBoc: c.termsBoc,
        termsHash: Cell.fromBase64(c.termsBoc).hash().toString('hex'), funding: c.funding };
      Date.now = () => c.now * 1000;
      const parsed = readSpotOperationRequest(request, manifest), a = spotEvidenceFixtureAdapter(manifest, c.currentAccounts, rows, c.now, c.getters);
      const response = await collectSpotOperationEvidence(manifest, a.source, a.store, parsed);
      assert.equal(response.coverage.complete, true, `${index} ${c.scenario}: ${JSON.stringify(response.coverage)}`);
      assert.equal(response.request.kind, 'order-settlement'); assert('absentAccounts' in response);
      assert(response.transactions.length <= 256 && response.accounts.length <= 16 && Buffer.byteLength(JSON.stringify(response)) <= 8 * 1024 * 1024);
      response.transactions.forEach(verifyOrderTransaction);
      assert(response.absentAccounts.every(address => !response.accounts.some(row => row.address === address)));
      if (c.scenario === 'unfunded-cancel') {
        assert.equal(request.funding, null);
        assert(response.absentAccounts.includes(c.wallets.orderPay));
        assert(!response.transactions.some(row => row.account === c.wallets.orderPay), 'absence does not invent a failed wallet transaction');
        a.control.unprovenAbsence = c.wallets.orderPay;
        const missingAbsence = await collectSpotOperationEvidence(manifest, a.source, a.store, parsed);
        assert(!missingAbsence.coverage.complete && missingAbsence.coverage.gaps.some(g => g.code === 'current_wallet_absence_unproven'));
        a.control.unprovenAbsence = '';
        const bounced = rows.find(row => { const tx = verifyOrderTransaction(row).tx; return row.account === c.order
          && tx.inMessage?.info.type === 'internal' && tx.inMessage.info.bounced && tx.inMessage.info.src.toRawString() === c.wallets.orderPay; });
        assert(bounced, 'native never-funded withdrawal retains an original order bounce');
        const bounce = verifyOrderTransaction(bounced); a.control.missingBoundary = `${c.order}:${bounce.tx.lt}:${bounce.hash}`;
        const missingBounce = await collectSpotOperationEvidence(manifest, a.source, a.store, parsed);
        assert(!missingBounce.coverage.complete, 'current absence cannot replace the original failed withdrawal bounce/history');
        a.control.missingBoundary = '';
      }
      if (c.funding) {
        const changed = readSpotOperationRequest({ ...request, funding: { ...request.funding!, hash: '0'.repeat(64) } }, manifest);
        const missing = await collectSpotOperationEvidence(manifest, a.source, a.store, changed);
        assert(!missing.coverage.complete && missing.coverage.gaps.some(g => g.code === 'original_funding_dispatch_unobserved'));
      }
      a.control.missingAccount = c.order;
      const missingHistory = await collectSpotOperationEvidence(manifest, a.source, a.store, parsed);
      assert(!missingHistory.coverage.complete, 'closed current state cannot replace missing original order history');
      a.control.missingAccount = '';
      exported.push({ index, scenario: c.scenario, side: c.side, slices: c.slices, request, manifest, response,
        expected: { initialOwnerBalances: c.initialOwnerBalances, finalOwnerBalances: c.finalOwnerBalances, state: c.state } });
      console.log(index, c.side, c.scenario, c.slices, response.transactions.length, response.absentAccounts.length);
    }
    if (selected) assert.equal(exported.length, new Set(selected).size, 'every requested original case must exist');
    if (output) { assert(isAbsolute(output)); writeFileSync(output, JSON.stringify({ schema: 'tonswap-native-order-collector-test-v1',
      qualification: 'Original native physical facts and actual observed getters under a synthetic current-head adapter. Original empty sandbox accounts exercise the proven-absence seam; no fabricated response envelope or live consensus claim.',
      capturePath: path, captureSha256: sha(bytes), cases: exported }, null, 2) + '\n', { flag: 'wx' }); }
    console.log('Current order-settlement collector native histories, exact funding dispatch and missing-history refusal passed.');
  } finally { Date.now = originalNow; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

import assert from 'node:assert/strict';
import { decodeCurrentLaunchpadOperations } from '../ledger/currentLaunchpad';
import { currentLaunchpadBindingFromManifest, verifyLaunchpadTransaction } from '../ledger/currentLaunchpadProof';
import { projectOwnerLedger } from '../ledger/project';
import { currentLaunchpadCaptures } from './support/currentLaunchpadCaptures';
import { currentLaunchpadProjectionFixture } from './support/currentLaunchpadFixture';

async function main() {
  let checks = 0;
  for (const { file, capture: c, requests, refund } of currentLaunchpadCaptures()) {
    const binding = currentLaunchpadBindingFromManifest(c.release), rows = c.completeTransactions;
    for (const owner of new Set<string>(requests.map(r => r.owner))) {
      const operations = decodeCurrentLaunchpadOperations(owner, binding, rows);
      const expected = requests.filter(r => r.owner === owner);
      for (const request of expected) {
        if (refund) continue;
        const op = operations.find(o => o.economics.dispatch.hash === request.dispatch.hash && o.economics.requestBodyHash === request.bodyHash);
        assert(op, `${file}: original ${request.kind} dispatch`); const e = op.economics;
        assert.equal(e.outcome, 'delivered', `${file}: ${e.kind}: ${e.issues}`);
        if (e.kind === 'contribute') { assert.equal(e.contributionRaw, request.amountRaw); assert(BigInt(e.allocationAcquiredRaw) > 0n); }
        if (e.kind === 'claim') assert(BigInt(e.allocationRetiredRaw) > 0n);
        if (e.kind === 'lp-seed' || e.kind === 'lp-release') assert(e.lpShares.length > 0);
        assert.equal(new Set(e.cash.map(l => l.root + ':' + l.debitTransaction)).size, e.cash.length);
        checks++;
        if (file === 'complete/0-default-complete.json') {
          const select = (evidence: typeof rows, b = binding) => decodeCurrentLaunchpadOperations(owner, b, evidence).find(o => o.economics.dispatch.hash === request.dispatch.hash && o.economics.requestBodyHash === request.bodyHash);
          assert(!select(rows.filter((row: any) => verifyLaunchpadTransaction(row).hash !== request.dispatch.hash))); checks++;
          const wrong = structuredClone(binding); wrong.manifest.contracts.SaleFactory!.codeHash = '00'.repeat(32);
          const mismatch = select(rows, wrong); assert(!mismatch || mismatch.economics.outcome === 'unresolved'); checks++;
          for (const leg of e.cash) for (const hash of [leg.debitTransaction, leg.creditTransaction]) {
            const missing = select(rows.filter((row: any) => verifyLaunchpadTransaction(row).hash !== hash));
            assert(!missing || missing.economics.outcome === 'unresolved' || Object.values(missing.economics.pendingOut).some(v => v !== '0'), `${e.kind}: missing original financial boundary`);
            assert(!missing?.economics.cash.some(l => l.debitTransaction === leg.debitTransaction && l.creditTransaction === leg.creditTransaction)); checks++;
          }
        }
      }
      if (refund) {
        console.log(file, owner, operations.map(o => ({ kind: o.economics.kind, outcome: o.economics.outcome, in: o.economics.paidIn, out: o.economics.paidOut, issues: o.economics.issues })));
        const claims = operations.filter(o => o.economics.kind === 'claim');
        for (const { economics: e } of claims) { assert.equal(e.outcome, 'refunded'); assert.equal(e.contributionRetiredRaw, '5000000000'); assert.equal(e.paidOut[c.bindings.t3Root], e.contributionRetiredRaw); checks++; }
      }
      if (file.endsWith('-default-complete.json')) {
        const input = currentLaunchpadProjectionFixture({ ...c, binding, request: { owner } });
        const projected = await projectOwnerLedger(input);
        for (const { economics: e } of operations.filter(o => ['delivered', 'refunded'].includes(o.economics.outcome))) {
          const event = projected.events.find(event => event.settlement?.currentLaunchpad?.dispatch.hash === e.dispatch.hash && event.settlement.currentLaunchpad.requestBodyHash === e.requestBodyHash);
          assert(event, `${file}: ordinary projection ${e.kind}`);
          assert.equal(event.settlement!.status, 'confirmed', `${file}: ${e.kind}: ${event.issues}`);
          const actual = event.movements.filter(m => m.asset.kind === 'jetton');
          for (const root of new Set([...Object.keys(e.paidIn), ...Object.keys(e.paidOut)])) for (const direction of ['in', 'out'] as const) {
            const total = actual.filter(m => m.asset.master === root && m.direction === direction).reduce((v, m) => v + BigInt(m.amountRaw!), 0n);
            assert.equal(String(total), (direction === 'in' ? e.paidOut : e.paidIn)[root] ?? '0', `${file}: ${e.kind} ${direction} ${root}: physical cash exactly once`);
          }
          assert(!event.issues.includes('multiple_protocol_operations_grouped')); checks++;
        }
        if (file === 'complete/0-default-complete.json' && expected.some(r => r.kind === 'contribute')) {
          const missing = await projectOwnerLedger({ ...input, stateAt: async () => null });
          assert(!missing.events.some(e => e.settlement?.currentLaunchpad && e.settlement.status === 'confirmed')); checks++;
          const noT3 = await projectOwnerLedger({ ...input, t3Hubs: new Map() });
          assert(!noT3.events.some(e => e.settlement?.currentLaunchpad?.kind === 'contribute' && e.settlement.status === 'confirmed')); checks++;
        }
      }
    }
    console.log(file, 'passed');
  }
  console.log(`Current Launchpad: ${checks} original owner, economics, physical cash and missing-evidence checks passed.`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });

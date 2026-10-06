import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Address, Cell, Dictionary, beginCell, loadTransaction } from '@ton/core';
import { decodeOriginalTransaction } from '../data/transactionEvidence';
import { projectOwnerLedger, type ProjectionInput, type LedgerChain, type Node } from '../ledger/project';
import { canonicalLedgerHash } from '../ledger/normalize';
import { perpsPending, readPerpsState, type PerpsOracleTradeOrder } from '../ledger/perpsState';
import { loadOpcodes } from '../utils/opcodes';
import { perpsWalletAddress, perpsMessage, perpsTransferKey } from '../ledger/perpsWire';
import { businessOpcode as opcode, messageKey } from '../ledger/wire';
import { readPerpsOracleExecution, type PerpsBoundary } from '../ledger/perpsOracle';
import { perpsRiskFixtureFolder, readPerpsRiskFixtureProvenance } from './perps-risk-fixture';

const folder = perpsRiskFixtureFolder;
const provenance = readPerpsRiskFixtureProvenance();

// Unmodified raw transactions and before/after storage emitted by the actual
// Tolk engine, DLMM, RiskVault, RiskController and owner/product T3 wallets.
function fixture(name: string) {
  const bytes = readFileSync(join(folder, `${name}.json`));
  const original = provenance.artifacts.find((entry: { relative: string }) => entry.relative === `${name}.json`);
  assert(original, 'Every execution case identifies its unchanged original capture');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), original.sha256);
  const f = JSON.parse(bytes.toString('utf8'));
  for (const key of ['engine', 'owner', 'pool', 'root', 'riskVault', 'riskController']) f[key] = Address.parse(f[key]).toRawString();
  f.ownerWallet = perpsWalletAddress(Cell.fromBase64(f.walletCode), f.root, f.owner);
  f.engineWallet = perpsWalletAddress(Cell.fromBase64(f.walletCode), f.root, f.engine);
  f.rvWallet = perpsWalletAddress(Cell.fromBase64(f.walletCode), f.root, f.riskVault);
  const code = new Map([[f.engine, f.engineCode], [f.riskVault, f.riskVaultCode], [f.riskController, f.riskControllerCode], [f.pool, f.poolCode],
    [f.ownerWallet, f.walletCode], [f.engineWallet, f.walletCode], [f.rvWallet, f.walletCode]]);
  const rows = f.transactions.map((saved: any) => {
    const cell = Cell.fromBase64(saved.transaction), tx = loadTransaction(cell.beginParse());
    const account = `0:${tx.address.toString(16).padStart(64, '0')}`;
    return { ...saved, account, raw: decodeOriginalTransaction(cell, Address.parse(account)) };
  });
  const captured = new Map(rows.map((row: any) => [`${row.account}:${row.raw.lt}`, row.raw.hash]));
  assert.equal(captured.size, rows.length, 'Each original transaction is captured once');
  for (const row of rows) {
    const prior = captured.get(`${row.account}:${row.raw.prevTransactionLt}`);
    // Traces are explicitly bounded, so a predecessor may precede the capture.
    // Where both cells are present, reserialization cannot replace original bytes.
    if (prior) assert.equal(canonicalLedgerHash(row.raw.prevTransactionHash), canonicalLedgerHash(prior as string), 'Captured raw BOCs retain original account hash links');
  }
  const fromUtime = Math.min(...rows.map((row: any) => row.raw.utime)), toUtime = Math.max(...rows.map((row: any) => row.raw.utime)) + 1;
  const chains = new Map<string, LedgerChain>();
  const states = new Map<string, any>();
  const key = (account: string, lt: string, hash: string) => `${account}:${lt}:${canonicalLedgerHash(hash)}`;
  for (const row of rows) {
    const chain: LedgerChain = chains.get(row.account) ?? { account: row.account, generation: 'real-tolk-oracle', historyComplete: false,
      verifiedRange: { fromUtime, toUtime }, role: row.account === f.owner ? 'owner' : row.account === f.ownerWallet ? 'owned_jetton_wallet' : 'counterparty', transactions: [] };
    chain.transactions.push(row.raw); chains.set(row.account, chain);
    if (code.has(row.account)) {
      for (const [lt, hash, data] of [[row.raw.prevTransactionLt, row.raw.prevTransactionHash, row.oldStorage], [row.raw.lt, row.raw.hash, row.newStorage]]) {
        const identity = key(row.account, lt, hash);
        const snapshot = { seqno: Number(BigInt(lt) / 1000000n), state: { accountState: 'active', codeBoc: code.get(row.account), dataBoc: data,
          lastTxLt: lt, lastTxHash: canonicalLedgerHash(hash) } };
        if (states.has(identity)) assert.equal(states.get(identity).state.dataBoc, data, 'Adjacent real engine boundaries must agree');
        states.set(identity, snapshot);
      }
    }
  }
  const wallets = new Map([f.ownerWallet, f.engineWallet, f.rvWallet].map(wallet => [wallet, { kind: 'jetton' as const,
    id: `localnet:jetton:${f.root}`, master: f.root, owner: wallet === f.ownerWallet ? f.owner : wallet === f.rvWallet ? f.riskVault : f.engine, wallet, decimals: 9 }]));
  const engineCodeHash = Cell.fromBase64(f.engineCode).hash().toString('hex');
  assert.equal(engineCodeHash, provenance.engineCodeHash, 'Every execution fixture must use the same current compiled runtime identity');
  assert.equal(Cell.fromBase64(f.poolCode).hash().toString('hex'), provenance.poolCodeHash,
    'Every execution fixture must use the same current compiled pool identity');
  const input: ProjectionInput = { network: 'localnet', owner: f.owner, chains, wallets, pools: new Map(), opcodes: loadOpcodes(),
    stateAt: async (account, lt, hash) => states.get(key(account, lt, hash)) ?? null,
    perpsEngines: new Map([[f.engine, { address: f.engine, root: f.root, codeHash: engineCodeHash,
      walletCodeHash: Cell.fromBase64(f.walletCode).hash().toString('hex'), ownerWallet: f.ownerWallet, engineWallet: f.engineWallet }]]) };
  return { f, rows, states, input, engineCodeHash };
}

function pendingOracleFixture(name: string, requestOpcode: number) {
  const { f, rows, engineCodeHash } = fixture(name);
  const row = rows.find((value: any) => value.account === f.engine && opcode(value.raw.inMessage) === requestOpcode);
  assert(row);
  const nodes: Node[] = rows.map((value: any) => ({ account: value.account, raw: value.raw,
    id: `${value.account}:${value.raw.lt}:${canonicalLedgerHash(value.raw.hash)}` }));
  const original = nodes.find(node => node.raw === row.raw)!;
  const before = readPerpsState(row.oldStorage, engineCodeHash), after = readPerpsState(row.newStorage, engineCodeHash);
  const request = perpsMessage(row.raw.inMessage)!;
  const order = after.oracleRefreshes.get(request.marketId)!.get(f.owner)!.order!;
  const intake: PerpsBoundary = { before, after, evidence: { kind: 'perps_account_delta',
    stateBeforeHash: before.dataHash, stateAfterHash: after.dataHash, beforeSeqno: 1, afterSeqno: 2, transactions: [] } };
  return { f, request, order, intake, read: () => readPerpsOracleExecution({ owner: f.owner, ownerWallet: f.ownerWallet, engine: f.engine,
    request, original, intake, engineNodes: [], boundary: async () => null,
    receiptFor: (node, index) => {
      const key = messageKey(node.raw.outMessages[index]);
      const matches = key ? nodes.filter(candidate => messageKey(candidate.raw.inMessage) === key) : [];
      return matches.length === 1 ? matches[0] : null;
    } }) };
}

async function main() {
  for (const name of ['open-accepted', 'vault-rejected', 'policy-rejected', 'modify-accepted', 'profitable-close', 'gap-close', 'failed-close',
    'funding-claim-accepted', 'funding-claim-rejected', 'funding-claim-close']) {
    const { f, input } = fixture(name);
    const result = await projectOwnerLedger(input);
    const event = result.events.find(event => event.kind === 'perps_operation');
    assert(event?.settlement?.perps, `${name}: original operation absent`);
    const meta = event.settlement.perps;
    if (name === 'failed-close') {
      assert.equal(event.settlement.status, 'confirmed');
      assert.equal(meta.execution?.status, 'failed');
      assert.equal(meta.outcome, 'rejected');
      assert.equal(meta.counterpartyPayout.status, 'none');
      assert(!event.movements.some(m => m.purpose === 'perps_counterparty_profit'));
      if (process.env.PERPS_ORACLE_LEDGER_EXPORT_DIR) writeFileSync(join(process.env.PERPS_ORACLE_LEDGER_EXPORT_DIR, `${name}-ledger.json`),
        JSON.stringify({ ...f, events: result.events }, null, 2));
      console.log('PASS real Tolk failed-close: original VM rejection with no fabricated profit payment');
      continue;
    }
    assert.equal(event.settlement.status, 'confirmed', `${name}: ${JSON.stringify(event.settlement)}`);
    const accepted = name.endsWith('accepted') || name.endsWith('close');
    assert.equal(meta.outcome, accepted ? 'accepted' : 'rejected');
    assert.equal(meta.oracleExecution?.status, meta.outcome);
    assert(meta.oracleExecution?.completed);
    assert.notEqual(meta.oracleExecution.completed.lt, meta.oracleExecution.queued.lt);
    assert.deepEqual(meta.stateEvidence?.transactions, [meta.oracleExecution.completed]);
    assert.deepEqual(meta.oracleExecution.intakeEvidence?.transactions, [meta.oracleExecution.queued]);
    if (name.startsWith('funding-claim-')) {
      assert.equal(meta.request.operation, 'claim');
      assert.equal(meta.depositRaw, '0');
      assert(meta.oracleExecution.intake.position, 'Funding claims retain their original position at intake');
      if (accepted) {
        assert.equal(meta.counterpartyPayout.status, 'completed', 'Funding is paid from separately verified LP custody');
        assert(BigInt(meta.counterpartyPayout.amountRaw) > 0n);
        assert.equal(meta.counterpartyPayout.proof?.beneficiaryWallet, f.ownerWallet);
        const profit = event.movements.filter(m => m.purpose === 'perps_counterparty_profit');
        assert.equal(profit.length, 1);
        assert.equal(profit[0].amountRaw, meta.counterpartyPayout.amountRaw);
        if (name === 'funding-claim-accepted') {
          assert(meta.after?.position);
          assert.equal(meta.after.position.marginRaw, meta.before?.position?.marginRaw);
          assert.equal(meta.after.account.collateralRaw, meta.before?.account.collateralRaw);
          assert.equal(meta.payout.status, 'none', 'LP funding is not a second refund of trader margin');
        } else {
          assert.equal(meta.after?.position, null);
          assert.equal(meta.payout.status, 'completed', 'Exhausted-counterparty close separately returns trader margin');
        }
      } else {
        assert.equal(meta.oracleExecution.reason, 2);
        assert.equal(meta.payout.status, 'none');
        assert.equal(meta.counterpartyPayout.status, 'none');
        assert.deepEqual(meta.before?.position, meta.after?.position);
        assert.deepEqual(meta.before?.account, meta.after?.account);
        assert(!event.movements.some(m => m.purpose === 'perps_counterparty_profit'));
      }
    } else if (name.endsWith('close')) {
      assert.equal(meta.counterpartyPayout.status, 'completed', `${name}: LP claim requires actual separate wallet delivery`);
      assert(BigInt(meta.counterpartyPayout.amountRaw) > 0n);
      assert.equal(meta.counterpartyPayout.proof?.beneficiaryWallet, f.ownerWallet);
      assert.equal(meta.payout.status, 'completed');
      const profit = event.movements.filter(m => m.purpose === 'perps_counterparty_profit');
      assert.equal(profit.length, 1);
      assert.equal(profit[0].amountRaw, meta.counterpartyPayout.amountRaw);
    } else if (name === 'modify-accepted') {
      assert(meta.oracleExecution.intake.position, 'Modify preserves the original funded position');
      assert.equal(meta.depositRaw, '0');
    } else {
      const debits = event.movements.filter(m => m.asset.kind === 'jetton' && ['out', 'fee'].includes(m.direction));
      assert.equal(debits.reduce((sum, m) => sum + BigInt(m.amountRaw), 0n).toString(), meta.depositRaw,
        'The operation binds the actual original wallet debit without adding fictitious token outflows');
      if (!accepted) {
        assert.equal(meta.payout.status, 'completed');
        assert.equal(meta.payout.amountRaw, meta.depositRaw);
        assert.equal(meta.oracleExecution.reason, 8);
      }
    }
    if (process.env.PERPS_ORACLE_LEDGER_EXPORT_DIR) writeFileSync(join(process.env.PERPS_ORACLE_LEDGER_EXPORT_DIR, `${name}-ledger.json`),
      JSON.stringify({ ...f, events: result.events }, null, 2));
    console.log(`PASS real Tolk ${name}: original wallet debit, exact oracle/vault/policy continuation and terminal economics`);
  }
  for (const terminalKind of [12, 10]) {
    const { f, input, rows, states, engineCodeHash } = fixture('vault-rejected');
    const finalizers = rows.filter((row: any) => row.account === f.engine && opcode(row.raw.inMessage) === 0x4a53464b
      && perpsPending(readPerpsState(row.oldStorage, engineCodeHash), f.ownerWallet)?.kind === 12
      && !perpsPending(readPerpsState(row.newStorage, engineCodeHash), f.ownerWallet));
    assert.equal(finalizers.length, 1, 'Current native refund has one exact kind12-to-cleared engine finalizer');
    const finalizer = finalizers[0];
    if (terminalKind === 10) {
      // Adversarial historical-state substitution only: retain every original native
      // transaction and cash ACK while replacing the terminal refund journal kind.
      const original = Cell.fromBase64(finalizer.oldStorage), queues = original.refs[2];
      const rawValue = {
        serialize: (value: Cell, builder: any) => builder.storeSlice(value.beginParse()),
        parse: (slice: any) => { const value = slice.asCell(); slice.skip(slice.remainingBits); while (slice.remainingRefs) slice.loadRef(); return value; },
      };
      const transfers = queues.refs[1].beginParse().loadDict(Dictionary.Keys.BigUint(256), rawValue);
      const key = BigInt('0x' + perpsTransferKey(f.ownerWallet)), value = transfers.get(key)!;
      assert(value); const transfer = value.beginParse(); assert.equal(transfer.loadUint(8), 12);
      transfers.set(key, beginCell().storeUint(terminalKind, 8).storeSlice(transfer).endCell());
      const withRefs = (cell: Cell, refs: readonly Cell[]) => {
        const builder = beginCell().storeBits(cell.bits); for (const ref of refs) builder.storeRef(ref); return builder.endCell();
      };
      const substituted = withRefs(original, [original.refs[0], original.refs[1],
        withRefs(queues, [queues.refs[0], beginCell().storeDict(transfers).endCell(), queues.refs[2]]), original.refs[3]]).toBoc().toString('base64');
      const snapshot = states.get(`${f.engine}:${finalizer.raw.prevTransactionLt}:${canonicalLedgerHash(finalizer.raw.prevTransactionHash)}`);
      assert(snapshot); snapshot.state.dataBoc = substituted;
      assert.equal(perpsPending(readPerpsState(substituted, engineCodeHash), f.ownerWallet)?.kind, 10);
    }
    const result = await projectOwnerLedger(input);
    const event = result.events.find(event => event.kind === 'perps_operation');
    assert(event?.settlement?.perps);
    const payout = event.settlement.perps.payout;
    assert.equal(payout.amountRaw, event.settlement.perps.depositRaw, 'Both witnesses retain the same original physical refund amount');
    assert.equal(payout.status, terminalKind === 12 ? 'completed' : 'pending',
      'Only the current native success-finalizing kind12 proves that the original refund journal cleared');
    if (terminalKind === 10) {
      assert.deepEqual(payout.evidence, []);
      assert(event.issues.includes('perps_payout_settlement_pending'));
      assert(!event.movements.some(m => m.purpose === 'perps_payout'));
    } else assert(payout.evidence.length > 0);
  }
  for (const missingOpcode of [0x5256414b, 0x52505253]) {
    const { f, input, rows, states } = fixture('open-accepted');
    const callback = rows.find((row: any) => row.account === f.engine && opcode(row.raw.inMessage) === missingOpcode)!;
    assert(callback);
    for (const [key, value] of states) if (value.state.lastTxLt === callback.raw.lt) states.delete(key);
    const result = await projectOwnerLedger(input);
    assert(!result.events.some(event => event.kind === 'perps_operation' && event.settlement?.status === 'confirmed'),
      'A missing independently qualified risk response boundary never becomes a confirmed operation');
  }
  for (const name of ['profitable-close', 'funding-claim-accepted', 'funding-claim-close']) {
   for (const defect of ['missing-beneficiary-history', 'missing-vault-journal', 'forged-hook'] as const) {
    const { f, input, rows, states } = fixture(name);
    if (defect === 'missing-beneficiary-history') input.chains.delete(f.ownerWallet);
    else if (defect === 'missing-vault-journal') {
      for (const [key] of states) if (key.startsWith(`${f.riskVault}:`)) states.delete(key);
    } else {
      const hook = rows.find((row: any) => row.account === f.engine && opcode(row.raw.inMessage) === 0x52565048);
      assert(hook); hook.raw.inMessage.source = f.owner;
    }
    const result = await projectOwnerLedger(input);
    assert(!result.events.some(e => e.settlement?.perps?.counterpartyPayout.status === 'completed'),
      `${name}/${defect}: reserved claim and engine margin are insufficient evidence of an LP payment`);
   }
  }
  for (const defect of ['missing-oracle-boundary', 'missing-pool-history', 'wrong-owner'] as const) {
    const { f, input, rows, states } = fixture('funding-claim-accepted');
    const callback = rows.find((row: any) => row.account === f.engine && opcode(row.raw.inMessage) === 0x50525043);
    assert(callback);
    if (defect === 'missing-oracle-boundary') {
      for (const [key, value] of states) if (value.state.lastTxLt === callback.raw.lt) states.delete(key);
    } else if (defect === 'missing-pool-history') input.chains.delete(f.pool);
    else {
      const intake = rows.find((row: any) => row.account === f.engine && opcode(row.raw.inMessage) === 0x43464e47);
      assert(intake); intake.raw.inMessage.source = f.pool;
    }
    const result = await projectOwnerLedger(input);
    assert(!result.events.some(event => event.kind === 'perps_operation' && event.settlement?.status === 'confirmed'),
      `${defect}: a funding claim needs its exact owner and independent oracle execution`);
  }
  for (const defect of ['none', 'wrong-correlation', 'wrong-refund-owner', 'wrong-refund-kind', 'missing-context'] as const) {
    const { f, order, read } = pendingOracleFixture('funding-claim-accepted', 0x43464e47);
    assert(order.positionOracleContext);
    if (defect === 'missing-context') order.positionOracleContext = null;
    else if (defect !== 'none') {
      const sponsor = order.positionOracleContext.sponsor;
      if (defect === 'wrong-correlation') sponsor.correlationId = (BigInt(sponsor.correlationId) + 1n).toString();
      if (defect === 'wrong-refund-owner') sponsor.refundTo = f.pool;
      if (defect === 'wrong-refund-kind') { sponsor.refundKind = 1; sponsor.moduleId = 405; }
      order.previousPosition = beginCell().storeUint(BigInt(`0x${order.positionOracleContext.positionHash}`), 256)
        .storeRef(beginCell().storeUint(BigInt(sponsor.correlationId), 64).storeUint(sponsor.refundKind, 8)
          .storeUint(sponsor.moduleId, 32).storeAddress(Address.parse(sponsor.refundTo))).endCell();
    }
    const result = await read();
    if (defect === 'none') {
      assert(result, 'The authentic direct funding claim is pending before its callback');
      assert.equal(result.execution, null);
    } else assert.equal(result, null, `${defect}: a direct claim cannot borrow another native payer context`);
  }
  // Synthetic intake boundaries exercise the native owner's narrow right to
  // replace pending maintenance. The original CLOSE wire remains unchanged.
  for (const defect of ['none', 'same-wire', 'ordinary-order', 'completed-oracle', 'claim-order', 'missing-context'] as const) {
    const { f, request, intake, read } = pendingOracleFixture('profitable-close', 0x434c4f53);
    const pending = intake.after.oracleRefreshes.get(request.marketId)!.get(f.owner)!;
    const previousOrder: PerpsOracleTradeOrder = { ...pending.order!, reason: 1,
      previousPosition: beginCell().storeUint(BigInt(`0x${'01'.repeat(32)}`), 256)
        .storeRef(beginCell().storeUint(1, 64).storeUint(0, 8).storeUint(0, 32).storeAddress(Address.parse(f.owner))).endCell(),
      positionOracleContext: { positionHash: '01'.repeat(32), sponsor: { correlationId: '1', refundKind: 0, moduleId: 0, refundTo: f.owner } } };
    const previous = { ...pending, wireQueryId: (BigInt(pending.wireQueryId) - 1n).toString(), order: previousOrder };
    if (defect === 'same-wire') previous.wireQueryId = pending.wireQueryId;
    if (defect === 'ordinary-order') previous.order.reason = 0;
    if (defect === 'completed-oracle') previous.status = 2;
    if (defect === 'claim-order') previous.order.request = { ...previous.order.request, operation: 'claim', opcode: 0x43464e47 };
    if (defect === 'missing-context') previous.order.positionOracleContext = null;
    intake.before.oracleRefreshes.get(request.marketId)!.set(f.owner, previous);
    const result = await read();
    if (defect === 'none') assert(result, 'Owner CLOSE supersedes maintenance even when the business query ID is the same');
    else assert.equal(result, null, `${defect}: only a distinct wire can supersede pending maintenance`);
  }
  console.log('PASS missing beneficiary custody, missing vault journal and forged RVPH never complete a counterparty payment');
  console.log('PASS missing vault/policy historical boundaries remain unresolved');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

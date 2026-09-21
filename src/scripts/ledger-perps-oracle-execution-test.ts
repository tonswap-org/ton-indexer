import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Address, Cell, beginCell, loadTransaction } from '@ton/core';
import { decodeOriginalTransaction } from '../data/transactionEvidence';
import { projectOwnerLedger, type ProjectionInput, type LedgerChain } from '../ledger/project';
import { canonicalLedgerHash } from '../ledger/normalize';
import { readPerpsState } from '../ledger/perpsState';
import { loadOpcodes } from '../utils/opcodes';
import { perpsWalletAddress } from '../ledger/perpsWire';
import { opcode } from '../ledger/wire';

const provenance = JSON.parse(readFileSync(join(__dirname, 'fixtures/perps-risk-admission-current/provenance.json'), 'utf8'));

// Unmodified raw transactions and before/after storage emitted by the actual
// Tolk engine, DLMM, RiskVault, RiskController and owner/product T3 wallets.
function fixture(name: string) {
  const bytes = readFileSync(join(__dirname, 'fixtures/perps-risk-admission-current', `${name}.json`));
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
async function main() {
  for (const name of ['open-accepted', 'vault-rejected', 'policy-rejected', 'modify-accepted', 'profitable-close', 'gap-close', 'failed-close']) {
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
    if (name.endsWith('close')) {
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
  for (const missingOpcode of [0x5256414b, 0x52505253]) {
    const { f, input, rows, states } = fixture('open-accepted');
    const callback = rows.find((row: any) => row.account === f.engine && opcode(row.raw.inMessage) === missingOpcode)!;
    assert(callback);
    for (const [key, value] of states) if (value.state.lastTxLt === callback.raw.lt) states.delete(key);
    const result = await projectOwnerLedger(input);
    assert(!result.events.some(event => event.kind === 'perps_operation' && event.settlement?.status === 'confirmed'),
      'A missing independently qualified risk response boundary never becomes a confirmed operation');
  }
  for (const defect of ['missing-beneficiary-history', 'missing-vault-journal', 'forged-hook'] as const) {
    const { f, input, rows, states } = fixture('profitable-close');
    if (defect === 'missing-beneficiary-history') input.chains.delete(f.ownerWallet);
    else if (defect === 'missing-vault-journal') {
      for (const [key] of states) if (key.startsWith(`${f.riskVault}:`)) states.delete(key);
    } else {
      const hook = rows.find((row: any) => row.account === f.engine && opcode(row.raw.inMessage) === 0x52565048);
      assert(hook); hook.raw.inMessage.source = f.owner;
    }
    const result = await projectOwnerLedger(input);
    assert(!result.events.some(e => e.settlement?.perps?.counterpartyPayout.status === 'completed'),
      `${defect}: reserved claim and engine margin are insufficient evidence of an LP payment`);
  }
  console.log('PASS missing beneficiary custody, missing vault journal and forged RVPH never complete a counterparty payment');
  console.log('PASS missing vault/policy historical boundaries remain unresolved');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

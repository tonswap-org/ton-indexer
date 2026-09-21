import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Address, Cell, loadTransaction } from '@ton/core';
import { decodeOriginalTransaction } from '../data/transactionEvidence';
import { readPerpsState } from '../ledger/perpsState';
import { readPerpsOracleExecution, type PerpsBoundary } from '../ledger/perpsOracle';
import { perpsWalletAddress } from '../ledger/perpsWire';
import { messageKey, opcode } from '../ledger/wire';
import type { Node } from '../ledger/project';

const folder = join(__dirname, 'fixtures/perps-risk-admission-current');
const provenance = JSON.parse(readFileSync(join(folder, 'provenance.json'), 'utf8'));

function fixture(name: string) {
  const f = JSON.parse(readFileSync(join(folder, `${name}.json`), 'utf8'));
  for (const key of ['engine', 'owner', 'pool', 'root', 'riskVault', 'riskController']) f[key] = Address.parse(f[key]).toRawString();
  const hash = Cell.fromBase64(f.engineCode).hash().toString('hex');
  assert.equal(hash, provenance.engineCodeHash);
  const boundaries = new Map<string, PerpsBoundary>();
  const nodes: Node[] = f.transactions.map((saved: any) => {
    const cell = Cell.fromBase64(saved.transaction), tx = loadTransaction(cell.beginParse());
    const account = new Address(0, Buffer.from(tx.address.toString(16).padStart(64, '0'), 'hex')).toRawString();
    const raw = decodeOriginalTransaction(cell, Address.parse(account));
    const id = `${account}:${raw.lt}:${raw.hash}`;
    if (account === f.engine) {
      const before = readPerpsState(saved.oldStorage, hash), after = readPerpsState(saved.newStorage, hash);
      boundaries.set(id, { before, after, evidence: { kind: 'perps_account_delta',
        stateBeforeHash: before.dataHash, stateAfterHash: after.dataHash,
        beforeSeqno: 0, afterSeqno: 1, transactions: [] } });
    }
    return { account, raw, id };
  });
  const incoming = new Map<string, Node[]>();
  for (const node of nodes) {
    const key = messageKey(node.raw.inMessage);
    if (key) incoming.set(key, [...incoming.get(key) ?? [], node]);
  }
  const receiptFor = (node: Node, index: number) => {
    const key = messageKey(node.raw.outMessages[index]), rows = key ? incoming.get(key) : null;
    return rows?.length === 1 ? rows[0] : null;
  };
  const engineNodes = nodes.filter(node => node.account === f.engine);
  const original = engineNodes.find(node => {
    const states = boundaries.get(node.id)!;
    return [...states.after.oracleRefreshes].some(([marketId, rows]) => {
      const next = rows.get(f.owner), previous = states.before.oracleRefreshes.get(marketId)?.get(f.owner);
      return next?.order?.outcome === 1 && next.status === 1 && next.wireQueryId !== previous?.wireQueryId;
    });
  });
  assert(original, 'Actual engine intake created a new pending receipt');
  const intake = boundaries.get(original.id)!;
  const request = [...intake.after.oracleRefreshes.values()].map(rows => rows.get(f.owner)).find(row => row?.order?.outcome === 1)!.order!.request;
  return { f, nodes, boundaries, args: { engine: f.engine, owner: f.owner,
    ownerWallet: perpsWalletAddress(Cell.fromBase64(f.walletCode), f.root, f.owner), request,
    original, intake, engineNodes, receiptFor,
    boundary: async (node: Node) => boundaries.get(node.id) ?? null } };
}

async function main() {
  for (const name of ['open-accepted', 'vault-rejected', 'policy-rejected', 'modify-accepted']) {
    const { args } = fixture(name);
    const result = await readPerpsOracleExecution(args);
    assert(result?.execution, `${name}: actual risk continuation is independently proven`);
    assert.equal(result.receipt.order!.outcome, name.endsWith('accepted') ? 2 : 3);
    assert.equal(opcode(result.execution.raw.inMessage), name === 'vault-rejected' ? 0x52564e4b : 0x52505253);
    assert(result.nodes.some(node => node.account === args.intake.after.riskVault), 'Exact vault transaction is included');
    console.log(`PASS ${name}: exact pool, funded vault reservation, policy response and terminal state`);
  }
  for (const target of ['vault', 'controller'] as const) {
    for (const defect of ['missing', 'foreign-sender', 'wrong-body', 'failed', 'missing-state'] as const) {
      const { args, nodes, boundaries } = fixture('open-accepted');
      const callback = nodes.find(node => node.account === args.engine && opcode(node.raw.inMessage) ===
        (target === 'vault' ? 0x5256414b : 0x52505253))!;
      assert(callback);
      if (defect === 'missing') {
        const originalReceipt = args.receiptFor;
        args.receiptFor = (node, index) => { const match = originalReceipt(node, index); return match?.id === callback.id ? null : match; };
      } else if (defect === 'foreign-sender') callback.raw.inMessage!.source = args.owner;
      else if (defect === 'wrong-body') callback.raw.inMessage!.body = Cell.EMPTY.toBoc().toString('base64');
      else if (defect === 'failed') callback.raw.success = false;
      else boundaries.delete(callback.id);
      const result = await readPerpsOracleExecution(args);
      assert(!result?.execution, `${target}/${defect}: state or a nonce alone must never establish execution`);
    }
  }
  console.log('PASS missing, forged, malformed and unsuccessful risk callbacks fail closed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

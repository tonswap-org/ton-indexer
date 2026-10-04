import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Address, Cell, beginCell, loadTransaction } from '@ton/core';
import { readCurrentJettonWalletStorage } from '../ledger/jettonWalletState';
import { readPerpsState, type PerpsState } from '../ledger/perpsState';
import { assertCompletePerpsDirectFeeProducer, assertCurrentCompiledCode,
  perpsDirectFeeProducerSourceInventory } from './perps-direct-fee-qualification';
import { assertPerpsProducerReceipt } from './perps-fixture-producer';

const folder = join(__dirname, 'fixtures/perps-direct-fee-current');
const provenance = JSON.parse(readFileSync(join(folder, 'provenance.json'), 'utf8'));
if (provenance.qualification !== 'qualified-after-native-source-lock' &&
    process.env.TONSWAP_ALLOW_PROVISIONAL_PERPS_FIXTURE !== '1') {
  throw Error('Perps direct-fee fixture is provisional; recapture after native source lock');
}
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const artifact = (entry: { file: string; sha256: string; bytes: number }) => {
  const saved = readFileSync(join(folder, entry.file));
  const bytes = entry.file.endsWith('.gz') ? gunzipSync(saved) : saved;
  assert.equal(bytes.length, entry.bytes, `${entry.file} original byte length`);
  assert.equal(sha256(bytes), entry.sha256, `${entry.file} original producer SHA-256`);
  return bytes;
};
const codes = Object.fromEntries(Object.entries(provenance.code).map(([name, entry]) => {
  const cells = Cell.fromBoc(artifact(entry as any));
  assert.equal(cells.length, 1);
  assert.equal(cells[0].hash().toString('hex'), (entry as any).codeHash, `${name} compiled identity`);
  return [name, (entry as any).codeHash as string];
}));
if (provenance.qualification === 'qualified-after-native-source-lock') {
  const log = artifact(provenance.producerRun).toString('utf8');
  assertCompletePerpsDirectFeeProducer(log);
  const nativeRoot = resolve(__dirname, '../../../tonswap_tolk');
  assertPerpsProducerReceipt(provenance.producerReceipt, 'directFee', nativeRoot,
    provenance.originalCaptureDirectory, Buffer.from(log));
  for(const entry of Object.values(provenance.artifacts) as {sourceFile:string;sha256:string}[]){
    assert.equal(provenance.producerReceipt.artifacts[entry.sourceFile],entry.sha256,
      'Adopted direct-fee artifact differs from its original producer run');
  }
  const sourceInventory = perpsDirectFeeProducerSourceInventory(nativeRoot);
  assert.deepEqual(provenance.nativeSourceInventory, sourceInventory,
    'Qualified direct-fee fixture no longer matches exact native producer source');
  for (const name of ['PerpsEngine', 'DlmmPool', 'JettonWallet', 'FeeRouter']) {
    const compiled = provenance.compiledArtifacts?.[name], captured = provenance.code?.[name];
    assert(compiled && captured && typeof compiled.path === 'string');
    const expectedPath = `current-compiled/${name}.json`;
    assert.equal(compiled.path, expectedPath);
    const bytes = readFileSync(join(folder, compiled.path));
    assert.equal(sha256(bytes), compiled.sha256, `${name} native compiled artifact SHA-256`);
    assert.equal(assertCurrentCompiledCode(artifact(captured), bytes.toString('utf8'), name), codes[name]);
  }
}
const economics = JSON.parse(artifact(provenance.artifacts.economics).toString('utf8'));
const feeWallet = JSON.parse(artifact(provenance.artifacts.feeRouterWallet).toString('utf8'));
const nativeConfig = JSON.parse(artifact(provenance.artifacts.chainConfig).toString('utf8'));
const configCells = Cell.fromBoc(Buffer.from(nativeConfig.configBoc, 'base64'));
assert.equal(configCells.length, 1, 'VM15 chain configuration root');
const chainConfigHash = configCells[0].hash().toString('hex');
assert.equal(economics.engineCodeHash, codes.PerpsEngine);
assert.equal(feeWallet.engineCodeHash, codes.PerpsEngine);
assert.equal(Cell.fromBase64(feeWallet.codeBoc).hash().toString('hex'), codes.JettonWallet);
assert.equal(Cell.fromBase64(feeWallet.dataBoc).hash().toString('hex'), feeWallet.dataHash);
assert.equal(economics.commercialViabilityQualified, false);
assert.equal(economics.nativeProcessingSelfFunded, true);
assert.equal(economics.priceScenario, 'stress-400-nanotons-per-gas');

type SavedRow = { to: string; hash: string; lt: string; aborted: boolean; exitCode: number;
  boc: string; oldStorage: string; newStorage: string };
const graph = (entry: { file: string; sha256: string; bytes: number }, label: string) => {
  const capture = JSON.parse(artifact(entry).toString('utf8'));
  assert.equal(capture.environment, 'LOCAL sandbox only');
  assert.match(capture.stage.stage, new RegExp(label, 'i'));
  return capture.stage.transactions as SavedRow[];
};
const open = graph(provenance.artifacts.open, 'OPEN');
const close = graph(provenance.artifacts.close, 'CLOSE');
assert(open.length >= 20 && close.length >= 20, 'Both direct-fee legs contain complete multi-contract execution graphs');
const engine = open.find(row => row.to !== feeWallet.address && row.to && row.oldStorage &&
  (() => { try { readPerpsState(row.oldStorage, codes.PerpsEngine); return true; } catch { return false; } })())?.to;
assert(engine, 'The original graph contains a canonical current Perps Engine state');
if (provenance.qualification === 'qualified-after-native-source-lock') {
  assert.equal(provenance.bindings?.engine, engine);
  assert.equal(provenance.bindings?.feeRouter, feeWallet.owner);
  assert.equal(provenance.bindings?.feeRouterWallet, feeWallet.address);
  assert.equal(provenance.bindings?.chainConfigHash, chainConfigHash);
}
const readRows = (rows: SavedRow[]) => {
  const states: { before: PerpsState; after: PerpsState }[] = [];
  const routerWalletBalances: { before: bigint; after: bigint }[] = [];
  for (const row of rows) {
    const cell = Cell.fromBase64(row.boc), tx = loadTransaction(cell.beginParse());
    assert.equal(cell.hash().toString('hex'), row.hash, 'Original VM transaction BOC hash');
    assert.equal(tx.lt.toString(), row.lt, 'Original VM logical time');
    if (row.to !== null) assert.equal(`0:${tx.address.toString(16).padStart(64, '0')}`, Address.parse(row.to).toRawString());
    assert.equal(row.aborted, false, 'Direct-fee graph has no aborted transaction');
    assert.equal(row.exitCode, 0, 'Direct-fee graph has no failed VM execution');
    if (row.to === engine) {
      states.push({ before: readPerpsState(row.oldStorage, codes.PerpsEngine),
        after: readPerpsState(row.newStorage, codes.PerpsEngine) });
    }
    if (row.to === feeWallet.address) {
      const before = readCurrentJettonWalletStorage(Cell.fromBase64(row.oldStorage));
      const after = readCurrentJettonWalletStorage(Cell.fromBase64(row.newStorage));
      assert.equal(before.owner.toRawString(), feeWallet.owner);
      assert.equal(after.owner.toRawString(), feeWallet.owner);
      assert.equal(before.root.toRawString(), after.root.toRawString());
      routerWalletBalances.push({ before: before.balance, after: after.balance });
    }
  }
  assert(states.length > 0);
  assert.equal(routerWalletBalances.length, 1, 'Exactly one T3 FeeRouter wallet receipt per leg');
  return { states, routerWalletBalances };
};
const opened = readRows(open), closed = readRows(close);
if (provenance.qualification === 'qualified-after-native-source-lock') {
  const state = opened.states.at(-1)!.after;
  assert.equal(provenance.bindings?.pool, state.markets.get(1)?.pool);
  assert.equal(provenance.bindings?.owner, [...state.positions.values()][0]?.owner);
  const feeData = readCurrentJettonWalletStorage(Cell.fromBase64(feeWallet.dataBoc));
  assert.equal(provenance.bindings?.t3Root, feeData.root.toRawString());
  assert(open.some(row => row.to === feeWallet.owner) && close.some(row => row.to === feeWallet.owner));
}
const withRefs = (cell: Cell, refs: readonly Cell[]) => {
  const builder = beginCell().storeBits(cell.bits);
  for (const ref of refs) builder.storeRef(ref);
  return builder.endCell();
};
const terminalData = Cell.fromBase64(open.filter(row => row.to === engine).at(-1)!.newStorage);
const queues = terminalData.refs[2], tail = queues.refs[2], feeRouting = tail.refs[1], protocol = feeRouting.refs[1];
assert.equal(protocol.refs.length, 3, 'Current Engine protocol journal has the native settlement and direct-fee cells');
const oldProtocol = withRefs(protocol, protocol.refs.slice(0, -1));
const oldFeeRouting = withRefs(feeRouting, [feeRouting.refs[0], oldProtocol, feeRouting.refs[2]]);
const oldTail = withRefs(tail, [tail.refs[0], oldFeeRouting]);
const oldQueues = withRefs(queues, [queues.refs[0], queues.refs[1], oldTail]);
const oldLayout = withRefs(terminalData, [terminalData.refs[0], terminalData.refs[1], oldQueues, terminalData.refs[3]]);
assert.throws(() => readPerpsState(oldLayout.toBoc().toString('base64'), codes.PerpsEngine),
  'A current code identity cannot admit the retired journal layout');
assert.equal(opened.states.at(-1)!.after.positions.size, 1, 'OPEN creates one isolated position');
assert.equal(closed.states[0].before.positions.size, 1, 'CLOSE starts with the same active position');
assert.equal(closed.states.at(-1)!.after.positions.size, 0, 'CLOSE removes the entire position');
assert.equal(opened.states.at(-1)!.after.directFeeEscrow, null, 'OPEN has zero terminal fee native custody');
assert.equal(closed.states.at(-1)!.after.directFeeEscrow, null, 'CLOSE has zero terminal fee native custody');
assert(closed.states.some(({ after }) => after.directFeeEscrow?.budgetRaw === '730000000'),
  'CLOSE durably reserves its source-funded fee dispatch before payout finality');
for (const state of [opened.states.at(-1)!.after, closed.states.at(-1)!.after]) {
  assert.equal(state.feeTreasury, feeWallet.owner, 'Direct protocol fee targets configured FeeRouter');
  assert.equal(state.riskVaultBucketId, 1);
  for (const account of state.accounts.values()) assert.equal(account.referralLinked, 0, 'No first-release Perps referral linkage');
}
const openFee = BigInt(economics.nativeEconomics[0].feeRouterT3DeltaNano);
const closeFee = BigInt(economics.nativeEconomics[1].feeRouterT3DeltaNano);
assert.equal(openFee, 22_500_000n);
assert.equal(closeFee, 22_500_000n);
assert.deepEqual(opened.routerWalletBalances, [{ before: 0n, after: openFee }]);
assert.deepEqual(closed.routerWalletBalances, [{ before: openFee, after: openFee + closeFee }]);
assert.equal(BigInt(economics.roundTripNetNano), economics.nativeEconomics.reduce(
  (sum: bigint, leg: { traderNetSpentNano: string }) => sum + BigInt(leg.traderNetSpentNano), 0n));
assert(BigInt(economics.roundTripNetNano) > 0n);
console.log(`PASS current-source direct-fee Perps decoder: ${opened.states.length}/${closed.states.length} engine boundaries, exact FeeRouter T3 credits, zero terminal escrow`);

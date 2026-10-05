import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Address, Cell, loadTransaction } from '@ton/core';
import { readCurrentJettonWalletStorage } from '../ledger/jettonWalletState';
import { readPerpsState } from '../ledger/perpsState';
import { assertCurrentCompiledCode } from './perps-direct-fee-qualification';
import { readPerpsProducerReceipt } from './perps-fixture-producer';
import { retainPerpsCaptureBuild } from './capture-perps-fixture';

// Adopt only a complete native pure-build producer receipt. This
// copies the original VM transaction graphs, never reconstructed transitions.
const source = process.argv[2];
const qualified = process.argv[3] === '--qualified';
const producerLog = process.argv[4];
if (!source || !qualified || !producerLog || process.argv[5])
  throw Error('Usage: tsx refresh-perps-direct-fee-fixture.ts <native-capture-dir> --qualified <complete-producer-log>');
const target = join(__dirname, 'fixtures/perps-direct-fee-current');
const nativeRoot = resolve(__dirname, '../../../tonswap_tolk');
const producerReceipt = readPerpsProducerReceipt(source, 'directFee', nativeRoot, producerLog);
const buildBindingJson = readFileSync(join(source,'build-binding.json'),'utf8');
const buildBinding = JSON.parse(buildBindingJson);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const staged: { destination: string; bytes: Buffer }[] = [];
const capture = (name: string, compress = false, outputName?: string) => {
  const bytes = readFileSync(join(source, name));
  const destination = outputName ?? (compress ? `${name}.gz` : name);
  staged.push({ destination, bytes: compress ? gzipSync(bytes, { mtime: 0 } as any) : bytes });
  return { file: destination, sourceFile: name, sha256: sha256(bytes), bytes: bytes.length };
};
const code = Object.fromEntries(['PerpsEngine', 'DlmmPool', 'JettonWallet', 'FeeRouter'].map(name => {
  const artifact = capture(`compiled/${name}.boc`);
  const cells = Cell.fromBoc(readFileSync(join(source, `compiled/${name}.boc`)));
  assert.equal(cells.length, 1, `${name} must compile to one code cell`);
  const compiledPath = producerReceipt.compiled[name].file;
  const codeHash = assertCurrentCompiledCode(readFileSync(join(source, `compiled/${name}.boc`)),
    readFileSync(join(source, compiledPath), 'utf8'), name);
  return [name, { ...artifact, codeHash }];
}));
const stageFile = (expected: string) => {
  const files = readdirSync(source).filter(name => /^transactions-\d+\.json$/.test(name) &&
    JSON.parse(readFileSync(join(source, name), 'utf8')).stage?.stage === expected);
  assert.equal(files.length, 1, `Exactly one original ${expected} capture is required`);
  return files[0];
};
const openSource = stageFile('Bob OPEN with fee custody and no referral fanout');
const closeSource = stageFile('Bob CLOSE with fee custody and no referral fanout');
const open = capture(openSource, true, 'open.json.gz');
const close = capture(closeSource, true, 'close.json.gz');
const economics = capture('native-economics-direct-fee.json');
const feeRouterWallet = capture('fee-router-wallet-current.json');
const chainConfig = capture('canonical-native-config.json');
const economicsJson = JSON.parse(readFileSync(join(source, 'native-economics-direct-fee.json'), 'utf8'));
const walletJson = JSON.parse(readFileSync(join(source, 'fee-router-wallet-current.json'), 'utf8'));
assert.equal(economicsJson.engineCodeHash, (code.PerpsEngine as any).codeHash);
assert.equal(walletJson.engineCodeHash, (code.PerpsEngine as any).codeHash);
assert.equal(economicsJson.commercialViabilityQualified, false);
assert.equal(economicsJson.nativeProcessingSelfFunded, true);
assert.equal(economicsJson.priceScenario, 'stress-400-nanotons-per-gas');
const chainConfigJson = JSON.parse(readFileSync(join(source, 'canonical-native-config.json'), 'utf8'));
const configCells = Cell.fromBoc(Buffer.from(chainConfigJson.configBoc, 'base64'));
assert.equal(configCells.length, 1, 'Canonical VM15 chain configuration has one root');
const chainConfigHash = configCells[0].hash().toString('hex');
assert.equal(resolve(source), source, 'Qualified capture path must be absolute');
assert.equal(resolve(producerLog), producerLog, 'Qualified producer log must be absolute');
const logStat = lstatSync(producerLog);
assert(logStat.isFile() && !logStat.isSymbolicLink(), 'Qualified producer log must be a physical file');
const logBytes = readFileSync(producerLog);
const producer = { file: 'producer-log.txt', sha256: sha256(logBytes), bytes: logBytes.length };
staged.push({ destination: producer.file, bytes: logBytes });
const compiledArtifacts = Object.fromEntries(['PerpsEngine', 'DlmmPool', 'JettonWallet', 'FeeRouter'].map(name => {
  const relative = producerReceipt.compiled[name].file;
  const bytes = readFileSync(join(source, relative));
  staged.push({ destination: relative, bytes });
  return [name, { path: relative, sha256: sha256(bytes) }];
}));
const feeWalletData = readCurrentJettonWalletStorage(Cell.fromBase64(walletJson.dataBoc));
assert.equal(feeWalletData.owner.toRawString(), walletJson.owner, 'FeeRouter wallet owner address');
assert.equal(walletJson.codeHash, (code.JettonWallet as any).codeHash);
assert.equal(Cell.fromBase64(walletJson.codeBoc).hash().toString('hex'), walletJson.codeHash);
const readGraph = (file: string) => {
  const graph = JSON.parse(readFileSync(join(source, file), 'utf8'));
  assert.equal(graph.environment, 'LOCAL sandbox only');
  assert(Array.isArray(graph.stage?.transactions) && graph.stage.transactions.length >= 20);
  return graph.stage.transactions as { to: string | null; hash: string; lt: string; aborted: boolean;
    exitCode: number; boc: string; oldStorage: string; newStorage: string }[];
};
const openRows = readGraph(openSource), closeRows = readGraph(closeSource);
const engineStates: { address: string; state: ReturnType<typeof readPerpsState> }[] = [];
for (const row of [...openRows, ...closeRows]) {
  const cell = Cell.fromBase64(row.boc), tx = loadTransaction(cell.beginParse());
  assert.equal(cell.hash().toString('hex'), row.hash, 'Original VM transaction BOC hash');
  assert.equal(tx.lt.toString(), row.lt, 'Original VM transaction LT');
  assert.equal(row.aborted, false, 'No aborted transaction in qualified direct-fee graph');
  assert.equal(row.exitCode, 0, 'No failed compute in qualified direct-fee graph');
  if (row.to) assert.equal(Address.parse(row.to).hash.toString('hex'), tx.address.toString(16).padStart(64, '0'));
  if (!row.to || !row.newStorage) continue;
  try {
    const state = readPerpsState(row.newStorage, (code.PerpsEngine as any).codeHash);
    engineStates.push({ address: row.to, state });
  } catch { /* Other contract storage is not the Engine layout. */ }
}
assert(engineStates.length >= 4, 'Both legs must contain current Engine state transitions');
const engines = new Set(engineStates.map(row => row.address));
assert.equal(engines.size, 1, 'Qualified direct-fee graph has one Engine address');
const engine = [...engines][0];
const opened = engineStates.find(row => row.state.positions.size === 1);
assert(opened, 'OPEN graph must produce an active position');
const position = [...opened.state.positions.values()][0];
const pool = opened.state.markets.get(1)?.pool;
assert(pool, 'Qualified Engine market 1 lacks an authenticated Pool');
assert.equal(opened.state.feeTreasury, walletJson.owner, 'Engine fee route differs from FeeRouter wallet owner');
assert(openRows.some(row => row.to === pool) && closeRows.some(row => row.to === pool),
  'Both legs must touch the bound oracle Pool');
assert(openRows.some(row => row.to === walletJson.owner) && closeRows.some(row => row.to === walletJson.owner),
  'Both legs must reach the bound FeeRouter contract');
assert.equal(openRows.filter(row => row.to === walletJson.address).length, 1);
assert.equal(closeRows.filter(row => row.to === walletJson.address).length, 1);
assert.equal(engineStates.at(-1)?.state.positions.size, 0, 'CLOSE graph must clear the same position');
const bindings = { engine, pool, owner: position.owner, feeRouter: walletJson.owner,
  feeRouterWallet: walletJson.address, t3Root: feeWalletData.root.toRawString(), chainConfigHash };
const provenance = {
  source: 'Canonical VM15 local Sandbox Perps direct-fee OPEN/CLOSE producer; not live testnet',
  producer: 'tests/referral/PerpsTradeReferralPayout.spec.ts',
  qualification: 'qualified-pure-build-target-closure',
  originalCaptureDirectory: source,
  producerRun: producer,
  producerReceipt,
  buildBinding, buildBindingJson,
  compiledArtifacts,
  bindings,
  code,
  artifacts: { open, close, economics, feeRouterWallet, chainConfig },
};
assert.deepEqual(readPerpsProducerReceipt(source, 'directFee', nativeRoot, producerLog), producerReceipt,
  'Producer evidence or executable source changed during adoption');
retainPerpsCaptureBuild(source,'directFee',producerReceipt);
mkdirSync(target, { recursive: true });
for (const item of staged) {
  mkdirSync(dirname(join(target, item.destination)), { recursive: true });
  writeFileSync(join(target, item.destination), item.bytes);
}
writeFileSync(join(target, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
console.log(`Refreshed current-source Perps direct-fee fixture: Engine ${(code.PerpsEngine as any).codeHash}, Pool ${(code.DlmmPool as any).codeHash}`);

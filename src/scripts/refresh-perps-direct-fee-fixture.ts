import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Address, Cell, loadTransaction } from '@ton/core';
import { readCurrentJettonWalletStorage } from '../ledger/jettonWalletState';
import { readPerpsState } from '../ledger/perpsState';
import { decodeNativeFundingBody } from '../ledger/nativeFunding';
import { perpsWalletAddress } from '../ledger/perpsWire';
import { assertCompletePerpsDirectFeeProducer, assertCurrentCompiledCode,
  perpsDirectFeeProducerSourceInventory } from './perps-direct-fee-qualification';
import { readPerpsProducerReceipt } from './perps-fixture-producer';

// Run only after the complete native producer passes on frozen source. This
// copies the original VM transaction graphs, never reconstructed transitions.
const source = process.argv[2];
const qualified = process.argv[3] === '--qualified';
const producerLog = process.argv[4];
if (!source || (process.argv[3] && !qualified) || (qualified && !producerLog) ||
    (!qualified && producerLog))
  throw Error('Usage: tsx refresh-perps-direct-fee-fixture.ts <native-capture-dir> [--qualified <complete-producer-log>]');
const target = join(__dirname, 'fixtures/perps-direct-fee-current');
const nativeRoot = resolve(__dirname, '../../../tonswap_tolk');
const producerReceipt = qualified ? readPerpsProducerReceipt(source, 'directFee', nativeRoot, producerLog) : null;
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
  let codeHash = cells[0].hash().toString('hex');
  if (qualified) {
    const compiledPath = producerReceipt.compiled[name].file;
    codeHash = assertCurrentCompiledCode(readFileSync(join(source, `compiled/${name}.boc`)),
      readFileSync(join(source, compiledPath), 'utf8'), name);
  }
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
let producer: { file: string; sha256: string; bytes: number } | null = null;
let nativeSourceInventory: ReturnType<typeof perpsDirectFeeProducerSourceInventory> | null = null;
let compiledArtifacts: Record<string, { path: string; sha256: string }> | null = null;
let bindings: { engine: string; pool: string; owner: string; feeRouter: string;
  feeRouterWallet: string; t3Root: string; chainConfigHash: string } | null = null;
let releaseCapture: Buffer | null = null;
if (qualified) {
  assert.equal(resolve(source), source, 'Qualified capture path must be absolute');
  assert.equal(resolve(producerLog), producerLog, 'Qualified producer log must be absolute');
  const logStat = lstatSync(producerLog);
  assert(logStat.isFile() && !logStat.isSymbolicLink(), 'Qualified producer log must be a physical file');
  const logBytes = readFileSync(producerLog);
  assertCompletePerpsDirectFeeProducer(logBytes.toString('utf8'));
  producer = { file: 'producer-log.txt', sha256: sha256(logBytes), bytes: logBytes.length };
  staged.push({ destination: producer.file, bytes: logBytes });
  nativeSourceInventory = perpsDirectFeeProducerSourceInventory(nativeRoot);
  compiledArtifacts = Object.fromEntries(['PerpsEngine', 'DlmmPool', 'JettonWallet', 'FeeRouter'].map(name => {
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
  bindings = { engine, pool, owner: position.owner, feeRouter: walletJson.owner,
    feeRouterWallet: walletJson.address, t3Root: feeWalletData.root.toRawString(), chainConfigHash };

  // The native release consumer must use these same qualified original graphs.
  // Retain the source bytes as well as the BOCs so the consumer can verify the
  // producer's artifact digests without depending on a private capture directory.
  const policyResponses = openRows.map(row => loadTransaction(Cell.fromBase64(row.boc).beginParse()))
    .filter(tx => tx.inMessage?.info.type === 'internal' && tx.inMessage.info.dest.toRawString() === engine &&
      decodeNativeFundingBody(tx.inMessage.body).businessBody.beginParse().preloadUint(32) === 0x52505253);
  assert.equal(policyResponses.length, 1, 'Release OPEN must contain one original policy response');
  const policyMessage = policyResponses[0].inMessage!;
  assert(policyMessage.info.type === 'internal');
  assert(opened.state.riskVault, 'Release graph must bind the current RiskVault');
  const releaseLeg = (file: string) => {
    const bytes = readFileSync(join(source, file));
    const graph = JSON.parse(bytes.toString('utf8'));
    return { sourceFile: file, sourceSha256: sha256(bytes), stage: graph.stage.stage,
      sourceJsonGzip: gzipSync(bytes, { mtime: 0 } as any).toString('base64'),
      transactions: graph.stage.transactions.map((row: { boc: string }) => row.boc) };
  };
  const receiptBytes = readFileSync(join(source, 'producer-receipt.json'));
  releaseCapture = Buffer.from(JSON.stringify({
    schema: 'tonswap-perps-direct-fee-causal-capture-v2',
    environment: 'Canonical VM15 stress400 local Sandbox; not live',
    source: producerReceipt.suite,
    engineCodeHash: (code.PerpsEngine as any).codeHash,
    engineCodeBoc: readFileSync(join(source, 'compiled/PerpsEngine.boc')).toString('base64'),
    economicsSha256: economics.sha256, feeRouterWalletSha256: feeRouterWallet.sha256,
    economicsJson: readFileSync(join(source, 'native-economics-direct-fee.json'), 'utf8'),
    feeRouterWalletJson: readFileSync(join(source, 'fee-router-wallet-current.json'), 'utf8'),
    chainConfigJson: readFileSync(join(source, 'canonical-native-config.json'), 'utf8'),
    producerReceiptJson: receiptBytes.toString('utf8'), producerReceiptSha256: sha256(receiptBytes),
    producerLog: logBytes.toString('utf8'),
    bindings: { engine, actor: position.owner,
      actorT3Wallet: perpsWalletAddress(opened.state.walletCode, opened.state.root, position.owner),
      engineT3Wallet: perpsWalletAddress(opened.state.walletCode, opened.state.root, engine),
      feeRouter: walletJson.owner, feeRouterT3Wallet: walletJson.address,
      pool, riskVault: opened.state.riskVault, policyController: policyMessage.info.src.toRawString() },
    open: releaseLeg(openSource), close: releaseLeg(closeSource),
  }, null, 2) + '\n');
}
const provenance = {
  source: 'Canonical VM15 local Sandbox Perps direct-fee OPEN/CLOSE producer; not live testnet',
  producer: 'tests/referral/PerpsTradeReferralPayout.spec.ts',
  qualification: qualified ? 'qualified-after-native-source-lock' : 'provisional-native-source-changing',
  originalCaptureDirectory: source,
  producerRun: producer,
  producerReceipt,
  nativeSourceInventory,
  compiledArtifacts,
  bindings,
  code,
  artifacts: { open, close, economics, feeRouterWallet, chainConfig },
};
if (qualified) assert.deepEqual(readPerpsProducerReceipt(source, 'directFee', nativeRoot, producerLog), producerReceipt,
  'Producer evidence or executable source changed during adoption');
mkdirSync(target, { recursive: true });
for (const item of staged) {
  mkdirSync(dirname(join(target, item.destination)), { recursive: true });
  writeFileSync(join(target, item.destination), item.bytes);
}
writeFileSync(join(target, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
if (releaseCapture) writeFileSync(join(nativeRoot, 'tests/fixtures/release/perps-direct-fee-causality.json'), releaseCapture);
console.log(`Refreshed current-source Perps direct-fee fixture: Engine ${(code.PerpsEngine as any).codeHash}, Pool ${(code.DlmmPool as any).codeHash}`);

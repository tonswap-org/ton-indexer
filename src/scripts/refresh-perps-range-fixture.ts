import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Cell } from '@ton/core';
import { readCurrentJettonWalletStorage } from '../ledger/jettonWalletState';
import { assertCurrentCompiledCode } from './perps-direct-fee-qualification';
import { readPerpsProducerReceipt, producerSha256, assertPerpsStressChainConfig } from './perps-fixture-producer';
import { retainPerpsCaptureBuild } from './capture-perps-fixture';

const [riskDirectory, walletDirectory] = process.argv.slice(2);
assert(riskDirectory && walletDirectory, 'Usage: refresh-perps-range-fixture.ts <risk-producer-dir> <wallet-producer-dir>');
const nativeRoot = resolve(__dirname, '../../../tonswap_tolk');
const risk = readPerpsProducerReceipt(riskDirectory, 'risk', nativeRoot);
const wallets = readPerpsProducerReceipt(walletDirectory, 'wallets', nativeRoot);
const buildBindingJsons = {risk:readFileSync(join(riskDirectory,'build-binding.json'),'utf8'),wallets:readFileSync(join(walletDirectory,'build-binding.json'),'utf8')};
const buildBindings = {risk:JSON.parse(buildBindingJsons.risk),wallets:JSON.parse(buildBindingJsons.wallets)};
for (const role of ['PerpsEngine','DlmmPool','JettonWallet','RiskVault','RiskController']) {
  const a=buildBindings.risk.targets[role],b=buildBindings.wallets.targets[role];
  assert(a && b, `Both producers must bind selected role ${role}`);
  assert.deepEqual({source:a.source,codeHash:a.codeHash,inputs:a.inputs}, {source:b.source,codeHash:b.codeHash,inputs:b.inputs}, `${role} differs between producers`);
}
const target = join(__dirname, 'fixtures/perps-range-funded-current');
const prepared = Object.entries({
  'open.json': 'captures-a-funded-round-trip-with-uninterrupted-account-history-open-880.json',
  'close.json': 'captures-a-funded-round-trip-with-uninterrupted-account-history-direct-close.json',
  'range.json': 'captures-a-funded-round-trip-with-uninterrupted-account-history-uninterrupted-range.json',
}).map(([relative, sourceName]) => ({ relative, source: join(riskDirectory, sourceName),
  bytes: readFileSync(join(riskDirectory, sourceName)) }));
for(const row of prepared) {
  const value=JSON.parse(row.bytes.toString('utf8'));
  assertPerpsStressChainConfig(value.chainConfig);
  for(const [field, role] of Object.entries({ engineCode:'PerpsEngine', poolCode:'DlmmPool',
    walletCode:'JettonWallet', riskVaultCode:'RiskVault', riskControllerCode:'RiskController' })) {
    assertCurrentCompiledCode(Buffer.from(value[field],'base64'),readFileSync(join(riskDirectory,risk.compiled[role].file),'utf8'),role);
  }
  assert(Array.isArray(value.transactions) && value.transactions.length > 0);
}
const walletBytes = readFileSync(join(walletDirectory,'current-wallets.json'));
const walletState = JSON.parse(walletBytes.toString('utf8'));
assertPerpsStressChainConfig(walletState.chainConfig);
assert.equal(walletState.engineCodeHash, risk.compiled.PerpsEngine.codeHash);
assert.equal(walletState.network,'localnet');
assert.equal(walletState.wallets.length,3);
for(const account of walletState.wallets){
  assertCurrentCompiledCode(Buffer.from(account.codeBoc,'base64'),
    readFileSync(join(walletDirectory,wallets.compiled.JettonWallet.file),'utf8'),'JettonWallet');
  const data=Cell.fromBase64(account.dataBoc);
  assert.equal(data.hash().toString('hex'),account.dataHash);
  const parsed=readCurrentJettonWalletStorage(data);
  assert.equal(parsed.owner.toRawString(),account.owner);
  assert.equal(parsed.root.toRawString(),account.root);
}
prepared.push({relative:'current-wallets.json',source:join(walletDirectory,'current-wallets.json'),bytes:walletBytes});
const provenance = { source:'Current canonical VM15 producers, original funded OPEN/CLOSE account history and independent executed Wallet states; no live testnet claim.',
  qualification:'qualified-pure-build-target-closure', live:false,
  engineCodeHash:risk.compiled.PerpsEngine.codeHash, poolCodeHash:risk.compiled.DlmmPool.codeHash,
  walletCodeHash:risk.compiled.JettonWallet.codeHash, riskVaultCodeHash:risk.compiled.RiskVault.codeHash,
  producerReceipts:{risk,wallets},buildBindings,buildBindingJsons, producerLogs:{risk:readFileSync(riskDirectory+'.log','utf8'),wallets:readFileSync(walletDirectory+'.log','utf8')},
  artifacts:prepared.map(row=>({relative:row.relative,source:row.source,sha256:producerSha256(row.bytes),bytes:row.bytes.length})) };
assert.deepEqual(readPerpsProducerReceipt(riskDirectory,'risk',nativeRoot),risk);
assert.deepEqual(readPerpsProducerReceipt(walletDirectory,'wallets',nativeRoot),wallets);
retainPerpsCaptureBuild(riskDirectory,'risk',risk);
retainPerpsCaptureBuild(walletDirectory,'wallets',wallets);
for(const row of prepared)writeFileSync(join(target,row.relative),row.bytes);
writeFileSync(join(target,'provenance.json'),JSON.stringify(provenance,null,2)+'\n');
console.log(`Adopted ${prepared.length} complete current Perps range/wallet artifacts`);

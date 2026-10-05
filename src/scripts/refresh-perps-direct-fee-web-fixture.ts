import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Cell } from '@ton/core';
import { readPerpsProducerReceipt, assertPerpsStressChainConfig } from './perps-fixture-producer';
import { assertCurrentCompiledCode } from './perps-direct-fee-qualification';
import { readCurrentJettonWalletStorage } from '../ledger/jettonWalletState';
import { retainPerpsCaptureBuild } from './capture-perps-fixture';

const source = process.argv[2];
assert(source && resolve(source) === source && !process.argv[3],
  'Usage: refresh-perps-direct-fee-web-fixture.ts <absolute-qualified-direct-fee-producer-directory>');
const nativeRoot = resolve(__dirname, '../../../tonswap_tolk');
const receipt = readPerpsProducerReceipt(source, 'directFee', nativeRoot);
const webFixtures = resolve(__dirname, '../../../tonswap_web/tests/fixtures');
const names = ['getters-before-trades.json', 'getters-after-trades.json', 'fee-router-wallet-current.json',
  'native-economics-direct-fee.json', 'canonical-native-config.json', 'producer-receipt.json', 'build-binding.json'];
const staged = new Map(names.map(name => [name, readFileSync(join(source, name))]));
staged.set('producer.log', readFileSync(source + '.log'));
const json = (name: string) => JSON.parse(staged.get(name)!.toString('utf8'));
assertPerpsStressChainConfig(json('canonical-native-config.json').configBoc);
const wallet = json('fee-router-wallet-current.json');
assertCurrentCompiledCode(Buffer.from(wallet.codeBoc, 'base64'),
  readFileSync(join(source, receipt.compiled.JettonWallet.file), 'utf8'), 'JettonWallet');
const data = Cell.fromBase64(wallet.dataBoc), state = readCurrentJettonWalletStorage(data);
assert.equal(data.hash().toString('hex'), wallet.dataHash);
assert.equal(state.owner.toRawString(), wallet.owner);
assert.equal(state.balance, 45_000_000n);
for (const stage of ['before', 'after']) {
  const getters = json(`getters-${stage}-trades.json`);
  assert.equal(getters.stage, `${stage}-trades`);
  assert.equal(getters.scope.network, 'ton:localnet');
  assert.equal(state.root.toRawString(), getters.scope.t3Root);
  for (const role of ['PerpsEngine', 'DlmmPool', 'JettonWallet', 'FeeRouter']) {
    assertCurrentCompiledCode(Buffer.from(getters.codeByContractName[role], 'base64'),
      readFileSync(join(source, receipt.compiled[role].file), 'utf8'), role);
  }
}
assert.deepEqual(readPerpsProducerReceipt(source,'directFee',nativeRoot),receipt, 'Producer evidence changed during adoption');
retainPerpsCaptureBuild(source,'directFee',receipt);
const buildBindingJson=staged.get('build-binding.json')!.toString('utf8');
staged.set('provenance.json',Buffer.from(JSON.stringify({qualification:'qualified-pure-build-target-closure',producerReceipt:receipt,buildBinding:JSON.parse(buildBindingJson),buildBindingJson},null,2)+'\n'));
for (const artifact of Object.values(receipt.compiled) as {file:string}[]) staged.set(artifact.file,readFileSync(join(source,artifact.file)));
const target = join(webFixtures, 'perps-direct-fee-current');
mkdirSync(target, {recursive: true});
for (const [name, bytes] of staged) {mkdirSync(join(target,name,'..'),{recursive:true});writeFileSync(join(target, name), bytes);}
console.log(`Adopted current direct-fee browser evidence from ${receipt.captureDirectory}`);

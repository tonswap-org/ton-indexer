import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { Cell } from '@ton/core';
import { readPerpsState } from '../ledger/perpsState';
import { readPerpsRiskFixtureProvenance } from './perps-risk-fixture';
import { readPerpsProducerReceipt, assertPerpsStressChainConfig } from './perps-fixture-producer';
import { assertCurrentCompiledCode } from './perps-direct-fee-qualification';
import { retainPerpsCaptureBuild } from './capture-perps-fixture';

const source=process.argv[2], options=process.argv.slice(3), qualified=options.includes('--qualified');
const outputAt=options.indexOf('--output');
if(!source || !qualified || options.some((value,index)=>value!=='--qualified' && value!=='--output' && !(outputAt>=0 && index===outputAt+1)) ||
    (outputAt>=0 && !options[outputAt+1]))
  throw Error('Usage: tsx refresh-perps-funding-checkpoint-fixture.ts <producer-json> --qualified [--output <dir>]');
const target=outputAt>=0?options[outputAt+1]:join(__dirname,'fixtures/perps-funding-checkpoint-current');
const bytes=readFileSync(source),saved=JSON.parse(bytes.toString('utf8'));
assertPerpsStressChainConfig(saved.chainConfig);
const producerReceipt=readPerpsProducerReceipt(dirname(source),'funding',resolve(__dirname,'../../../tonswap_tolk'));
const buildBindingJson=readFileSync(join(dirname(source),'build-binding.json'),'utf8');
const buildBinding=JSON.parse(buildBindingJson);
assertCurrentCompiledCode(Buffer.from(saved.codeBoc,'base64'),
  readFileSync(join(dirname(source),producerReceipt.compiled.PerpsEngine.file),'utf8'),'PerpsEngine');
const code=Cell.fromBase64(saved.codeBoc);
assert.equal(code.hash().toString('hex'),saved.codeHash);
assert.equal(saved.codeHash,readPerpsRiskFixtureProvenance().engineCodeHash,
  'Funding getter producer must compile the same current Engine as risk admissions');
const state=readPerpsState(saved.dataBoc,saved.codeHash);
assert.equal(state.markets.get(saved.marketId)?.fundingRemainderRaw,saved.fundingRemainder);
assert.deepEqual(readPerpsProducerReceipt(dirname(source),'funding',resolve(__dirname,'../../../tonswap_tolk')),producerReceipt, 'Producer evidence changed during adoption');
retainPerpsCaptureBuild(dirname(source),'funding',producerReceipt);
mkdirSync(target,{recursive:true});
writeFileSync(join(target,'funding-remainder.json'),bytes);
const provenance={source:'PerpsEngineFunding.spec.ts actual compiled Engine funding getter state',
  qualification:'qualified-pure-build-target-closure',
  producerReceipt,producerLog:readFileSync(dirname(source)+'.log','utf8'),buildBinding,buildBindingJson,
  originalCapture:source,engineCodeHash:saved.codeHash,
  sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
writeFileSync(join(target,'provenance.json'),`${JSON.stringify(provenance,null,2)}\n`);
console.log(`Refreshed current Perps funding checkpoint ${saved.codeHash}`);

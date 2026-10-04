import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { Cell } from '@ton/core';
import { readPerpsState } from '../ledger/perpsState';
import { readPerpsRiskFixtureProvenance } from './perps-risk-fixture';
import { readPerpsProducerReceipt, assertPerpsStressChainConfig } from './perps-fixture-producer';
import { assertCurrentCompiledCode } from './perps-direct-fee-qualification';

const source=process.argv[2], options=process.argv.slice(3), qualified=options.includes('--qualified');
const outputAt=options.indexOf('--output');
if(!source || options.some((value,index)=>value!=='--qualified' && value!=='--output' && !(outputAt>=0 && index===outputAt+1)) ||
    (outputAt>=0 && !options[outputAt+1]))
  throw Error('Usage: tsx refresh-perps-funding-checkpoint-fixture.ts <producer-json> [--output <dir>] [--qualified]');
const target=outputAt>=0?options[outputAt+1]:join(__dirname,'fixtures/perps-funding-checkpoint-current');
const bytes=readFileSync(source),saved=JSON.parse(bytes.toString('utf8'));
assertPerpsStressChainConfig(saved.chainConfig);
const producerReceipt=qualified?readPerpsProducerReceipt(dirname(source),'funding',resolve(__dirname,'../../../tonswap_tolk')):null;
if(qualified)assertCurrentCompiledCode(Buffer.from(saved.codeBoc,'base64'),
  readFileSync(join(dirname(source),producerReceipt.compiled.PerpsEngine.file),'utf8'),'PerpsEngine');
const code=Cell.fromBase64(saved.codeBoc);
assert.equal(code.hash().toString('hex'),saved.codeHash);
assert.equal(saved.codeHash,readPerpsRiskFixtureProvenance().engineCodeHash,
  'Funding getter producer must compile the same current Engine as risk admissions');
const state=readPerpsState(saved.dataBoc,saved.codeHash);
assert.equal(state.markets.get(saved.marketId)?.fundingRemainderRaw,saved.fundingRemainder);
mkdirSync(target,{recursive:true});
writeFileSync(join(target,'funding-remainder.json'),bytes);
const provenance={source:'PerpsEngineFunding.spec.ts actual compiled Engine funding getter state',
  qualification:qualified?'qualified-after-native-source-lock':'provisional-native-source-changing',
  producerReceipt,producerLog:qualified?readFileSync(dirname(source)+'.log','utf8'):null,
  originalCapture:source,engineCodeHash:saved.codeHash,
  sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
writeFileSync(join(target,'provenance.json'),`${JSON.stringify(provenance,null,2)}\n`);
console.log(`Refreshed current Perps funding checkpoint ${saved.codeHash}`);

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Address, Cell, loadTransaction } from '@ton/core';
import { readPerpsState } from '../ledger/perpsState';
import { readPerpsProducerReceipt, assertPerpsStressChainConfig } from './perps-fixture-producer';
import { assertCurrentCompiledCode } from './perps-direct-fee-qualification';
import { retainPerpsCaptureBuild } from './capture-perps-fixture';

// Adopt only a complete pure-build producer receipt. Every original BOC is
// checked through the current parser; no observed-code enrollment.
const source=process.argv[2], options=process.argv.slice(3), qualified=options.includes('--qualified');
const outputAt=options.indexOf('--output');
if(!source || !qualified || options.some((value,index)=>value!=='--qualified' && value!=='--output' && !(outputAt>=0 && index===outputAt+1)) ||
    (outputAt>=0 && !options[outputAt+1]))
  throw Error('Usage: tsx refresh-perps-risk-admission-fixture.ts <producer-dir> --qualified [--output <dir>]');
const target=outputAt>=0?options[outputAt+1]:join(__dirname,'fixtures/perps-risk-admission-current');
const nativeRoot=resolve(__dirname,'../../../tonswap_tolk');
const producerReceipt=readPerpsProducerReceipt(source,'risk',nativeRoot);
const buildBindingJson=readFileSync(join(source,'build-binding.json'),'utf8');
const buildBinding=JSON.parse(buildBindingJson);
// Current CFNG is oracle-backed. Require its actual accepted, rejected and
// reserve-exhausting transaction graphs rather than qualifying an OPEN/CLOSE
// subset as funding-claim coverage.
const cases:Record<string,string>={
  'open-accepted':'reserves-real-funded-collateral-before-a-policy-reply-activates-the-position-open-880',
  'vault-rejected':'refunds-a-paid-open-when-the-vault-rejects-an-unfunded-reservation-open-880',
  'policy-rejected':'releases-an-accepted-reservation-and-refunds-when-the-policy-budget-is-insufficient-open-880',
  'modify-accepted':'reserves-a-modification-before-increasing-exposure-and-spends-only-the-added-gross-notional-modify',
  'profitable-close':'pays-a-profitable-close-from-its-isolated-vault-allocation-without-spending-another-trader-margin-profitable-close',
  'gap-close':'caps-an-oracle-gap-liquidation-payout-at-that-position-actual-LP-capital-gap-close',
  'failed-close':'pays-a-profitable-close-from-its-isolated-vault-allocation-without-spending-another-trader-margin-failed-close',
  'maintenance-close':'automatically-settles-a-fee-bearing-forced-close-directly-to-the-real-FeeRouter-wallet-native-fee-maintenance',
  'funding-claim-accepted':'pays-earned-funding-from-allocated-LP-cash-and-never-the-trader-margin-wallet-funding-claim-accepted',
  'funding-claim-rejected':'pays-earned-funding-from-allocated-LP-cash-and-never-the-trader-margin-wallet-funding-claim-rejected',
  'funding-claim-close':'bounds-accrued-funding-at-actual-LP-capital-and-closes-the-exhausted-counterparty-funding-claim-close',
};
const identities=['engineCode','poolCode','walletCode','riskVaultCode','riskControllerCode'] as const;
const hashes:Record<string,string>={};
const artifacts:{relative:string;source:string;sha256:string;bytes:number}[]=[];
const captures:{relative:string;bytes:Buffer}[]=[];
for(const [name,sourceStem] of Object.entries(cases)) {
  const sourcePath=join(source,`${sourceStem}.json`),bytes=readFileSync(sourcePath),saved=JSON.parse(bytes.toString('utf8'));
  assertPerpsStressChainConfig(saved.chainConfig);
  for(const field of identities){
    const hash=Cell.fromBase64(saved[field]).hash().toString('hex');
    assert(!hashes[field] || hashes[field]===hash,`${field} changed within the same native producer run`);
    hashes[field]=hash;
    const role={engineCode:'PerpsEngine',poolCode:'DlmmPool',walletCode:'JettonWallet',riskVaultCode:'RiskVault',riskControllerCode:'RiskController'}[field];
    assertCurrentCompiledCode(Buffer.from(saved[field],'base64'),readFileSync(join(source,producerReceipt.compiled[role].file),'utf8'),role);
  }
  const engine=Address.parse(saved.engine),engineAccount=BigInt(`0x${engine.hash.toString('hex')}`);
  let engineBoundaries=0;
  for(const row of saved.transactions){
    const tx=loadTransaction(Cell.fromBase64(row.transaction).beginParse());
    if(tx.address!==engineAccount)continue;
    readPerpsState(row.oldStorage,hashes.engineCode);
    readPerpsState(row.newStorage,hashes.engineCode);
    engineBoundaries++;
  }
  assert(engineBoundaries>0,`${name} has no authentic decodable current Engine boundary`);
  const relative=`${name}.json`;
  captures.push({relative,bytes});
  artifacts.push({relative,source:sourcePath,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
}
const provenance={
  source:'Complete VM15 400-nanoton/gas stress PerpsRiskAdmission raw transactions and exact storage boundaries',
  producer:'tests/perps/PerpsRiskAdmission.spec.ts',
  qualification:'qualified-pure-build-target-closure',
  producerReceipt,producerLog:readFileSync(source+'.log','utf8'),buildBinding,buildBindingJson,
  engineCodeHash:hashes.engineCode,poolCodeHash:hashes.poolCode,walletCodeHash:hashes.walletCode,
  riskVaultCodeHash:hashes.riskVaultCode,riskControllerCodeHash:hashes.riskControllerCode,
  cases,artifacts,
};
assert.deepEqual(readPerpsProducerReceipt(source,'risk',nativeRoot),producerReceipt,
  'Producer evidence or executable source changed during adoption');
retainPerpsCaptureBuild(source,'risk',producerReceipt);
mkdirSync(target,{recursive:true});
for(const capture of captures)writeFileSync(join(target,capture.relative),capture.bytes);
writeFileSync(join(target,'provenance.json'),`${JSON.stringify(provenance,null,2)}\n`);
console.log(`Refreshed ${artifacts.length} Perps risk VM cases: Engine ${hashes.engineCode}, Pool ${hashes.poolCode}`);

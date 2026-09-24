import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Address, Cell } from '@ton/core';
import { Blockchain, createShardAccount } from '@ton/sandbox';
import { readPerpsState } from '../ledger/perpsState';
import { accruePerpsFunding } from '../ledger/perpsEconomics';

async function main() {
  const directory = join(__dirname, 'fixtures/perps-funding-checkpoint-current');
  const bytes = readFileSync(join(directory, 'funding-remainder.json'));
  const provenance = JSON.parse(readFileSync(join(directory, 'provenance.json'), 'utf8'));
  const saved = JSON.parse(bytes.toString('utf8'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.sha256);
  const expectedCode = JSON.parse(readFileSync(join(__dirname,
    'fixtures/perps-risk-admission-current/provenance.json'), 'utf8')).engineCodeHash;
  const code = Cell.fromBase64(saved.codeBoc), data = Cell.fromBase64(saved.dataBoc);
  assert.equal(code.hash().toString('hex'), expectedCode);
  assert.equal(saved.codeHash, expectedCode);
  assert.equal(provenance.engineCodeHash, expectedCode);
  const currentAdmission = JSON.parse(readFileSync(join(__dirname,
    'fixtures/perps-risk-admission-current/open-accepted.json'), 'utf8'));
  const state = readPerpsState(saved.dataBoc, expectedCode);
  assert.equal(state.walletCode.hash().toString('hex'), Cell.fromBase64(currentAdmission.walletCode).hash().toString('hex'),
    'The actual checkpoint state must embed the same current immutable Wallet as the admission captures');
  const market = state.markets.get(saved.marketId);
  assert(market);
  assert.equal(market.fundingIndexRaw, saved.fundingIndex);
  assert.equal(market.fundingRemainderRaw, '300');
  assert.equal(market.fundingRemainderRaw, saved.fundingRemainder);
  assert.equal(market.lastFundingTs, saved.lastFundingTs);
  assert.equal(market.fundingRateBpsRaw, saved.fundingRateBps);
  assert.equal(market.fundingValidUntil, saved.fundingValidUntil);

  // Execute only a read-only getter over the original compiled code and data.
  // This synthetic account envelope is not a claim of deployment or history.
  const chain = await Blockchain.create(), address = Address.parse(saved.engine);
  await chain.setShardAccount(address, createShardAccount({ address, code, data, balance: 1_000_000_000n }));
  const result = await chain.runGetMethod(address, 'funding_accrual_state', [{ type: 'int', value: BigInt(saved.marketId) }]);
  assert.equal(result.stackReader.remaining, 6);
  const actual = Array.from({ length: 6 }, () => result.stackReader.readBigNumber().toString());
  assert.deepEqual(actual, [market.fundingIndexRaw, market.fundingRemainderRaw, '3600', market.lastFundingTs,
    market.fundingRateBpsRaw, market.fundingValidUntil]);
  assert.equal(result.stackReader.remaining, 0);
  assert.equal(market.fundingRateBpsRaw, '0');
  assert.equal(BigInt(market.fundingValidUntil), BigInt(market.lastFundingTs) + 600n);
  const idle = accruePerpsFunding(market, BigInt(market.lastFundingTs) + 864_000n);
  assert.equal(idle.fundingIndexRaw, market.fundingIndexRaw);
  assert.equal(idle.fundingRemainderRaw, '300', 'A zero-rate checkpoint preserves the actual fractional remainder over an idle gap');
  console.log('PASS current funding checkpoint: strict257-bit decode, actual six-field getter replay, and fractional idle preservation');
}

main().catch(error => { console.error(error); process.exitCode = 1; });

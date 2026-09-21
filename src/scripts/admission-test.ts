import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Cell, TupleItem } from '@ton/core';
import { AdmissionError, decodeAdmissionResult, decodeAdmissionReadiness, makeAdmissionRequest } from '../data/admission/protocol';
import { parseAdmissionArtifacts } from '../config/admission';
import { IndexerService } from '../indexerService';
import { loadConfig } from '../config';
import { MemoryStore } from '../store/memoryStore';
import { loadOpcodes } from '../utils/opcodes';
import type { TonDataSource } from '../data/dataSource';

const raw = readFileSync(join(__dirname, 'fixtures/native-admission/captured.json'));
assert.equal(createHash('sha256').update(raw).digest('hex'), '30eb939cac02861af65e5d55fcf9e67c369fc43d712ebaff443ae1e97de794f3');
const fixture = JSON.parse(raw.toString()), now = fixture.historicalAt;
const identity = { engine: fixture.request.account_address.account_address,
  codeHash: Buffer.from(fixture.request.expected_code_hash, 'base64').toString('hex'),
  configSha256: '096cab0be595f9aacf4e1145d9e5d876e7fc39689f6fdbbcd73fce16095174b7' };
const args: TupleItem[] = fixture.request.stack.map((value: any) => value['@type'] === 'tvm.stackEntryNumber' ? { type: 'int', value: BigInt(value.number.number) } :
  value['@type'] === 'tvm.stackEntryCell' ? { type: 'cell', cell: Cell.fromBase64(value.cell.bytes) } : { type: 'slice', cell: Cell.fromBase64(value.slice.bytes) });
const request = makeAdmissionRequest(identity, 'close_order_preflight', args, now);
const accepted = decodeAdmissionResult(identity, request, fixture.response, now);
assert.equal(accepted.exitCode, 0); assert.equal(accepted.gasUsed, 507666); assert.equal(accepted.execution.outcome, 'accepted');
assert.equal(accepted.execution.block.seqno, 84779529); assert.equal(accepted.execution.shardTime, 1789399530);
assert.equal(accepted.execution.gasLimit, 1000000);
const ready = { '@type':'smc.verifiedAdmissionReady', block_id:fixture.response.block_id,
  master_utime:fixture.response.master_utime, shard_utime:fixture.response.shard_utime, code_hash:fixture.response.code_hash };
decodeAdmissionReadiness(identity,ready,now);
for(const mutate of [(r:any)=>{r.master_utime-=31;},(r:any)=>{r.shard_utime-=31;},(r:any)=>{r.master_utime+=5;},
  (r:any)=>{r.code_hash=Buffer.alloc(32).toString('base64');},(r:any)=>{r.block_id.seqno=0;},(r:any)=>{r['@type']='ton.blockIdExt';}]) {
  const changed=structuredClone(ready);mutate(changed);assert.throws(()=>decodeAdmissionReadiness(identity,changed,now),AdmissionError);
}
for (const mutate of [
  (r: any) => { r.code_hash = Buffer.alloc(32).toString('base64'); },
  (r: any) => { r.gas_limit = 1000001; },
  (r: any) => { r.gas_limit = 300000; },
  (r: any) => { r.gas_used = -1; },
  (r: any) => { r.gas_used = 1000001; },
  (r: any) => { r.data_unchanged = false; },
  (r: any) => { r.actions_empty = false; },
  (r: any) => { r.block_id.seqno = 0xffffffff; },
  (r: any) => { r.block_id.root_hash = Buffer.alloc(32).toString('base64'); },
  (r: any) => { r.shard_utime = 1789399525; },
  (r: any) => { r.master_utime = 1789399499; },
  (r: any) => { r.master_utime = 1789399535; },
  (r: any) => { r.global_version = 17; },
  (r: any) => { r.arguments = r.context; },
  (r: any) => { r.account_proof = ''; },
  (r: any) => { r.stack[2].number.number = '1'; },
  (r: any) => { r.stack[1].number.number = '1789399529'; },
  (r: any) => { r.stack[0].number.number = '1'; },
  (r: any) => { r.stack.pop(); },
]) {
  const changed = structuredClone(fixture.response); mutate(changed);
  assert.throws(() => decodeAdmissionResult(identity, request, changed, now), AdmissionError);
}
const denied = structuredClone(fixture.response); denied.stack[0].number.number = '0';
assert.equal(decodeAdmissionResult(identity, request, denied, now).execution.outcome, 'denied');
const exhausted = structuredClone(fixture.response); exhausted.exit_code = -14; exhausted.gas_used = 1000005;
exhausted.stack = [{ '@type': 'tvm.stackEntryNumber', number: { '@type': 'tvm.numberDecimal', number: '1000005' } }];
assert.equal(decodeAdmissionResult(identity, request, exhausted, now).execution.outcome, 'gas_exhausted');
assert.throws(() => makeAdmissionRequest(identity, 'engine_config', args, now), AdmissionError);
assert.throws(() => makeAdmissionRequest(identity, 'close_order_preflight', args.slice(1), now), AdmissionError);
assert.throws(() => makeAdmissionRequest(identity, 'close_order_preflight', args, now + 31000), AdmissionError);
assert.throws(() => decodeAdmissionResult(identity, request, fixture.response, now + 31000), AdmissionError);
assert.equal(parseAdmissionArtifacts({}), undefined);
for (const env of [{ PERPS_ADMISSION_BINARY_PATH: '/a' }, { PERPS_ADMISSION_BINARY_PATH: 'relative', PERPS_ADMISSION_CONFIG_PATH: '/b', PERPS_ADMISSION_BINARY_SHA256: 'a'.repeat(64), PERPS_ADMISSION_CONFIG_SHA256: 'b'.repeat(64) }]) assert.throws(() => parseAdmissionArtifacts(env));

async function serviceBoundary() {
  const config = loadConfig(), store = new MemoryStore(config); let remoteCalls = 0;
  const source = { network: 'testnet', runGetMethod: async () => { remoteCalls++; throw Error('Remote admission fallback forbidden'); } } as unknown as TonDataSource;
  const service = new IndexerService(config, store, source, loadOpcodes(config.opcodesPath), []);
  await assert.rejects(service.runGetMethod(identity.engine, 'close_order_preflight', args), AdmissionError);
  let nativeCalls = 0;
  service.setAdmissionExecutor({ engine: identity.engine, ready: true, run: async () => { nativeCalls++; return accepted; }, close: async () => {} });
  const result = await service.runGetMethod(identity.engine, 'close_order_preflight', args);
  assert.equal(result.gas_used, 507666); assert.equal(result.admission?.outcome, 'accepted');
  await assert.rejects(service.runGetMethod(`0:${'1'.repeat(64)}`, 'close_order_preflight', args), AdmissionError);
  assert.equal(nativeCalls, 1); assert.equal(remoteCalls, 0);
}
void serviceBoundary().then(() => console.log('Verified native admission protocol, actual capture bindings, mutations, and no-fallback service boundary PASS')).catch(error => { console.error(error); process.exitCode = 1; });

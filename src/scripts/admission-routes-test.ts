import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerRoutes } from '../api/routes';
import { loadConfig } from '../config';
import { AdmissionError, AdmissionErrorCode } from '../data/admission/protocol';
import { beginCell, TupleItem } from '@ton/core';
import { IndexerService } from '../indexerService';

async function testCurrentGetterWire() {
  const address = '0:' + '1'.repeat(64), cell = beginCell().storeUint(93, 8).endCell();
  const bytes = cell.toBoc().toString('base64');
  const items: TupleItem[] = [{type:'null'}, {type:'nan'}, {type:'tuple',items:[]},
    {type:'cell',cell}, {type:'slice',cell}, {type:'builder',cell}, {type:'int',value:-9n}];
  const sourceStack: TupleItem[] = [{type:'tuple',items}];
  // Only the datasource is a fixture. The actual service serializer and route run.
  const service: any = Object.create(IndexerService.prototype);
  service.getMethodSourceInFlight = new Map();
  let sourceCalls = 0;
  service.source = {runGetMethod: async (target: string, method: string, args: TupleItem[]) => {
    assert.equal(target,address);assert.equal(method,'fixture_types');assert.deepEqual(args,[]);sourceCalls++;
    return {exitCode:0,stack:sourceStack};
  }};
  const execution = {fixtureOnly:true};
  service.admissionExecutor = {engine:address,ready:true,run:async () => ({exitCode:0,gasUsed:731,stack:[{type:'int',value:-1n}],execution})};
  const app=Fastify({logger:false});registerRoutes(app,loadConfig(),service);
  try {
    const reply=await app.inject({method:'POST',url:'/jsonRPC',payload:{id:'1',jsonrpc:'2.0',method:'runGetMethod',params:{address,method:'fixture_types',stack:[]}}});
    assert.equal(reply.statusCode,200);
    assert.deepEqual(reply.json(),{id:'1',jsonrpc:'2.0',ok:true,result:{exit_code:0,gas_used:null,stack:[['tuple',{elements:[
      {'@type':'tvm.stackEntryNull'}, {'@type':'tvm.stackEntryNaN'},
      {'@type':'tvm.stackEntryTuple',tuple:{'@type':'tvm.tuple',elements:[]}},
      {'@type':'tvm.stackEntryCell',cell:{'@type':'tvm.cell',bytes}},
      {'@type':'tvm.stackEntrySlice',slice:{'@type':'tvm.slice',bytes}},
      {'@type':'tvm.stackEntryBuilder',builder:{'@type':'tvm.builder',bytes}},
      {'@type':'tvm.stackEntryNumber',number:{'@type':'tvm.numberDecimal',number:'-9'}},
    ]}]]}});
    const admission=await app.inject({method:'POST',url:'/jsonRPC',payload:{id:'1',jsonrpc:'2.0',method:'runGetMethod',params:{address,method:'open_order_preflight',stack:[]}}});
    assert.deepEqual(admission.json(),{id:'1',jsonrpc:'2.0',ok:true,result:{exit_code:0,gas_used:731,stack:[['num','-1']],admission:execution}});
    assert.equal(sourceCalls,1);
    items.push({type:'unsupported'} as any);
    await assert.rejects(service.runGetMethod(address,'fixture_types',[]),/Unsupported nested TVM stack item/);
    console.log('Current getter wire preserves nested null/nan/builder/empty tuple, unknown gas, measured admission gas and rejects unsupported nested values PASS');
  } finally {await app.close();}
}

async function run() {
  await testCurrentGetterWire();
  const app = Fastify({logger:false});
  let failure: unknown;
  const service = { getAdmissionStatus: () => ({configured:true,ready:false}), getHealth: () => ({}),
    runGetMethod: async () => {throw failure;} };
  registerRoutes(app, loadConfig(), service as any);
  const call = {address:'0:0816eb1798823310dffa9888ea1ff7f9168fdedbbc5b6f1f003720a6dcd169b1',method:'close_order_preflight',stack:[]};
  try {
    const cold=await app.inject('/api/indexer/v1/health');
    assert.equal(cold.statusCode,503);assert.deepEqual(cold.json().admission,{configured:true,ready:false});
    for (const [code,status] of [
      ['admission_busy',503],['admission_unavailable',503],['admission_timeout',504],
      ['admission_invalid_request',400],['admission_invalid_proof',502],
      ['admission_invalid_context',502],['admission_worker_failure',502]
    ] as [AdmissionErrorCode,number][]) {
      failure=new AdmissionError(code);
      const single=await app.inject({method:'POST',url:'/api/indexer/v1/runGetMethod',payload:call});
      assert.equal(single.statusCode,status);assert.deepEqual(single.json(),{code,error:code});
      for(const url of ['/jsonRPC','/api/v2/jsonRPC']) {
        const rpc=await app.inject({method:'POST',url,payload:{id:71,jsonrpc:'2.0',method:'runGetMethod',params:call}});
        assert.equal(rpc.statusCode,status);assert.deepEqual(rpc.json(),{id:71,jsonrpc:'2.0',ok:false,code:status,error:code});
      }
      const batch=await app.inject({method:'POST',url:'/api/indexer/v1/runGetMethods',payload:{calls:[call]}});
      assert.equal(batch.statusCode,200);assert.deepEqual(batch.json(),{results:[{ok:false,code,error:code}]});
    }
    failure=new Error('private worker proof bytes and host paths');
    const concealed=await app.inject({method:'POST',url:'/api/indexer/v1/runGetMethod',payload:call});
    assert.equal(concealed.statusCode,400);assert.deepEqual(concealed.json(),{code:'bad_request',error:'get method call failed'});
    // Message strings alone cannot impersonate a typed admission failure.
    failure=new Error('admission_busy');
    const untyped=await app.inject({method:'POST',url:'/api/indexer/v1/runGetMethod',payload:call});
    assert.equal(untyped.statusCode,400);assert.equal(untyped.json().code,'bad_request');
    console.log('Admission route safe typed codes/status, all getter endpoints, batch preservation and error concealment PASS');
  } finally { await app.close(); }
}
void run().catch(error=>{console.error(error);process.exitCode=1;});

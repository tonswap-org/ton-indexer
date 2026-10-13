import assert from 'node:assert/strict';
import { beginCell } from '@ton/core';
import Fastify from 'fastify';
import { registerRoutes } from '../api/routes';
import { matchesPublicRpcNetwork, PUBLIC_RPC_ZERO_STATES } from '../api/rpcNetwork';
import { ChainReadError } from '../data/dataSource';
import { fakeChainSource } from './support/fakeChainSource';
import { fixtureHead } from './support/chainFixture';
import { runtimeMetadataFixture } from './fixtures/runtimeManifest';
async function main(){
  for(const network of [undefined,null,'','TESTNET','unsupported']){const app=Fastify();assert.throws(()=>registerRoutes(app,{network} as any,{} as any),/explicit mainnet, testnet, or localnet network/);await app.close();}
  for(const network of ['mainnet','testnet'] as const){
    assert(matchesPublicRpcNetwork({init:PUBLIC_RPC_ZERO_STATES[network]},network));
    for(const init of [null,[],{}, {...PUBLIC_RPC_ZERO_STATES[network],workchain:0},PUBLIC_RPC_ZERO_STATES[network==='mainnet'?'testnet':'mainnet']])assert(!matchesPublicRpcNetwork({init},network));
  }
  const originalFetch=globalThis.fetch;let fetched=0;globalThis.fetch=async()=>{fetched++;throw Error('External RPC discovery is forbidden');};
  const cell=beginCell().storeUint(42,32).endCell(),bytes=cell.toBoc(),boc=bytes.toString('base64');
  try{for(const network of ['mainnet','testnet','localnet'] as const){
    let sent=0,fail=false;const source=fakeChainSource({network,head:async()=>fixtureHead(123),sendMessage:async(value,options)=>{assert.deepEqual(value,bytes);assert(options?.signal);if(fail)throw new ChainReadError('upstream_unavailable');sent++;}});
    const app=Fastify();registerRoutes(app,{network,enableWriteRpc:true},{} as any,undefined,undefined,undefined,undefined,undefined,runtimeMetadataFixture(network),{source});
    try{for(const url of ['/jsonRPC','/api/v2/jsonRPC']){
      const invoke=(method:string,params:object={})=>app.inject({method:'POST',url,payload:{id:'sdk-request',jsonrpc:'2.0',method,params}});
      const response=await invoke('getMasterchainInfo');assert.equal(response.statusCode,200);assert.equal(response.json().id,'sdk-request');assert.equal(response.json().result.last.seqno,123);
      if(network!=='localnet')assert(matchesPublicRpcNetwork(response.json().result,network));else assert(!('init' in response.json().result));
      const accepted=await invoke('sendBoc',{boc});assert.equal(accepted.statusCode,200);assert.deepEqual(accepted.json().result,{'@type':'ok'});
      const hashed=await invoke('sendBocReturnHash',{boc});assert.equal(hashed.statusCode,200);assert.equal(hashed.json().result.hash,cell.hash().toString('hex'));
      const prior=sent;assert.equal((await invoke('sendBoc',{boc:'invalid'})).statusCode,400);assert.equal((await invoke('estimateFee')).statusCode,404);assert.equal((await invoke('unknown')).statusCode,404);assert.equal(sent,prior);
      fail=true;const unavailable=await invoke('sendBoc',{boc});assert.equal(unavailable.statusCode,503);assert.equal(unavailable.json().ok,false);assert(Number(unavailable.headers['retry-after'])>=1);fail=false;
    }}finally{await app.close();}
    const readonly=Fastify();registerRoutes(readonly,{network,enableWriteRpc:false},{} as any,undefined,undefined,undefined,undefined,undefined,runtimeMetadataFixture(network),{source});
    try{const prior=sent;for(const method of ['sendBoc','sendBocReturnHash'])assert.equal((await readonly.inject({method:'POST',url:'/jsonRPC',payload:{method,params:{boc}}})).statusCode,404);assert.equal(sent,prior);}finally{await readonly.close();}
  }assert.equal(fetched,0);console.log('Explicit network identity, both RPC mounts, direct source writes, BOC validation, write-disabled404 and unavailable503 passed without HTTP discovery.');}
  finally{globalThis.fetch=originalFetch;}
}
main().catch(error=>{console.error(error);process.exitCode=1;});

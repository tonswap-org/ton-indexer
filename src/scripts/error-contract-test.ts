import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerRoutes } from '../api/routes';
import { setCorsHeaders } from '../api/cors';
import { loadConfig } from '../config';
import { IndexerService } from '../indexerService';
import { MemoryStore } from '../store/memoryStore';
import { loadOpcodes } from '../utils/opcodes';
import { ChainReadError } from '../data/dataSource';
import { AdmissionError } from '../data/admission/protocol';
import { fakeChainSource } from './support/fakeChainSource';
import { fixtureHead } from './support/chainFixture';
async function main() {
  const config={...loadConfig(),corsAllowOrigin:'https://test.tonswap.org',corsAllowOrigins:['https://test.tonswap.org']};
  const addr=`0:${'1'.repeat(64)}`;let mode='hang',signal:AbortSignal|undefined;
  const service=new IndexerService(config,new MemoryStore(config),fakeChainSource({head:async()=>fixtureHead(),runGetMethod:async(_a,_m,_s,o)=>{
    signal=o?.signal;if(mode==='hang')return new Promise(()=>{});throw new ChainReadError('upstream_unavailable');
  }}),loadOpcodes(),[]);
  service.setAdmissionExecutor({engine:addr,ready:true,run:async()=>{throw new AdmissionError('admission_invalid_proof');}} as any);
  const app=Fastify();app.addHook('onRequest',async(req,reply)=>{setCorsHeaders(req,reply,config);});registerRoutes(app,config,service);
  app.get('/fixture-ledger',(_request,reply)=>reply.status(503).send({error:'Ledger unavailable.',code:'ledger_unavailable'}));
  try {
    const call=(method='fixture')=>app.inject({method:'POST',url:'/api/indexer/v1/runGetMethod',headers:{origin:'https://test.tonswap.org'},payload:{address:addr,method,stack:[]}});
    const timed=await call();assert.equal(timed.statusCode,504);assert.equal(timed.json().code,'upstream_timeout');assert(signal?.aborted);
    mode='down';const unavailable=await call();assert.equal(unavailable.statusCode,503);assert.equal(unavailable.json().code,'upstream_unavailable');
    const admission=await call('open_order_preflight');assert.equal(admission.statusCode,502);assert.equal(admission.json().code,'admission_invalid_proof');
    const unknown=await app.inject({url:'/api/indexer/private/missing',headers:{origin:'https://test.tonswap.org'}});assert.equal(unknown.statusCode,404);
    const schema=await app.inject({url:`/api/indexer/v1/governance/${addr}/snapshot?max_scan=broken`,headers:{origin:'https://test.tonswap.org'}});assert.equal(schema.statusCode,400);
    const malformed=await app.inject({method:'POST',url:'/api/indexer/v1/runGetMethod',headers:{origin:'https://test.tonswap.org','content-type':'application/json'},payload:'{'});assert.equal(malformed.statusCode,400);
    const ledger=await app.inject({url:'/fixture-ledger',headers:{origin:'https://test.tonswap.org'}});assert.equal(ledger.statusCode,503);
    for(const response of [timed,unavailable,admission,unknown,schema,malformed,ledger]){
      assert.deepEqual(Object.keys(response.json()).sort(),['code','error']);assert(!response.body.includes('/api/indexer'));
      assert.equal(response.headers['access-control-allow-origin'],'https://test.tonswap.org');assert(String(response.headers['access-control-expose-headers']).includes('retry-after'));
      if([503,504].includes(response.statusCode)){assert(Number(response.headers['retry-after'])>=1);assert.equal(response.headers['cache-control'],'no-store');}
    }
    console.log('HTTP typed timeout/unavailable/admission, flat schema/unknown errors, ledger retry and CORS passed.');
  }finally{await app.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});

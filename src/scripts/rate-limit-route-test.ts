import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerRoutes } from '../api/routes';
import { setCorsHeaders } from '../api/cors';
import { RateLimiter } from '../api/rateLimit';
import { loadConfig } from '../config';
import { createRuntimeMetrics } from '../runtimeMetrics';
async function main(){
  const defaults=loadConfig(),config={...defaults,edgeKey:'fixture-secret',rateLimitEnabled:true,rateLimitWindowMs:60000,rateLimitMax:2,
    rateLimitBuckets:Object.fromEntries(Object.keys(defaults.rateLimitBuckets).map(key=>[key,{max:2,windowMs:60000}])) as typeof defaults.rateLimitBuckets,
    corsAllowOrigin:'https://test.tonswap.org',corsAllowOrigins:['https://test.tonswap.org']};
  const app=Fastify(),metrics=createRuntimeMetrics();app.addHook('onRequest',async(req,reply)=>{setCorsHeaders(req,reply,config);});registerRoutes(app,config,{} as any,undefined,undefined,undefined,new RateLimiter(config),undefined,undefined,{metrics});
  const call=(ip:string,key?:string)=>app.inject({url:'/api/indexer/v1/service-info',headers:{origin:'https://test.tonswap.org','x-tonswap-client-ip':ip,'x-forwarded-for':ip,...(key?{'x-tonswap-edge-key':key}:{})}});
  try{
    for(const ip of ['192.0.2.1','192.0.2.2']){assert.equal((await call(ip,config.edgeKey)).statusCode,200);assert.equal((await call(ip,config.edgeKey)).statusCode,200);const limited=await call(ip,config.edgeKey);assert.equal(limited.statusCode,429);assert.deepEqual(limited.json(),{error:'rate limit exceeded',code:'rate_limited'});assert(Number(limited.headers['retry-after'])>=1);assert.equal(limited.headers['access-control-allow-origin'],'https://test.tonswap.org');assert(String(limited.headers['access-control-expose-headers']).includes('retry-after'));}
    assert.equal((await call('192.0.2.3')).statusCode,200);assert.equal((await call('192.0.2.4','forged')).statusCode,200);assert.equal((await call('192.0.2.5')).statusCode,429);
    const series=(metrics.snapshot() as any).series.filter((row:any)=>row.name==='http_requests_total');assert.deepEqual(series.map((row:any)=>[row.labels.identity,row.value]).sort(),[['edge',6],['socket',3]]);
    console.log('Authenticated edge visitor budgets, shared untrusted socket bucket, retry/CORS and bounded identity metrics passed.');
  }finally{await app.close();}
  const unmetered = Fastify(), disabledMetrics = createRuntimeMetrics();
  registerRoutes(unmetered,config,{} as any,undefined,undefined,undefined,new RateLimiter({...config,rateLimitEnabled:false}),undefined,undefined,{metrics:disabledMetrics});
  try {
    for(let i=0;i<3;i++) assert.equal((await unmetered.inject({url:'/api/indexer/v1/service-info'})).statusCode,200);
    const series=(disabledMetrics.snapshot() as any).series.find((row:any)=>row.name==='http_requests_total');
    assert.equal(series.labels.identity,'socket'); assert.equal(series.value,3,'Identity metrics remain available while limiting is disabled');
  } finally { await unmetered.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});

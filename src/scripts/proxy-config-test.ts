import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { once } from 'node:events';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PROXY_ERROR_BODY } from '../api/errors';

const root=resolve(__dirname,'../..');
const listen=(server:Server,port=0)=>new Promise<number>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve((server.address() as {port:number}).port);});});
const close=(server:Server)=>new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});
async function freePort(){const server=createSocketServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, delay(2000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}
async function runMount(mount:string,template:string,body:Buffer){
  const prefix=await mkdtemp(join(tmpdir(),'tonswap-proxy-test-'));let child:ChildProcess|undefined,backendLive=false,log='';
  const seen:Array<{url:string|undefined;edge:string|undefined;client:string|undefined;forwarded:string|undefined}>=[];
  const backend=createServer((request,response)=>{
    seen.push({url:request.url,edge:request.headers['x-tonswap-edge-key'] as string|undefined,client:request.headers['x-tonswap-client-ip'] as string|undefined,forwarded:request.headers['x-forwarded-for'] as string|undefined});
    response.setHeader('Access-Control-Allow-Origin','https://backend.invalid');
    if(request.url?.startsWith('/api/indexer/v1/timeout')){response.writeHead(504,{'content-type':'application/json','retry-after':'1','cache-control':'no-store'});response.end('{"error":"Chain read deadline exceeded.","code":"upstream_timeout"}');return;}
    if(request.url==='/api/indexer/v1/unavailable'){response.writeHead(503,{'content-type':'application/json','retry-after':'2','cache-control':'no-store'});response.end('{"error":"Chain read unavailable.","code":"upstream_unavailable"}');return;}
    if(request.url==='/api/indexer/v1/limited'){response.writeHead(429,{'content-type':'application/json','retry-after':'7','cache-control':'no-store'});response.end('{"error":"Rate limit exceeded.","code":"rate_limited"}');return;}
    if(request.url?.startsWith('/api/indexer/v1/stream/balances')){response.writeHead(200,{'content-type':'text/event-stream'});response.write('data: {"type":"first"}\n\n');const timer=setTimeout(()=>response.end('data: {"type":"last"}\n\n'),500);response.once('close',()=>clearTimeout(timer));return;}
    response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(seen.at(-1)));
  });
  try{
    const backendPort=await listen(backend);backendLive=true;await close(backend);backendLive=false;
    const port=await freePort();await mkdir(join(prefix,'logs'));await writeFile(join(prefix,'proxy-error.json'),body);
    const values:Record<string,string>={PUBLIC_MOUNT:mount,LISTEN:`127.0.0.1:${port}`,BACKEND:`127.0.0.1:${backendPort}`,ERROR_ROOT:prefix};
    const rendered=template.replace(/\{\{([A-Z_]+)\}\}/g,(_,key)=>{assert(values[key],`unknown template variable ${key}`);return values[key];});
    const file=join(prefix,'nginx.conf');
    await writeFile(file,`worker_processes 1;\npid "${join(prefix,'nginx.pid')}";\nerror_log stderr;\nevents { worker_connections 128; }\nhttp { access_log off;\n${rendered}\n}\n`);
    const syntax=spawnSync('nginx',['-p',`${prefix}/`,'-c',file,'-t'],{encoding:'utf8'});assert.equal(syntax.status,0,syntax.stderr);
    child=spawn('nginx',['-p',`${prefix}/`,'-c',file,'-g','daemon off; master_process off;'],{stdio:['ignore','ignore','pipe']});
    child.stderr!.on('data',chunk=>{log+=chunk.toString();});
    const get=(path:string,extra:Record<string,string>={})=>fetch(`http://127.0.0.1:${port}${path}`,{headers:{origin:'https://test.tonswap.org',...extra},signal:AbortSignal.timeout(3000)});
    let ready=false;for(let attempt=0;attempt<50;attempt++){try{await get('/');ready=true;break;}catch{if(child.exitCode!==null)break;await delay(20);}}
    assert(ready,log);
    const down=await get(`${mount}/v1/health`);assert.equal(down.status,503,log);assert.deepEqual(Buffer.from(await down.arrayBuffer()),body);
    assert.equal(down.headers.get('content-type'),'application/json');assert.equal(down.headers.get('retry-after'),'5');assert.equal(down.headers.get('cache-control'),'no-store');
    assert.equal(down.headers.get('access-control-allow-origin'),'https://test.tonswap.org');assert(down.headers.get('access-control-expose-headers')?.includes('retry-after'));
    await listen(backend,backendPort);backendLive=true;
    for(const [path,status,retry,code]of [['timeout?read=1',504,'1','upstream_timeout'],['unavailable',503,'2','upstream_unavailable'],['limited',429,'7','rate_limited']]as const){
      const response=await get(`${mount}/v1/${path}`);assert.equal(response.status,status);assert.equal(response.headers.get('retry-after'),retry);assert.equal((await response.json() as any).code,code);
      assert.equal(response.headers.get('access-control-allow-origin'),'https://test.tonswap.org');assert.equal(response.headers.get('cache-control'),'no-store');
    }
    const before=seen.length;
    for(const path of ['/v1/metrics','/v1/metrics/anything','/v1/debug','/v1/snapshot/','/v1/snapshot/private']){const response=await get(`${mount}${path}`);assert.equal(response.status,404);assert.equal((await response.json()as any).code,'not_found');}
    assert.equal(seen.length,before,'operational paths never reach backend');
    const response=await get(`${mount}/v1/echo?read=1`,{'X-TONSwap-Edge-Key':'edge-secret-fixture','X-TONSwap-Client-IP':'2001:db8::12'});
    assert.deepEqual(await response.json(),{url:'/api/indexer/v1/echo?read=1',edge:'edge-secret-fixture',client:'2001:db8::12'});
    assert.equal(response.headers.get('access-control-allow-origin'),'https://test.tonswap.org','one edge CORS origin');
    const direct=await get(`${mount}/v1/echo`);assert.equal(direct.status,200,'direct clients reach the application socket-address limiter');
    const stream=await get(`${mount}/v1/stream/balances?address=owner`);assert.equal(stream.status,200);
    const reader=stream.body!.getReader(),first=await reader.read();assert.match(Buffer.from(first.value!).toString(),/"first"/);assert(!Buffer.from(first.value!).toString().includes('last'),'stream first event is unbuffered');await reader.cancel();
    assert.equal(seen.at(-1)!.url,'/api/indexer/v1/stream/balances?address=owner');
    console.log(`Proxy ${mount}: nginx syntax, exact static 503, CORS, operational blocks, edge identity, typed 504/503/429 and unbuffered SSE passed.`);
  }finally{if(child)await stop(child);if(backendLive)await close(backend);await rm(prefix,{recursive:true,force:true});}
}
async function main(){
  const available=spawnSync('nginx',['-v'],{encoding:'utf8'});if(available.error&&(available.error as NodeJS.ErrnoException).code==='ENOENT'){console.log('SKIP proxy-config-test: nginx is not on PATH.');return;}
  assert.equal(available.status,0,available.stderr);
  const template=await readFile(join(root,'config/nginx-indexer.conf'),'utf8'),body=await readFile(join(root,'config/proxy-error.json'));
  assert.deepEqual(body,Buffer.from(JSON.stringify(PROXY_ERROR_BODY)));
  for(const mount of ['/api/indexer','/api/indexer-r2'])await runMount(mount,template,body);
}
main().catch(error=>{console.error(error);process.exitCode=1;});

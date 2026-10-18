import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerRoutes } from '../api/routes';
import { loadConfig } from '../config';
import { IndexerService } from '../indexerService';
import { MemoryStore } from '../store/memoryStore';
import { loadOpcodes } from '../utils/opcodes';
import { ChainReadError } from '../data/dataSource';
import { fakeChainSource } from './support/fakeChainSource';
import { fixtureHead } from './support/chainFixture';
async function main(){
  const config=loadConfig(),addr=`0:${'1'.repeat(64)}`,head=fixtureHead(123,1700000100),anchor={shardBlock:{...fixtureHead(91),workchain:0},genUtime:1700000000};
  let failure:string|undefined;const source=fakeChainSource({head:async()=>head,getAccountState:async()=>{if(failure)throw new ChainReadError(failure as any);return{balance:'123456789',accountState:'active',codeBoc:'code',dataBoc:'data',lastTxLt:'99',lastTxHash:'c'.repeat(64),anchor};}});
  const app=Fastify(),service=new IndexerService(config,new MemoryStore(config),source,loadOpcodes(),[]);registerRoutes(app,config,service,undefined,undefined,undefined,undefined,undefined,undefined,{source});
  const oldNow=Date.now;Date.now=()=>2_100_000_000_000;
  try{
    for(const url of ['/jsonRPC','/api/v2/jsonRPC']){
      const call=(method:string)=>app.inject({method:'POST',url,payload:{id:7,method,params:{address:addr}}});
      const response=await call('getAddressInformation');assert.equal(response.statusCode,200);const info=response.json().result;
      assert.equal(info.block_id.seqno,123);assert.equal(info.block_id.root_hash,Buffer.from(head.rootHashHex,'hex').toString('base64'));assert.equal(info.block_id.file_hash,Buffer.from(head.fileHashHex,'hex').toString('base64'));assert.equal(info.sync_utime,anchor.genUtime);assert.notEqual(info.sync_utime,Date.now()/1000);assert.equal(info.balance,'123456789');assert.equal(info.last_transaction_id.hash,Buffer.from('c'.repeat(64),'hex').toString('base64'));
      assert.equal((await call('getAddressBalance')).json().result,'123456789');assert.equal((await call('getMasterchainInfo')).json().result.last.seqno,123);
      for(const code of ['upstream_unavailable','upstream_timeout']){failure=code;const failed=await call('getAddressInformation');assert.equal(failed.statusCode,code.endsWith('timeout')?504:503);assert.equal(failed.json().ok,false);assert.equal(failed.json().error,code);assert(Number(failed.headers['retry-after'])>=1);}
      failure=undefined;
    }
    console.log('Both JSON-RPC mounts expose exact masterchain hashes and shard time or honest503/504, never wall-clock anchors.');
  }finally{Date.now=oldNow;await app.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});

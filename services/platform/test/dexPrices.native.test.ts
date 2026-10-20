import { describe, expect, it } from 'vitest';
import { DexPrices } from '../src/dexPrices.js';
import { config } from './helpers.js';
import { nativeDexFixtures } from './nativeDexFixtures.js';

describe('source-qualified current native DEX getters', () => {
  it('prices both original default/x6 pool snapshots as current covered TWAPs', async () => {
    let count=0;
    for(const fixture of nativeDexFixtures()) {
      const fetcher=async(_url:any,init:any)=>{
        const calls=JSON.parse(String(init.body)).calls;
        expect(calls.slice(3)).toEqual([{kind:'getter',address:fixture.release.markets[0]!.address,method:'get_pool_info',stack:[]},
          {kind:'getter',address:fixture.release.markets[0]!.address,method:'oracle_evidence',stack:[['num','0']]}]);
        return new Response(JSON.stringify(fixture.response));
      };
      const dex=new DexPrices(config({dexRelease:fixture.release,indexerUrls:{testnet:fixture.release.indexerUrl}}),fetcher,()=>new Date(fixture.now));
      const result=await dex.prices('testnet',[fixture.assetId]);
      expect(result.quotes[0],fixture.file).toMatchObject({status:'available',price:'1',evidence:{method:'pool_twap_median_v1',oracle:{medianPriceE9:'1000000000'}}});
      expect(result.quotes[0]!.evidence.oracle).toMatchObject({evidenceBoc:fixture.response.results[4]!.stack[0][1].bytes});
      count++;
    }
    expect(count).toBe(2);
  },60000);
});

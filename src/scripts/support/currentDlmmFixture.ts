import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import type { CurrentDlmmProofBinding } from '../../ledger/currentDlmmPhysical';
/** Test transport only: exact original collector fields and BOCs survive the
 * string-pooling compression. Sandbox heads are not consensus proofs. */
export function currentDlmmFixtures(){
 const d=JSON.parse(gunzipSync(readFileSync(join(__dirname,'../fixtures/current-dlmm-native/pool-operations.json.gz'))).toString());
 if(d.schema!=='tonswap-native-pool-claims-pooled-v1')throw Error('Current DLMM fixture schema');
 const expand=(v:any):any=>v&&typeof v==='object'?Array.isArray(v)?v.map(expand):Object.keys(v).length===1&&'originalString'in v?d.strings[v.originalString]:Object.fromEntries(Object.entries(v).map(([k,v])=>[k,expand(v)])):v;
 return expand(d.cases) as any[];
}
export function currentDlmmFixtureBinding(c:any):CurrentDlmmProofBinding{
 const {identity,wallets}=c.binding;
 return{release:identity.release,pools:[{pool:identity.pool,market:identity.market,t3:identity.t3,x:identity.x,wallets:Object.values(wallets)}]} as CurrentDlmmProofBinding;
}
/** Full setup plus selected failed/marked/delivered native histories; needed by
 * ordinary cash projection to authenticate the production Hub configuration. */
export function currentDlmmRecoveryOriginals(){
 const d=JSON.parse(gunzipSync(readFileSync(join(__dirname,'../fixtures/current-dlmm-native/pool-recovery-originals.json.gz'))).toString());
 if(d.schema!=='tonswap-current-dlmm-recovery-originals-pooled-v1')throw Error('Current DLMM original fixture schema');
 const expand=(v:any):any=>v&&typeof v==='object'?Array.isArray(v)?v.map(expand):Object.keys(v).length===1&&'originalString'in v?d.strings[v.originalString]:Object.fromEntries(Object.entries(v).map(([k,v])=>[k,expand(v)])):v;
 return expand(d.cases) as any[];
}
export function currentDlmmSpotOriginals(){
 const d=JSON.parse(gunzipSync(readFileSync(join(__dirname,'../fixtures/current-dlmm-native/spot-originals.json.gz'))).toString());
 if(d.schema!=='tonswap-current-dlmm-spot-originals-pooled-v1')throw Error('Current DLMM Spot fixture schema');
 const expand=(v:any):any=>v&&typeof v==='object'?Array.isArray(v)?v.map(expand):Object.keys(v).length===1&&'originalString'in v?d.strings[v.originalString]:Object.fromEntries(Object.entries(v).map(([k,v])=>[k,expand(v)])):v;
 return expand(d.cases) as any[];
}

export function currentDlmmOrderOriginals(){
 const d=JSON.parse(gunzipSync(readFileSync(join(__dirname,'../fixtures/current-dlmm-native/order-originals.json.gz'))).toString());
 if(d.schema!=='tonswap-current-dlmm-order-originals-pooled-v1')throw Error('Current DLMM Order fixture schema');
 const expand=(v:any):any=>v&&typeof v==='object'?Array.isArray(v)?v.map(expand):Object.keys(v).length===1&&'originalString'in v?d.strings[v.originalString]:Object.fromEntries(Object.entries(v).map(([k,v])=>[k,expand(v)])):v;
 return expand(d.cases) as any[];
}

/** Dedicated original deployment uses explicit on-chain T3 decimals=9. */
export function currentDlmmMarketOriginals(){
 const d=JSON.parse(gunzipSync(readFileSync(join(__dirname,'../fixtures/current-dlmm-native/market-originals.json.gz'))).toString());
 if(d.schema!=='tonswap-current-dlmm-market-originals-pooled-v1')throw Error('Current DLMM Market fixture schema');
 const expand=(v:any):any=>v&&typeof v==='object'?Array.isArray(v)?v.map(expand):Object.keys(v).length===1&&'originalString'in v?d.strings[v.originalString]:Object.fromEntries(Object.entries(v).map(([k,v])=>[k,expand(v)])):v;
 return expand(d.cases) as any[];
}

import { createHash } from 'node:crypto';
import { Cell, Dictionary } from '@ton/core';
import type { AccountStateResponse } from '../data/dataSource';
import type { Network } from '../models';
import type { LedgerEvidenceRef } from './types';

export const TEP64_SOURCE = 'https://github.com/ton-blockchain/TEPs/blob/master/text/0064-token-data-standard.md';
export type HistoricalRootArchive = {
  kind: 'masterchain-execution-bracket';
  provider: 'configured-ton-data-source';
  observedAt: string;
  executionSeqno: number;
  before: { seqno: number; state: AccountStateResponse };
  after: { seqno: number; state: AccountStateResponse };
};
export type HistoricalPrecisionContent = {
  layout: 'onchain' | 'semichain' | 'offchain' | 'invalid';
  contentBoc: string; contentHash: string;
  decimalsText: string | null; decimalsFieldBoc: string | null;
  uri: string | null; uriFieldBoc: string | null;
};
type HistoricalPrecisionBase = {
  network: Network; assetId: string; root: string;
  rootCodeHash: string; walletCodeHash: string;
  execution: LedgerEvidenceRef;
  standard: typeof TEP64_SOURCE;
  archive: HistoricalRootArchive | null;
  content: HistoricalPrecisionContent | null;
  issues: string[];
};
export type HistoricalJettonPrecision = HistoricalPrecisionBase & (
  { status: 'resolved'; decimals: number; method: 'onchain-explicit' | 'tep64-default' } |
  { status: 'unresolved'; decimals: null; method: null }
);
export type MarketAssetPrecision = { input: HistoricalJettonPrecision; output: HistoricalJettonPrecision };
export type RootPrecisionBinding = { network: Network; root: string; rootCodeHash: string; walletCodeHash: string };

const end = (s: ReturnType<Cell['beginParse']>) => { if(s.remainingBits || s.remainingRefs) throw Error('root_storage_trailing_data'); };
const cellValue = { serialize:(value:Cell,builder:ReturnType<typeof import('@ton/core')['beginCell']>)=>{builder.storeRef(value);}, parse:(s:ReturnType<Cell['beginParse']>)=>{const value=s.loadRef();end(s);return value;} };

/** Current JTRS writer layout only: registry, root data, burn receipts, mint state. */
export function readHistoricalJettonRoot(dataBoc: string) {
  const cell=Cell.fromBase64(dataBoc), s=cell.beginParse();
  if(s.loadUint(32)!==0x4a545253 || s.remainingBits || s.remainingRefs!==4) throw Error('root_storage_layout_unverified');
  const registry=s.loadRef().beginParse(); registry.loadMaybeAddress(); const enabled=registry.loadUint(8),withdrawalsOnly=registry.loadUint(8); registry.loadRef();end(registry);
  if(enabled>1 || withdrawalsOnly>1) throw Error('root_storage_flags_invalid');
  const data=s.loadRef().beginParse(), totalSupplyRaw=data.loadCoins().toString(); data.loadMaybeAddress();const walletCode=data.loadRef(),content=data.loadRef();data.loadMaybeAddress();end(data);
  const receipts=s.loadRef().beginParse();receipts.loadDict(Dictionary.Keys.BigUint(256),Dictionary.Values.BigUint(256));end(receipts);
  const mint=s.loadRef().beginParse();const nextWireId=mint.loadUintBig(64);if(nextWireId===0n)throw Error('root_mint_counter_invalid');
  mint.loadDict(Dictionary.Keys.BigUint(64),cellValue);mint.loadDict(Dictionary.Keys.BigUint(256),Dictionary.Values.BigUint(64));const tail=mint.loadRef().beginParse();end(mint);
  tail.loadDict(Dictionary.Keys.Address(),Dictionary.Values.BigUint(64));tail.loadDict(Dictionary.Keys.Address(),Dictionary.Values.BigUint(64));end(tail);end(s);
  return {totalSupplyRaw,walletCodeHash:walletCode.hash().toString('hex'),content,dataHash:cell.hash().toString('hex')};
}
const key=(name:string)=>createHash('sha256').update(name).digest();
const MAX_METADATA_BYTES=65536;
function snake(cell:Cell,prefixed:boolean):Buffer {
  const parts:Buffer[]=[];let n=0,current:Cell|undefined=cell;
  while(current) {
    const s=current.beginParse(); if(prefixed){if(s.loadUint(8)!==0)throw Error('metadata_snake_prefix_invalid');prefixed=false;}
    if(s.remainingBits%8 || s.remainingRefs>1)throw Error('metadata_snake_invalid');
    n+=s.remainingBits/8;if(n>MAX_METADATA_BYTES)throw Error('metadata_value_oversized');parts.push(s.loadBuffer(s.remainingBits/8));current=s.remainingRefs?s.loadRef():undefined;end(s);
  }
  return Buffer.concat(parts);
}
function dataBytes(cell:Cell):Buffer {
  const s=cell.beginParse(),tag=s.preloadUint(8);
  if(tag===0)return snake(cell,true);
  if(tag!==1)throw Error('metadata_value_format_unknown');
  s.loadUint(8);const chunks=s.loadDict(Dictionary.Keys.Uint(32),cellValue);end(s);
  const parts:Buffer[]=[];let total=0;const keys=[...chunks.keys()].sort((a,b)=>a-b);
  if(!keys.length)throw Error('metadata_chunks_empty');
  for(let i=0;i<keys.length;i++){if(keys[i]!==i)throw Error('metadata_chunks_incomplete');const part=snake(chunks.get(i)!,false);total+=part.length;if(total>MAX_METADATA_BYTES)throw Error('metadata_value_oversized');parts.push(part);}
  return Buffer.concat(parts);
}
function text(bytes:Buffer){return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
/** TEP64 ContentData prefixes are mandatory. No display-parser fallback. */
export function readHistoricalPrecisionContent(content:Cell) {
  const result:HistoricalPrecisionContent={layout:'invalid',contentBoc:content.toBoc().toString('base64'),contentHash:content.hash().toString('hex'),decimalsText:null,decimalsFieldBoc:null,uri:null,uriFieldBoc:null};
  try {
    const s=content.beginParse();if(s.remainingBits<8)throw Error('metadata_content_missing');const tag=s.loadUint(8);
    if(tag===1){result.layout='offchain';const uri=text(snake(content,false).subarray(1));if(!uri || !/^[\x20-\x7e]+$/.test(uri))throw Error('metadata_uri_invalid');result.uri=uri;return {content:result,decimals:null,method:null,issue:'metadata_remote_precision_unverified'} as const;}
    if(tag!==0)throw Error('metadata_content_format_unknown');
    const dict=s.loadDict(Dictionary.Keys.Buffer(32),cellValue);end(s);
    const decimals=dict.get(key('decimals')),uri=dict.get(key('uri'));result.layout=uri?'semichain':'onchain';
    if(uri){result.uriFieldBoc=uri.toBoc().toString('base64');try{const value=text(dataBytes(uri));if(value && /^[\x20-\x7e]+$/.test(value))result.uri=value;}catch{/* Retain URI bytes without fetching; explicit on-chain precision has precedence. */}}
    if(decimals){result.decimalsFieldBoc=decimals.toBoc().toString('base64');const value=text(dataBytes(decimals));result.decimalsText=value;
      if(!/^[0-9]{1,3}$/.test(value) || Number(value)>255)throw Error('metadata_decimals_invalid');
      return {content:result,decimals:Number(value),method:'onchain-explicit',issue:null} as const;
    }
    if(uri)return {content:result,decimals:null,method:null,issue:'metadata_remote_precision_unverified'} as const;
    // A valid fully on-chain dictionary proves omission; a missing or malformed
    // content cell does not. This distinction is mandated by TEP64.
    return {content:result,decimals:9,method:'tep64-default',issue:null} as const;
  } catch(error) {return {content:result,decimals:null,method:null,issue:error instanceof Error?error.message:'metadata_unverified'} as const;}
}
const rawAddress=(v:unknown)=>typeof v==='string' && /^(?:0|-1):[a-f0-9]{64}$/.test(v);
const hash=(v:unknown)=>typeof v==='string' && /^[a-f0-9]{64}$/.test(v);
const canonicalHash=(v:string)=>{if(hash(v))return v;if(typeof v!=='string'||!/^[A-Za-z0-9+/_-]{43}=?$/.test(v))throw Error('root_archive_identity_unverified');const normalized=v.replace(/-/g,'+').replace(/_/g,'/').replace(/=$/,'');const bytes=Buffer.from(normalized,'base64');if(bytes.length!==32||bytes.toString('base64').replace(/=$/,'')!==normalized)throw Error('root_archive_identity_unverified');return bytes.toString('hex');};
function requireOrdinaryCells(root:Cell) {
  const pending=[root],seen=new Set<Cell>();
  while(pending.length){const cell=pending.pop()!;if(seen.has(cell))continue;seen.add(cell);if(cell.isExotic)throw Error('root_archive_exotic_cell');pending.push(...cell.refs);}
}
const boc=(v:unknown)=>{if(typeof v!=='string' || !v || v.length>4*1024*1024 || Buffer.from(v,'base64').toString('base64')!==v)throw Error('root_archive_boc_invalid');const cells=Cell.fromBoc(Buffer.from(v,'base64'));if(cells.length!==1)throw Error('root_archive_boc_invalid');requireOrdinaryCells(cells[0]);return cells[0];};
export function resolveHistoricalJettonPrecision(binding:RootPrecisionBinding,execution:LedgerEvidenceRef,archive:HistoricalRootArchive|null):HistoricalJettonPrecision {
  const base:HistoricalPrecisionBase={...binding,assetId:`${binding.network}:jetton:${binding.root}`,execution:{...execution},standard:TEP64_SOURCE,archive:archive?structuredClone(archive):null,content:null,issues:[]};
  const unresolved=(issue:string):HistoricalJettonPrecision=>({...base,status:'unresolved',decimals:null,method:null,issues:[issue]});
  try {
    if(!['mainnet','testnet','localnet'].includes(binding.network) || !rawAddress(binding.root) || !hash(binding.rootCodeHash) || !hash(binding.walletCodeHash))throw Error('root_precision_binding_invalid');
    if(!rawAddress(execution.account) || !/^[1-9][0-9]{0,19}$/.test(execution.lt) || BigInt(execution.lt)>0xffffffffffffffffn || !hash(execution.hash) || !Number.isSafeInteger(execution.utime) || execution.utime<0)throw Error('root_execution_identity_invalid');
    if(!archive)return unresolved('root_execution_archive_unavailable');
    if(archive.kind!=='masterchain-execution-bracket' || archive.provider!=='configured-ton-data-source' || !Number.isSafeInteger(archive.executionSeqno) || archive.executionSeqno<=0 ||
      archive.before?.seqno!==archive.executionSeqno-1 || archive.after?.seqno!==archive.executionSeqno || !Number.isFinite(Date.parse(archive.observedAt)) || new Date(archive.observedAt).toISOString()!==archive.observedAt)throw Error('root_execution_bracket_invalid');
    const parsed=[];
    for(const point of [archive.before,archive.after]) {
      const state=point.state;
      if(state.accountState!=='active' || !state.lastTxLt || !/^[1-9][0-9]{0,19}$/.test(state.lastTxLt) || BigInt(state.lastTxLt)>0xffffffffffffffffn || !state.lastTxHash || !hash(canonicalHash(state.lastTxHash)))throw Error('root_archive_identity_unverified');
      const code=boc(state.codeBoc);if(code.hash().toString('hex')!==binding.rootCodeHash)throw Error('root_archive_code_unverified');
      boc(state.dataBoc);const root=readHistoricalJettonRoot(state.dataBoc!);if(root.walletCodeHash!==binding.walletCodeHash)throw Error('root_archive_wallet_code_unverified');parsed.push(root);
    }
    if(parsed[0].content.hash().toString('hex')!==parsed[1].content.hash().toString('hex'))throw Error('root_precision_changed_across_execution_block');
    // Both sides of the containing block use the configured current root code.
    // That reviewed implementation has no content update or SETCODE handler;
    // supply/mint activity may change other state without changing precision.
    const read=readHistoricalPrecisionContent(parsed[0].content);base.content=read.content;
    if(read.issue)return unresolved(read.issue);
    return {...base,status:'resolved',decimals:read.decimals!,method:read.method!,issues:[]};
  } catch(error) {return unresolved(error instanceof Error?error.message:'root_precision_unverified');}
}
export function validateHistoricalJettonPrecision(value:HistoricalJettonPrecision,binding:RootPrecisionBinding,execution:LedgerEvidenceRef) {
  if(!value || typeof value!=='object')throw Error('Invalid historical precision');
  const expected=resolveHistoricalJettonPrecision(binding,execution,value.archive);
  const stable=(v:unknown):unknown=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,stable(x)])):v;
  if(JSON.stringify(stable(value))!==JSON.stringify(stable(expected)))throw Error('Invalid historical precision');
}

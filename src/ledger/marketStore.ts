import { routingEvidenceRefs } from './routedEvidence';
import { validateHistoricalJettonPrecision } from './jettonPrecision';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Cell } from '@ton/core';
import type { Network } from '../models';
import type { LedgerEvidenceRef } from './types';
import type { LedgerSqlPool } from './store';
import type { DlmmMarketBinding, MarketBoundaryEvidence, MarketDependency, MarketObservation, MarketCandidate, MarketProjection } from './marketTypes';

export class MarketCursorError extends Error {}
export class MarketPublicationConflict extends Error {}
export type MarketGeneration = { generation: string; fingerprint: string; publishedAt: string };
export type MarketQuery = { from?: number; to?: number; limit?: number; cursor?: string; generation?: string };
export type MarketCoverage = MarketGeneration & Omit<MarketProjection, 'observations' | 'candidates'> & { candidateCounts: Record<MarketCandidate['status'], number>; totalObservations: number };
export type MarketPage = { network: Network; pool: string; observations: MarketObservation[]; nextCursor: string | null; coverage: MarketCoverage | null };
export type MarketCandidatePage = { network: Network; pool: string; candidates: MarketCandidate[]; nextCursor: string | null; coverage: MarketCoverage | null };
type Cursor = { schema: 'dlmm-market-cursor-v1'; kind: 'observations' | 'candidates'; network: Network; pool: string; generation: string; from: number | null; to: number | null; utime: number; id: string };
const RAW = /^(?:0|-1):[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const COINS_MAX = (1n << 120n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;
function invalid(label: string): never { throw new Error(`Invalid market projection: ${label}`); }
function object(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== keys.sort().join(',')) invalid(label);
}
function array(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value) || Array.from({ length: value.length }, (_, i) => i).some(i => !Object.hasOwn(value, i))) invalid(label);
}
function strings(value: unknown, label: string) {
  array(value, label);
  if (value.some(v => typeof v !== 'string' || !v.length || v.length > 512) || new Set(value).size !== value.length) invalid(label);
}
function address(value: unknown, label: string): asserts value is string { if (typeof value !== 'string' || !RAW.test(value)) invalid(label); }
function hash(value: unknown, label: string): asserts value is string { if (typeof value !== 'string' || !HASH.test(value)) invalid(label); }
function id(value: unknown, label: string): asserts value is string { if (typeof value !== 'string' || !value || value.length > 512 || /[\s\x00-\x1f]/.test(value)) invalid(label); }
function time(value: unknown, label: string): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 253402300799) invalid(label); }
function atomic(value: unknown, label: string, positive = false, max = COINS_MAX): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 37) invalid(label);
  const n = BigInt(value); if (n > max || (positive && n === 0n)) invalid(label); return n;
}
function iso(value: unknown, label: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(label);
}
function ref(value: LedgerEvidenceRef, label: string) {
  object(value, ['account', 'lt', 'hash', 'utime'], label); address(value.account, label); hash(value.hash, label); atomic(value.lt, label, true, UINT64_MAX); time(value.utime, label);
}
function refId(value: LedgerEvidenceRef) { return `${value.account}:${value.lt}:${value.hash}`; }
function observationId(network: Network, acceptance: LedgerEvidenceRef) { return createHash('sha256').update(`dlmm-market-v1:${network}:${refId(acceptance)}`).digest('hex'); }
function boundary(value: MarketBoundaryEvidence, label: string) {
  object(value, ['transaction','beforeSeqno','afterSeqno','beforeDataHash','beforeAccountState','afterDataHash','codeHash'], label); ref(value.transaction, label);
  if (!Number.isSafeInteger(value.beforeSeqno) || value.beforeSeqno < 0 || !Number.isSafeInteger(value.afterSeqno) || value.afterSeqno < value.beforeSeqno) invalid(label);
  if(value.beforeAccountState==='active') hash(value.beforeDataHash,label); else if(value.beforeAccountState!=='uninitialized' || value.beforeDataHash!==null) invalid(label); hash(value.afterDataHash, label); hash(value.codeHash, label);
}
function boundaries(values: MarketBoundaryEvidence[], label: string) { array(values, label); if (!values.length) invalid(label); for (const value of values) boundary(value, label); }
function binding(value: DlmmMarketBinding) {
  object(value, ['network','pool','poolCodeHash','walletCodeHash','tokenT','tokenX','tokenTCodeHash','tokenXCodeHash','router','routerCodeHash'], 'binding');
  if (!['mainnet','testnet','localnet'].includes(value.network)) invalid('network');
  address(value.pool, 'pool'); address(value.tokenT, 'token T'); address(value.tokenX, 'token X');
  if ((value.router === null) !== (value.routerCodeHash === null)) invalid('router binding');
  if (value.router !== null) { address(value.router, 'router'); hash(value.routerCodeHash, 'router code'); }
  if (value.tokenT === value.tokenX) invalid('distinct roots'); hash(value.poolCodeHash, 'pool code'); hash(value.walletCodeHash, 'wallet code'); hash(value.tokenTCodeHash,'root T code'); hash(value.tokenXCodeHash,'root X code');
}
function observation(value: MarketObservation, b: DlmmMarketBinding) {
  object(value, ['id','network','pool','kind','acceptance','executionUtime','deliveredUtime','finalizedUtime','payer','recipient','businessQueryId','inputAsset','outputAsset','assetPrecision','paidInputRaw','returnedInputRaw','consumedInputRaw','outputRaw','ratio','input','allocation','settlements','routing','fees'], 'observation');
  id(value.id, 'observation ID'); if (value.network !== b.network || value.pool !== b.pool || value.kind !== 'settled_dlmm_execution') invalid('observation binding');
  ref(value.acceptance, 'acceptance'); if (value.id !== observationId(b.network, value.acceptance)) invalid('observation ID identity'); if (value.acceptance.account !== b.pool) invalid('acceptance pool');
  for (const timestamp of [value.executionUtime,value.deliveredUtime,value.finalizedUtime]) time(timestamp, 'observation time');
  if (value.executionUtime !== value.acceptance.utime || value.deliveredUtime < value.executionUtime || value.finalizedUtime < value.deliveredUtime) invalid('observation chronology');
  address(value.payer, 'payer'); address(value.recipient, 'recipient'); atomic(value.businessQueryId, 'business query', false, UINT64_MAX);
  if(value.input?.request?.account!==value.payer) invalid('original payer request');
  const roots = [b.tokenT,b.tokenX].map(root => `${b.network}:jetton:${root}`);
  if (!roots.includes(value.inputAsset) || !roots.includes(value.outputAsset) || value.inputAsset === value.outputAsset) invalid('observation assets');
  object(value.assetPrecision,['input','output'],'asset precision');
  for(const side of ['input','output'] as const) { const root=value[side==='input'?'inputAsset':'outputAsset']===roots[0]?b.tokenT:b.tokenX; validateHistoricalJettonPrecision(value.assetPrecision[side],{network:b.network,root,rootCodeHash:root===b.tokenT?b.tokenTCodeHash:b.tokenXCodeHash,walletCodeHash:b.walletCodeHash},value.acceptance); }
  const paid = atomic(value.paidInputRaw, 'paid input', true), returned = atomic(value.returnedInputRaw, 'returned input');
  const consumed = atomic(value.consumedInputRaw, 'consumed input', true), output = atomic(value.outputRaw, 'output', true);
  if (paid !== returned + consumed) invalid('input conservation');
  object(value.ratio, ['numerator','denominator','unit','includesTradingFees'], 'ratio');
  const n = atomic(value.ratio.numerator, 'ratio numerator', true), d = atomic(value.ratio.denominator, 'ratio denominator', true);
  let a=n, z=d; while (z) { const q=a%z; a=z; z=q; }
  if (value.ratio.unit !== 'output_atomic_per_input_atomic' || value.ratio.includesTradingFees !== true || n * consumed !== d * output || a !== 1n) invalid('exact reduced ratio');
  object(value.input, ['request','debit','credit','boundaries'], 'input');
  for (const key of ['request','debit','credit'] as const) ref(value.input[key], `input ${key}`);
  boundaries(value.input.boundaries, 'input boundaries'); boundary(value.allocation, 'allocation');
  if(value.allocation.beforeAccountState!=='active') invalid('pool allocation state');
  if (refId(value.allocation.transaction) !== refId(value.acceptance)) invalid('allocation identity');
  for(const precision of [value.assetPrecision.input,value.assetPrecision.output]) if(precision.archive && precision.archive.executionSeqno!==value.allocation.afterSeqno) invalid('precision execution block');
  array(value.settlements, 'settlements'); if (!value.settlements.length) invalid('settlements');
  let totalOutput=0n,totalRefund=0n; const sids=new Set<string>();
  for (const s of value.settlements) {
    object(s, ['settlementId','kind','amountRaw','sourceWallet','destinationWallet','destinationOwner','requestBodyHash','requestBodyBoc','request','debit','credit','acknowledged','walletFinalized','poolFinalized','boundaries'], 'settlement');
    atomic(s.settlementId, 'settlement ID', true, UINT64_MAX); if(sids.has(s.settlementId)) invalid('duplicate settlement ID'); sids.add(s.settlementId);
    const amount=atomic(s.amountRaw, 'settlement amount', true);
    if(s.kind==='swap_output') totalOutput+=amount; else if(s.kind==='unused_input_refund') totalRefund+=amount; else invalid('settlement kind');
    for (const v of [s.sourceWallet,s.destinationWallet,s.destinationOwner]) address(v,'settlement endpoint');
    hash(s.requestBodyHash, 'request body hash');
    if (typeof s.requestBodyBoc !== 'string' || s.requestBodyBoc.length > 65536 || !s.requestBodyBoc.length || Buffer.from(s.requestBodyBoc,'base64').toString('base64') !== s.requestBodyBoc) invalid('request BOC');
    try { const cells=Cell.fromBoc(Buffer.from(s.requestBodyBoc,'base64')); if(cells.length!==1 || cells[0].hash().toString('hex')!==s.requestBodyHash) invalid('request BOC identity'); } catch { invalid('request BOC identity'); }
    for (const key of ['request','debit','credit','acknowledged','walletFinalized','poolFinalized'] as const) ref(s[key], `settlement ${key}`);
    if (s.request.account!==b.pool || s.debit.account!==s.sourceWallet || s.credit.account!==s.destinationWallet || s.acknowledged.account!==b.pool || s.walletFinalized.account!==s.sourceWallet || s.poolFinalized.account!==b.pool) invalid('settlement evidence endpoints');
    if(s.destinationOwner!==(value.routing?b.router:s.kind==='swap_output'?value.recipient:value.payer)) invalid('settlement owner');
    if(s.request.utime < value.executionUtime || s.credit.utime < s.request.utime || s.walletFinalized.utime < s.credit.utime || s.poolFinalized.utime < s.walletFinalized.utime) invalid('settlement chronology');
    boundaries(s.boundaries, 'settlement boundaries');
  }
  if(totalOutput!==output || totalRefund!==returned) invalid('settlement conservation');
  validateRouting(value,b);
  const routing=value.routing;
  const routeLegs=routing?[routing.inputSettlement,routing.terminalSettlement,...(routing.protocolFeeSettlement?[routing.protocolFeeSettlement]:[])]:[];
  const creditIds=new Set([...routeLegs.map(s=>refId(s.credit)),refId(value.input.credit),...value.settlements.map(s=>refId(s.credit))]);
  const allBoundaries=[...value.input.boundaries,value.allocation,...value.settlements.flatMap(s=>s.boundaries),...routeLegs.flatMap(s=>s.boundaries),...(routing?.boundaries??[])];
  for(const bnd of allBoundaries) if(bnd.codeHash!==(bnd.transaction.account===b.pool?b.poolCodeHash:bnd.transaction.account===b.router?b.routerCodeHash:b.walletCodeHash) || bnd.beforeAccountState==='uninitialized' && !creditIds.has(refId(bnd.transaction))) invalid('boundary binding');
  for(const r of [value.input.debit,value.input.credit,...value.settlements.flatMap(s=>[s.request,s.debit,s.credit,s.acknowledged,s.walletFinalized,s.poolFinalized])]) if(!allBoundaries.some(b=>refId(b.transaction)===refId(r))) invalid('missing transaction boundary');
  if ((routing?routing.terminalSettlement.credit.utime:Math.max(...value.settlements.map(s=>s.credit.utime)))!==value.deliveredUtime || (routing?routing.terminalSettlement.routerFinalized.utime:Math.max(...value.settlements.map(s=>s.poolFinalized.utime)))!==value.finalizedUtime) invalid('settlement times');
  array(value.fees, 'fees'); const fees=new Set<string>();
  for (const fee of value.fees) { object(fee,['transaction','nativeAmountRaw'],'fee'); ref(fee.transaction,'fee transaction'); const k=refId(fee.transaction); if(fees.has(k)) invalid('duplicate fee'); fees.add(k); if(fee.nativeAmountRaw!==null) atomic(fee.nativeAmountRaw,'fee amount'); }
}

function validateRouting(value: MarketObservation,b:DlmmMarketBinding) {
  const r=value.routing;if(r===null)return;
  object(r,['router','businessId','requestHash','completionHash','routerAcceptance','completion','completionAcknowledged','inputSettlement','terminalSettlement','protocolFeeSettlement','boundaries'],'routing');
  if(!b.router || !b.routerCodeHash || r.router!==b.router)invalid('routing binding');
  atomic(r.businessId,'router business ID',true,UINT64_MAX);hash(r.requestHash,'router request hash');hash(r.completionHash,'router completion hash');
  for(const e of [r.routerAcceptance,r.completion,r.completionAcknowledged])ref(e,'routing transaction');
  if(r.routerAcceptance.account!==b.router || r.completion.account!==b.router || r.completionAcknowledged.account!==b.pool ||
    BigInt(r.routerAcceptance.lt)>=BigInt(value.acceptance.lt) || BigInt(r.completion.lt)<=BigInt(value.acceptance.lt) || BigInt(r.completionAcknowledged.lt)<=BigInt(r.completion.lt))invalid('routing chronology');
  boundaries(r.boundaries,'routing boundaries');
  const legs=[r.inputSettlement,r.terminalSettlement];
  if(legs[0].kind!==12 || legs[0].amountRaw!==value.paidInputRaw || legs[0].destinationOwner!==b.pool ||
    legs[1].kind!==8 || legs[1].amountRaw!==value.outputRaw || legs[1].destinationOwner!==value.recipient || value.returnedInputRaw!=='0')invalid('routing cash conservation');
  for(const leg of [...legs,...(r.protocolFeeSettlement?[r.protocolFeeSettlement]:[])]) {
    const pool='poolFinalized' in leg,final=pool?leg.poolFinalized:leg.routerFinalized,controller=pool?b.pool:b.router;
    object(leg,['settlementId','kind','amountRaw','sourceWallet','destinationWallet','destinationOwner','requestBodyHash','requestBodyBoc','request','debit','credit','acknowledged','walletFinalized',pool?'poolFinalized':'routerFinalized','boundaries'],'routing leg');
    atomic(leg.settlementId,'routing settlement ID',true,UINT64_MAX);atomic(leg.amountRaw,'routing amount',true);
    for(const a of [leg.sourceWallet,leg.destinationWallet,leg.destinationOwner])address(a,'routing endpoint');hash(leg.requestBodyHash,'routing request hash');
    try {const cells=Cell.fromBoc(Buffer.from(leg.requestBodyBoc,'base64'));if(cells.length!==1||cells[0].hash().toString('hex')!==leg.requestBodyHash)invalid('routing request BOC');}catch{invalid('routing request BOC');}
    for(const e of [leg.request,leg.debit,leg.credit,leg.acknowledged,leg.walletFinalized,final])ref(e,'routing leg evidence');
    if(leg.request.account!==controller || leg.acknowledged.account!==controller || final.account!==controller || leg.debit.account!==leg.sourceWallet || leg.walletFinalized.account!==leg.sourceWallet || leg.credit.account!==leg.destinationWallet)invalid('routing leg endpoints');
    if(BigInt(leg.request.lt)>=BigInt(leg.debit.lt)||BigInt(leg.debit.lt)>=BigInt(leg.credit.lt)||BigInt(leg.credit.lt)>=BigInt(leg.acknowledged.lt)||BigInt(leg.acknowledged.lt)>=BigInt(leg.walletFinalized.lt)||BigInt(leg.walletFinalized.lt)>=BigInt(final.lt))invalid('routing leg chronology');
    boundaries(leg.boundaries,'routing leg boundaries');
    for(const e of [leg.request,leg.debit,leg.credit,leg.acknowledged,leg.walletFinalized,final])if(!leg.boundaries.some(b=>refId(b.transaction)===refId(e)))invalid('routing leg missing boundary');
    if(pool && (leg.kind!==9 || leg.destinationOwner!==b.router))invalid('routing protocol fee');
  }
  if(refId(legs[0].request)!==refId(r.routerAcceptance)||BigInt(legs[0].routerFinalized.lt)>=BigInt(value.acceptance.lt)||refId(legs[1].request)!==refId(r.completion))invalid('routing transition linkage');
  for(const e of [r.routerAcceptance,r.completion,r.completionAcknowledged])if(!r.boundaries.some(b=>refId(b.transaction)===refId(e)))invalid('routing boundary missing');
}

function stable(value: unknown): unknown {
  if(Array.isArray(value)) return value.map(stable);
  if(value && typeof value==='object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)]));
  return value;
}
/** Validate canonical physical evidence; this does not replace the on-chain projector. */
export function validateMarketProjection(value: MarketProjection): void {
  object(value,['schema','binding','dependencies','observations','candidates','issues','historyComplete'],'projection');
  if(value.schema!=='dlmm-market-ledger-v1' || typeof value.historyComplete!=='boolean') invalid('schema'); binding(value.binding);
  strings(value.issues,'issues'); array(value.dependencies,'dependencies'); const dependencies=new Map<string,MarketDependency>();
  for(const dep of value.dependencies) {
    object(dep,['account','generation','historyComplete','headLt','headHash','checkedThrough'],'dependency'); address(dep.account,'dependency account');
    if(typeof dep.generation!=='string' || !UUID.test(dep.generation) || typeof dep.historyComplete!=='boolean') invalid('dependency generation');
    atomic(dep.headLt,'dependency LT',false,UINT64_MAX); hash(dep.headHash,'dependency head'); if(dep.headLt==='0' && dep.headHash!=='0'.repeat(64)) invalid('empty dependency head'); iso(dep.checkedThrough,'dependency checked through');
    if(dependencies.has(dep.account)) invalid('duplicate dependency'); dependencies.set(dep.account,dep);
  }
  if(!dependencies.has(value.binding.pool) || value.historyComplete && value.dependencies.some(dep=>!dep.historyComplete)) invalid('dependency coverage');
  array(value.observations,'observations'); const observations=new Map<string,MarketObservation>(),acceptances=new Set<string>();
  for(const o of value.observations) { observation(o,value.binding); if(observations.has(o.id) || acceptances.has(refId(o.acceptance))) invalid('duplicate observation'); observations.set(o.id,o); acceptances.add(refId(o.acceptance));
    const refs=[o.acceptance,o.input.request,o.input.debit,o.input.credit,...o.input.boundaries.map(b=>b.transaction),o.allocation.transaction,...o.fees.map(f=>f.transaction),...routingEvidenceRefs(o.routing),...o.settlements.flatMap(s=>[s.request,s.debit,s.credit,s.acknowledged,s.walletFinalized,s.poolFinalized,...s.boundaries.map(b=>b.transaction)])];
    for(const r of refs) { const dep=dependencies.get(r.account); if(!dep || BigInt(r.lt)>BigInt(dep.headLt) || r.lt===dep.headLt && r.hash!==dep.headHash || r.utime*1000>Date.parse(dep.checkedThrough)) invalid('evidence outside dependency coverage'); }
  }
  array(value.candidates,'candidates'); const candidates=new Set<string>(),candidateAcceptances=new Set<string>(),observed=new Set<string>();
  for(const c of value.candidates) {
    object(c,['id','acceptance','status','issues','observationId'],'candidate'); id(c.id,'candidate ID'); ref(c.acceptance,'candidate acceptance'); strings(c.issues,'candidate issues');
    if(c.id!==observationId(value.binding.network,c.acceptance)) invalid('candidate ID identity');
    if(c.acceptance.account!==value.binding.pool || candidates.has(c.id) || candidateAcceptances.has(refId(c.acceptance))) invalid('duplicate or foreign candidate');
    const dep=dependencies.get(c.acceptance.account)!; if(BigInt(c.acceptance.lt)>BigInt(dep.headLt) || c.acceptance.lt===dep.headLt && c.acceptance.hash!==dep.headHash || c.acceptance.utime*1000>Date.parse(dep.checkedThrough)) invalid('candidate coverage');
    candidates.add(c.id); candidateAcceptances.add(refId(c.acceptance));
    if(c.status==='settled') { const o=typeof c.observationId==='string' && observations.get(c.observationId); if(!o || refId(o.acceptance)!==refId(c.acceptance) || c.issues.length || observed.has(o.id)) invalid('candidate observation'); observed.add(o.id); }
    else if(!['refunded','unresolved'].includes(c.status) || c.observationId!==null || c.status==='unresolved' && !c.issues.length) invalid('candidate status');
  }
  if(observed.size!==observations.size) invalid('unlinked observation');
  if(value.historyComplete && (value.issues.length || value.candidates.some(c=>c.status==='unresolved'))) invalid('incomplete history claimed complete');
}
function canonicalProjection(input: MarketProjection): MarketProjection {
  const value=structuredClone(input); validateMarketProjection(value);
  value.dependencies.sort((a,b)=>a.account.localeCompare(b.account)); value.observations.sort((a,b)=>a.id.localeCompare(b.id)); value.candidates.sort((a,b)=>a.id.localeCompare(b.id)); value.issues.sort();
  for(const c of value.candidates) c.issues.sort();
  return stable(value) as MarketProjection;
}
export function marketProjectionFingerprint(projection: MarketProjection): string { return createHash('sha256').update(JSON.stringify(canonicalProjection(projection))).digest('hex'); }
function queryContext(network: Network,pool: string,query: MarketQuery) {
  if(!['mainnet','testnet','localnet'].includes(network) || !RAW.test(pool)) throw new MarketCursorError('Invalid market identity');
  for(const n of [query.from,query.to]) if(n!==undefined && (!Number.isSafeInteger(n) || n<0 || n>253402300799)) throw new MarketCursorError('Invalid market time range');
  if(query.from!==undefined && query.to!==undefined && query.from>=query.to) throw new MarketCursorError('Invalid market time range');
  if(query.limit!==undefined && (!Number.isInteger(query.limit) || query.limit<1 || query.limit>500)) throw new MarketCursorError('Invalid market page limit');
  if(query.generation!==undefined && !UUID.test(query.generation)) throw new MarketCursorError('Invalid market generation');
}
function parseCursor(encoded: string): Cursor {
  try {
    if(typeof encoded!=='string' || encoded.length>4096 || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw Error();
    const bytes=Buffer.from(encoded,'base64url'); if(bytes.toString('base64url')!==encoded) throw Error(); const c=JSON.parse(bytes.toString('utf8')) as Cursor;
    object(c,['schema','kind','network','pool','generation','from','to','utime','id'],'cursor');
    if(c.schema!=='dlmm-market-cursor-v1' || !['observations','candidates'].includes(c.kind) || !UUID.test(c.generation)) throw Error(); queryContext(c.network,c.pool,{from:c.from??undefined,to:c.to??undefined});
    if(c.from!==null && typeof c.from!=='number' || c.to!==null && typeof c.to!=='number') throw Error(); time(c.utime,'cursor time'); id(c.id,'cursor ID'); return c;
  } catch { throw new MarketCursorError('Invalid market cursor'); }
}

export class PostgresMarketStore {
  constructor(readonly pool: LedgerSqlPool) {}
  async initialize() {
    const client=await this.pool.connect();
    try { await client.query("SELECT pg_advisory_lock(hashtextextended('tonswap:ledger:schema',0))"); await client.query(readFileSync(resolve(__dirname,'../../sql/ledger.sql'),'utf8')); }
    finally { try { await client.query("SELECT pg_advisory_unlock(hashtextextended('tonswap:ledger:schema',0))"); } finally { client.release?.(); } }
  }
  async current(network: Network,pool: string): Promise<MarketGeneration|null> {
    queryContext(network,pool,{});
    const row=(await this.pool.query(`SELECT g.generation,g.fingerprint,g.published_at FROM market_heads h JOIN market_generations g ON g.generation=h.current_generation AND g.network=h.network AND g.pool=h.pool WHERE h.network=$1 AND h.pool=$2`,[network,pool])).rows[0];
    return row ? {generation:row.generation,fingerprint:row.fingerprint,publishedAt:new Date(row.published_at).toISOString()} : null;
  }
  async publish(input: MarketProjection,expectedCurrentGeneration: string|null): Promise<MarketGeneration & {reused:boolean}> {
    const projection=canonicalProjection(input), fingerprint=marketProjectionFingerprint(projection),{network,pool}=projection.binding;
    if(expectedCurrentGeneration!==null && !UUID.test(expectedCurrentGeneration)) throw new MarketPublicationConflict('Invalid expected market generation');
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO market_heads(network,pool) VALUES($1,$2) ON CONFLICT DO NOTHING',[network,pool]);
      const head=(await client.query('SELECT current_generation FROM market_heads WHERE network=$1 AND pool=$2 FOR UPDATE',[network,pool])).rows[0];
      const prior=(await client.query('SELECT generation,fingerprint,published_at FROM market_generations WHERE network=$1 AND pool=$2 AND fingerprint=$3',[network,pool,fingerprint])).rows[0];
      if(prior) { await client.query('COMMIT'); return {generation:prior.generation,fingerprint:prior.fingerprint,publishedAt:new Date(prior.published_at).toISOString(),reused:true}; }
      if(head.current_generation!==expectedCurrentGeneration) throw new MarketPublicationConflict('Market generation changed during projection');
      const generation=randomUUID();
      const {observations,candidates,...rest}=projection;
      const metadata={...rest,totalObservations:observations.length,candidateCounts:{settled:0,refunded:0,unresolved:0}};
      for(const c of candidates) metadata.candidateCounts[c.status]++;
      const row=(await client.query(`INSERT INTO market_generations(generation,network,pool,fingerprint,metadata) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING published_at`,[generation,network,pool,fingerprint,JSON.stringify(metadata)])).rows[0];
      for(const c of projection.candidates) await client.query(`INSERT INTO market_candidates(generation,candidate_id,execution_utime,candidate) VALUES($1,$2,$3,$4::jsonb)`,[generation,c.id,c.acceptance.utime,JSON.stringify(c)]);
      for(const o of projection.observations) await client.query(`INSERT INTO market_observations(generation,observation_id,execution_utime,observation) VALUES($1,$2,$3,$4::jsonb)`,[generation,o.id,o.executionUtime,JSON.stringify(o)]);
      await client.query('UPDATE market_heads SET current_generation=$3 WHERE network=$1 AND pool=$2',[network,pool,generation]); await client.query('COMMIT');
      return {generation,fingerprint,publishedAt:new Date(row.published_at).toISOString(),reused:false};
    } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release?.(); }
  }
  async page(network:Network,pool:string,query:MarketQuery={}):Promise<MarketPage> {
    const page=await this.records('observations',network,pool,query);
    return {network,pool,observations:page.items as MarketObservation[],nextCursor:page.nextCursor,coverage:page.coverage};
  }
  async candidatesPage(network:Network,pool:string,query:MarketQuery={}):Promise<MarketCandidatePage> {
    const page=await this.records('candidates',network,pool,query);
    return {network,pool,candidates:page.items as MarketCandidate[],nextCursor:page.nextCursor,coverage:page.coverage};
  }
  private async records(kind:Cursor['kind'],network:Network,pool:string,query:MarketQuery):Promise<{items:(MarketObservation|MarketCandidate)[];nextCursor:string|null;coverage:MarketCoverage|null}> {
    queryContext(network,pool,query); const cursor=query.cursor!==undefined?parseCursor(query.cursor):null; const from=query.from??null,to=query.to??null;
    if(cursor && (cursor.kind!==kind || cursor.network!==network || cursor.pool!==pool || cursor.from!==from || cursor.to!==to || query.generation!==undefined && query.generation!==cursor.generation)) throw new MarketCursorError('Market cursor query mismatch');
    const generation=cursor?.generation??query.generation??(await this.current(network,pool))?.generation;
    if(!generation) return {items:[],nextCursor:null,coverage:null};
    const row=(await this.pool.query('SELECT metadata,fingerprint,published_at FROM market_generations WHERE generation=$1 AND network=$2 AND pool=$3',[generation,network,pool])).rows[0];
    if(!row) throw new MarketCursorError('Market generation not found');
    object(row.metadata,['schema','binding','dependencies','issues','historyComplete','totalObservations','candidateCounts'],'stored metadata');
    binding(row.metadata.binding as DlmmMarketBinding);
    const metadata=row.metadata as Omit<MarketCoverage,keyof MarketGeneration>;
    if(metadata.binding.network!==network || metadata.binding.pool!==pool || metadata.schema!=='dlmm-market-ledger-v1' || typeof metadata.historyComplete!=='boolean' || !HASH.test(row.fingerprint)) invalid('stored metadata');
    strings(metadata.issues,'stored issues'); array(metadata.dependencies,'stored dependencies');
    // Reuse canonical admission for coverage even when this page contains no rows.
    validateMarketProjection({schema:metadata.schema,binding:metadata.binding,dependencies:metadata.dependencies,issues:metadata.issues,historyComplete:metadata.historyComplete,observations:[],candidates:[]});
    object(metadata.candidateCounts,['settled','refunded','unresolved'],'stored counts');
    if([metadata.totalObservations,...Object.values(metadata.candidateCounts)].some(v=>!Number.isSafeInteger(v)||v<0) || metadata.candidateCounts.settled!==metadata.totalObservations || metadata.historyComplete && metadata.candidateCounts.unresolved!==0) invalid('stored counts');
    const table=kind==='observations'?'market_observations':'market_candidates';
    const identity=kind==='observations'?'observation_id':'candidate_id';
    const item=kind==='observations'?'observation':'candidate';
    if(cursor) {
      const anchor=(await this.pool.query(`SELECT 1 FROM ${table} WHERE generation=$1 AND ${identity}=$2 AND execution_utime=$3 AND ($4::bigint IS NULL OR execution_utime >= $4) AND ($5::bigint IS NULL OR execution_utime < $5)`,[generation,cursor.id,cursor.utime,from,to])).rows[0];
      if(!anchor) throw new MarketCursorError('Market cursor position not found');
    }
    const limit=query.limit??100;
    const records=(await this.pool.query(`SELECT ${item} AS item FROM ${table} WHERE generation=$1 AND ($2::bigint IS NULL OR execution_utime >= $2) AND ($3::bigint IS NULL OR execution_utime < $3) AND ($4::bigint IS NULL OR (execution_utime,${identity})<($4::bigint,$5::text)) ORDER BY execution_utime DESC,${identity} DESC LIMIT $6`,[generation,from,to,cursor?.utime??null,cursor?.id??null,limit+1])).rows;
    const items=records.slice(0,limit).map(r=>r.item as MarketObservation|MarketCandidate);
    // Reading a page never upgrades malformed stored evidence into an observation.
    for(const item of items) {
      if(kind==='observations') observation(item as MarketObservation,metadata.binding);
      else {
        const c=item as MarketCandidate; object(c,['id','acceptance','status','issues','observationId'],'stored candidate'); ref(c.acceptance,'stored candidate'); strings(c.issues,'stored candidate issues');
        if(c.acceptance.account!==pool || c.id!==observationId(network,c.acceptance) || !['settled','refunded','unresolved'].includes(c.status) || c.status==='settled' && (c.observationId!==c.id || c.issues.length!==0) || c.status!=='settled' && c.observationId!==null || c.status==='unresolved' && !c.issues.length) invalid('stored candidate');
      }
    }
    const last=items.at(-1),utime=last && ('executionUtime' in last?last.executionUtime:last.acceptance.utime);
    const nextCursor=records.length>limit && last ? Buffer.from(JSON.stringify({schema:'dlmm-market-cursor-v1',kind,network,pool,generation,from,to,utime:utime!,id:last.id} satisfies Cursor)).toString('base64url') : null;
    return {items,nextCursor,coverage:{...metadata,generation,fingerprint:row.fingerprint,publishedAt:new Date(row.published_at).toISOString()}};
  }
}

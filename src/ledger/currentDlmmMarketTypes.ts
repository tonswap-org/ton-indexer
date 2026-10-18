import type { AccountAnchor, ChainHead } from '../data/dataSource';
import type { Network } from '../models';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { LedgerEvidenceRef } from './types';
import type { MarketCandidate, MarketDependency } from './marketTypes';
import type { HistoricalRootArchive } from './jettonPrecision';
import { currentDlmmBindingFromManifest, type CurrentDlmmPoolConfig, type CurrentDlmmWallet, type CurrentT3TransactionEvidence } from './currentDlmmPhysical';
export type CurrentDlmmMarketBinding = CurrentDlmmPoolConfig & { schema:'current-dlmm-market-binding-v1'; network:Network; release:RuntimeReleaseManifest };
export function currentDlmmMarketBindingsFromManifest(release:RuntimeReleaseManifest):CurrentDlmmMarketBinding[]{return currentDlmmBindingFromManifest(release).pools.map(p=>({...p,schema:'current-dlmm-market-binding-v1',network:release.network.slice(4) as Network,release}));}
export type CurrentDlmmMarketPrecision={root:string;rootCodeHash:string;walletCodeHash:string;status:'resolved'|'unresolved';decimals:number|null;method:'onchain-explicit'|'pinned-stablecoin-6'|null;contentHash:string|null;archive:HistoricalRootArchive|null;issues:string[]};
/** Physical credit is the only finality represented here. No synthetic wallet
 * acknowledgement or retired pool-finalization transaction is introduced. */
export type CurrentDlmmExecutionAnchor={kind:'configured-source-execution';masterchain:ChainHead;shard:AccountAnchor;afterShardAccountBoc:string};
export type CurrentDlmmMarketProof={executionSeqno:number;executionAnchor:CurrentDlmmExecutionAnchor|null;wallets:CurrentDlmmWallet[];transactions:CurrentT3TransactionEvidence[]};
export type CurrentDlmmMarketCandidate=MarketCandidate&{proof:CurrentDlmmMarketProof|null};
export type CurrentDlmmMarketObservation={
 id:string;network:Network;pool:string;kind:'settled_dlmm_execution';settlementMode:'physical-credit';
 acceptance:LedgerEvidenceRef;executionUtime:number;deliveredUtime:number;finalizedUtime:number;
 payer:string;recipient:string;businessQueryId:string;inputAsset:string;outputAsset:string;
 paidInputRaw:string;returnedInputRaw:string;consumedInputRaw:string;outputRaw:string;
 ratio:{numerator:string;denominator:string;unit:'output_atomic_per_input_atomic';includesTradingFees:true};
 assetPrecision:{input:CurrentDlmmMarketPrecision;output:CurrentDlmmMarketPrecision};
 input:{request:LedgerEvidenceRef;debit:LedgerEvidenceRef;credit:LedgerEvidenceRef};
 output:{debit:LedgerEvidenceRef;credit:LedgerEvidenceRef};
 fees:{grossT3Raw:string;protocolT3Raw:string;lpT3Raw:string};
 proof:CurrentDlmmMarketProof;
};
export type CurrentDlmmMarketProjection={schema:'dlmm-market-ledger-v2';binding:CurrentDlmmMarketBinding;dependencies:MarketDependency[];observations:CurrentDlmmMarketObservation[];candidates:CurrentDlmmMarketCandidate[];issues:string[];historyComplete:boolean};

import { TupleItem } from '@ton/core';
import { Network } from '../models';
import { JettonMetadata } from '../models';

export type RawMessage = {
  source?: string;
  destination?: string;
  value?: string;
  op?: number;
  body?: string;
};

export type RawTransactionStatus = 'success' | 'failed' | 'pending';

export type RawTransaction = {
  lt: string;
  hash: string;
  utime: number;
  success: boolean;
  status?: RawTransactionStatus;
  reason?: string;
  inMessage?: RawMessage;
  outMessages: RawMessage[];
};

export type AccountStateResponse = {
  balance: string;
  lastTxLt?: string;
  lastTxHash?: string;
  accountState?: 'active' | 'uninitialized' | 'frozen' | null;
  codeBoc?: string | null;
  dataBoc?: string | null;
};

export type MasterchainInfo = {
  seqno: number;
  timestamp?: number;
};

export type TonBlockIdExt = {
  seqno: number;
  workchain: number;
  shard: string;
  rootHashHex: string;
  fileHashHex: string;
};

export type TonSccpProofSignature = {
  nodeIdShortHex: string;
  signatureHex: string;
};

export type TonSccpProofSignatureSet = {
  validatorListHashShort: number;
  catchainSeqno: number;
  signatures: TonSccpProofSignature[];
};

export type TonSccpBurnProofMaterialRequest = {
  jettonMaster: string;
  messageIdHex: string;
  trustedCheckpointSeqno?: number;
  trustedCheckpointHashHex?: string;
  targetSeqno?: number;
};

export type TonSccpBurnProofMaterial = {
  trustedCheckpoint: TonBlockIdExt;
  targetMasterchain: TonBlockIdExt;
  targetSignatures: TonSccpProofSignatureSet;
  targetShard: TonBlockIdExt;
  checkpointBlockBoc: string;
  checkpointStateBoc: string;
  targetBlockBoc: string;
  targetStateBoc: string;
  shardBlockBoc: string;
  shardStateBoc: string;
  burnRecordPresent: boolean;
};

export interface TonDataSource {
  network: Network;
  getMasterchainInfo(): Promise<MasterchainInfo>;
  getAccountState(address: string): Promise<AccountStateResponse>;
  getTransactions(address: string, limit: number, lt?: string, hash?: string): Promise<RawTransaction[]>;
  runGetMethod(
    address: string,
    method: string,
    args?: TupleItem[]
  ): Promise<{ exitCode: number; stack: TupleItem[] } | null>;
  getTonSccpBurnProofMaterial?(request: TonSccpBurnProofMaterialRequest): Promise<TonSccpBurnProofMaterial>;
  getJettonBalance(owner: string, master: string): Promise<{ wallet: string; balance: string } | null>;
  getJettonMetadata(master: string): Promise<JettonMetadata | null>;
  close(): Promise<void>;
}

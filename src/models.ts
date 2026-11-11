export type Network = 'mainnet' | 'testnet' | 'localnet';

export type TxKind =
  | 'swap'
  | 'lp_deposit'
  | 'lp_withdraw'
  | 'transfer'
  | 'contract_call'
  | 'unknown';

export type SwapExecutionType = 'market' | 'limit' | 'twap' | 'unknown';

export type AssetRef =
  | { kind: 'ton' }
  | { kind: 'jetton'; master: string; wallet?: string; symbol?: string; decimals?: number };

export type TxAction =
  | {
      kind: 'swap';
      pool?: string;
      tokenIn?: AssetRef;
      tokenOut?: AssetRef;
      amountIn?: string;
      amountOut?: string;
      minOut?: string;
      sender?: string;
      queryId?: string;
      executionType?: SwapExecutionType;
      twapSlice?: number;
      twapTotal?: number;
      querySequence?: number;
      queryNonce?: number;
    }
  | {
      kind: 'lp_deposit';
      pool?: string;
      tokenA?: AssetRef;
      tokenB?: AssetRef;
      amountA?: string;
      amountB?: string;
      lpMinted?: string;
      binId?: number;
      minLpOut?: string;
      owner?: string;
    }
  | {
      kind: 'lp_withdraw';
      pool?: string;
      tokenA?: AssetRef;
      tokenB?: AssetRef;
      amountA?: string;
      amountB?: string;
      lpBurned?: string;
      binId?: number;
    }
  | {
      kind: 'transfer';
      asset: AssetRef;
      amount: string;
      from?: string;
      to?: string;
      source?: 'in' | 'out';
    }
  | {
      kind: 'contract_call';
      contract?: string;
      op?: number;
    }
  | {
      kind: 'unknown';
      note?: string;
    };

export type MessageSummary = {
  source?: string;
  destination?: string;
  value?: string;
  op?: number;
  body?: string;
  createdLt?: string;
  bounced?: boolean;
  forwardFeeRaw?: string;
  /** TVM12+ message flags, not a monetary fee. */
  extraFlagsRaw?: string;
};

export type UiDetail =
  | { kind: 'contract_call'; contract?: string; op?: number }
  | {
      kind: 'swap';
      payToken?: string;
      receiveToken?: string;
      payAmount?: string;
      receiveAmount?: string;
      minimumReceiveAmount?: string;
      queryId?: string;
      executionType?: SwapExecutionType;
      twapSlice?: number;
      twapTotal?: number;
      querySequence?: number;
      queryNonce?: number;
    }
  | { kind: 'lp'; pair?: string; tokenA?: string; tokenB?: string; amountA?: string; amountB?: string }
  | { kind: 'mint'; mode?: string; inputToken?: string; outputToken?: string; inputAmount?: string; outputAmount?: string }
  | { kind: 'transfer'; asset?: string; amount?: string }
  | { kind: 'unknown' };

export type UiTx = {
  txId: string;
  utime: number;
  status: 'success' | 'failed' | 'pending';
  reason?: string;
  txType: string;
  inSource?: string;
  inValue?: string;
  outCount: number;
  detail: UiDetail;
  kind: TxKind;
  actions: TxAction[];
};

export type IndexedTx = {
  address: string;
  lt: string;
  hash: string;
  /** Canonical account-chain predecessor retained for history integrity checks. */
  prevTransactionLt?: string;
  prevTransactionHash?: string;
  utime: number;
  success: boolean;
  totalFeesRaw?: string;
  inMessage?: MessageSummary;
  outMessages: MessageSummary[];
  kind: TxKind;
  actions: TxAction[];
  ui: UiTx;
};

export type JettonMetadata = {
  symbol?: string;
  name?: string;
  description?: string;
  decimals?: number;
  image?: string;
  uri?: string;
};

export type AccountState = {
  address: string;
  balance: string;
  lastTxLt?: string;
  lastTxHash?: string;
  accountState?: 'active' | 'uninitialized' | 'frozen' | null;
  codeBoc?: string | null;
  dataBoc?: string | null;
  updatedAt: number;
};

export type PageCursor = {
  lt: string;
  hash: string;
};

export type AccountStats = {
  txCount: number;
  historyComplete: boolean;
  totalPagesMin: number;
  lastBackfillLt?: string;
  lastRequestAt: number;
  lastUpdateSeqno?: number;
};

export type HealthStatus = {
  lastMasterSeqno?: number;
  indexerLagSec?: number;
  chain: { peersConfigured: number; peersReady: number; headSeqno: number | null; headAgeSec: number | null };
  ledger: 'disabled' | 'connecting' | 'ready' | 'unavailable';
  disk: 'ok' | 'low' | 'critical';
};

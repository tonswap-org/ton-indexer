export type Network = 'mainnet' | 'testnet';

export type TxKind =
  | 'swap'
  | 'lp_deposit'
  | 'lp_withdraw'
  | 'transfer'
  | 'contract_call'
  | 'unknown';

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
    }
  | {
      kind: 'lp_deposit';
      pool?: string;
      tokenA?: AssetRef;
      tokenB?: AssetRef;
      amountA?: string;
      amountB?: string;
      lpMinted?: string;
    }
  | {
      kind: 'lp_withdraw';
      pool?: string;
      tokenA?: AssetRef;
      tokenB?: AssetRef;
      amountA?: string;
      amountB?: string;
      lpBurned?: string;
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
};

export type UiDetail =
  | { kind: 'swap'; payToken?: string; receiveToken?: string; payAmount?: string; receiveAmount?: string }
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
  utime: number;
  success: boolean;
  inMessage?: MessageSummary;
  outMessages: MessageSummary[];
  kind: TxKind;
  actions: TxAction[];
  ui: UiTx;
};

export type AccountBalance = {
  ton: {
    balance: string;
    last_tx_lt?: string;
    last_tx_hash?: string;
  };
  jettons: Array<{
    master: string;
    wallet: string;
    balance: string;
    decimals?: number;
    symbol?: string;
  }>;
  confirmed: boolean;
  updated_at: number;
  network: Network;
};

export type AccountAssetBalance = {
  kind: 'native' | 'jetton';
  symbol?: string;
  address?: string;
  wallet?: string;
  balance_raw: string;
  balance: string;
  decimals: number;
};

export type AccountBalances = {
  address: string;
  ton_raw: string;
  ton: string;
  assets: AccountAssetBalance[];
  confirmed: boolean;
  updated_at: number;
  network: Network;
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
  liteserverPoolStatus?: string;
};

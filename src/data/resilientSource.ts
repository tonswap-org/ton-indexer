import { TupleItem } from '@ton/core';
import { TonDataSource, AccountStateResponse, MasterchainInfo, RawTransaction } from './dataSource';
import { JettonMetadata, Network } from '../models';

type RunGetMethodResult = { exitCode: number; stack: TupleItem[] } | null;

const hasStateCellData = (state: AccountStateResponse | null | undefined) =>
  Boolean(state && ((state.codeBoc && state.codeBoc.trim()) || (state.dataBoc && state.dataBoc.trim())));

const mergeAccountState = (primary: AccountStateResponse, fallback: AccountStateResponse): AccountStateResponse => ({
  balance: primary.balance || fallback.balance,
  lastTxLt: primary.lastTxLt ?? fallback.lastTxLt,
  lastTxHash: primary.lastTxHash ?? fallback.lastTxHash,
  accountState: primary.accountState ?? fallback.accountState,
  codeBoc: primary.codeBoc ?? fallback.codeBoc ?? null,
  dataBoc: primary.dataBoc ?? fallback.dataBoc ?? null
});

const isGetterSuccess = (result: RunGetMethodResult) => Boolean(result && result.exitCode === 0);

const callSafely = async <T>(fn: () => Promise<T>): Promise<T | null> => {
  try {
    return await fn();
  } catch {
    return null;
  }
};

export class ResilientTonDataSource implements TonDataSource {
  readonly network: Network;
  private primary: TonDataSource;
  private fallback: TonDataSource;

  constructor(primary: TonDataSource, fallback: TonDataSource) {
    this.primary = primary;
    this.fallback = fallback;
    this.network = primary.network;
  }

  async getMasterchainInfo(): Promise<MasterchainInfo> {
    const primary = await callSafely(() => this.primary.getMasterchainInfo());
    if (primary) return primary;
    const secondary = await callSafely(() => this.fallback.getMasterchainInfo());
    if (secondary) return secondary;
    throw new Error('Masterchain info unavailable from both data sources.');
  }

  async getAccountState(address: string): Promise<AccountStateResponse> {
    const primary = await callSafely(() => this.primary.getAccountState(address));
    const secondary = await callSafely(() => this.fallback.getAccountState(address));

    if (primary && secondary) {
      if (hasStateCellData(primary) || !hasStateCellData(secondary)) return mergeAccountState(primary, secondary);
      return mergeAccountState(secondary, primary);
    }
    if (primary) return primary;
    if (secondary) return secondary;
    throw new Error(`Account state unavailable for ${address}`);
  }

  async getTransactions(address: string, limit: number, lt?: string, hash?: string): Promise<RawTransaction[]> {
    const primary = await callSafely(() => this.primary.getTransactions(address, limit, lt, hash));
    if (primary) return primary;
    const secondary = await callSafely(() => this.fallback.getTransactions(address, limit, lt, hash));
    if (secondary) return secondary;
    throw new Error(`Transactions unavailable for ${address}`);
  }

  async runGetMethod(address: string, method: string, args: TupleItem[] = []): Promise<RunGetMethodResult> {
    const primary = await callSafely(() => this.primary.runGetMethod(address, method, args));
    if (isGetterSuccess(primary)) return primary;

    const secondary = await callSafely(() => this.fallback.runGetMethod(address, method, args));
    if (isGetterSuccess(secondary)) return secondary;

    return primary ?? secondary ?? null;
  }

  async getJettonBalance(owner: string, master: string): Promise<{ wallet: string; balance: string } | null> {
    const primary = await callSafely(() => this.primary.getJettonBalance(owner, master));
    if (primary) return primary;
    const secondary = await callSafely(() => this.fallback.getJettonBalance(owner, master));
    return secondary ?? null;
  }

  async getJettonMetadata(master: string): Promise<JettonMetadata | null> {
    const primary = await callSafely(() => this.primary.getJettonMetadata(master));
    if (primary) return primary;
    const secondary = await callSafely(() => this.fallback.getJettonMetadata(master));
    return secondary ?? null;
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.primary.close(), this.fallback.close()]);
  }
}

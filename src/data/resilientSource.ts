import { TupleItem } from '@ton/core';
import {
  TonDataSource,
  AccountStateResponse,
  MasterchainInfo,
  RawTransaction,
  TonSccpBurnProofMaterial,
  TonSccpBurnProofMaterialRequest
} from './dataSource';
import { JettonMetadata, Network } from '../models';

type RunGetMethodResult = { exitCode: number; stack: TupleItem[] } | null;

const hasStateCell = (value: string | null | undefined) => Boolean(value && value.trim());

const hasStateCellData = (state: AccountStateResponse | null | undefined) => {
  if (!state) return false;
  const hasCode = hasStateCell(state.codeBoc);
  const hasData = hasStateCell(state.dataBoc);
  // Active account state is incomplete when either state cell is absent. In
  // that case the fallback may supply the missing cell (or a complete pair).
  return state.accountState === 'active' ? hasCode && hasData : hasCode || hasData;
};

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
    if (primary && hasStateCellData(primary)) return primary;

    const secondary = await callSafely(() => this.fallback.getAccountState(address));

    if (primary && secondary) {
      if (hasStateCellData(primary) || !hasStateCellData(secondary)) return mergeAccountState(primary, secondary);
      return mergeAccountState(secondary, primary);
    }
    if (primary) return primary;
    if (secondary) return secondary;
    throw new Error(`Account state unavailable for ${address}`);
  }

  async getAccountStateLite(address: string): Promise<AccountStateResponse> {
    const primary = this.primary.getAccountStateLite
      ? await callSafely(() => this.primary.getAccountStateLite!(address))
      : await callSafely(() => this.primary.getAccountState(address));
    if (primary) return primary;

    const secondary = this.fallback.getAccountStateLite
      ? await callSafely(() => this.fallback.getAccountStateLite!(address))
      : await callSafely(() => this.fallback.getAccountState(address));
    if (secondary) return secondary;
    throw new Error(`Account state unavailable for ${address}`);
  }

  async getTransactions(address: string, limit: number, lt?: string, hash?: string): Promise<RawTransaction[]> {
    const primary = await callSafely(() => this.primary.getTransactions(address, limit, lt, hash));
    const hasExplicitCursor = Boolean(lt && hash);
    // Transaction pages are cursor-inclusive. An empty page for an explicit
    // cursor means the primary cannot serve that history point, so retry the
    // archival fallback instead of treating the empty array as success.
    if (primary && (!hasExplicitCursor || primary.length > 0)) return primary;
    const secondary = await callSafely(() => this.fallback.getTransactions(address, limit, lt, hash));
    if (secondary) return secondary;
    if (primary) return primary;
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

  async getTonSccpBurnProofMaterial(
    request: TonSccpBurnProofMaterialRequest
  ): Promise<TonSccpBurnProofMaterial> {
    const primary = this.primary.getTonSccpBurnProofMaterial
      ? await callSafely(() => this.primary.getTonSccpBurnProofMaterial!(request))
      : null;
    if (primary) return primary;
    if (this.fallback.getTonSccpBurnProofMaterial) {
      const secondary = await callSafely(() => this.fallback.getTonSccpBurnProofMaterial!(request));
      if (secondary) return secondary;
    }
    throw new Error('TON SCCP proof material is unavailable from both data sources.');
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.primary.close(), this.fallback.close()]);
  }
}

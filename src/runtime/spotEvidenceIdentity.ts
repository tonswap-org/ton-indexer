import { Address, TupleReader, beginCell } from '@ton/core';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { ChainHead, ChainSource } from '../data/dataSource';
import { SpotEvidenceError } from './spotOperationRequest';

export const SPOT_EVIDENCE_LIMITS = Object.freeze({ accounts: 16, historyTransactions: 256, returnedTransactions: 256,
  newTransactions: 64, messageEdges: 1024, responseBytes: 8 * 1024 * 1024, gaps: 256 });

const unavailable = () => new SpotEvidenceError(503, 'upstream_unavailable');
const budgetWidths = [['senderGas', 32], ['walletBounceGas', 32], ['burnWalletGas', 32], ['smallPayloadCells', 16],
  ['largeWalletGas', 32], ['largeSenderGas', 32], ['rentSeconds', 32], ['rentBits', 32], ['rentCells', 16],
  ['initBits', 32], ['initCells', 16], ['initCopies', 8], ['transferBits', 16], ['transferCells', 8], ['transferCopies', 8]] as const;
export async function assertPoolIdentity(manifest: RuntimeReleaseManifest, source: ChainSource, head: ChainHead,
  market: RuntimeReleaseManifest['spotMarkets'][number], signal?: AbortSignal) {
  const x = manifest.tokens.find(token => token.symbol === market.symbol), t3 = manifest.tokens.find(token => token.symbol === 'T3');
  if (!x || !t3) throw unavailable();
  const budget = beginCell(); for (const [key, width] of budgetWidths) budget.storeUint(market.walletBudgetX[key], width);
  const id = beginCell().storeAddress(Address.parse(x.root)).storeUint(market.binSpacing, 16).storeUint(market.feePips, 32)
    .storeUint(market.xDecimals, 8).storeUint(market.walletGasX, 32).storeCoins(BigInt(market.walletGramX))
    .storeRef(budget.storeBit(market.walletBudgetX.creditProtection).endCell()).endCell();
  const result = await source.runGetMethod(market.pool, 'get_pool_info', [], { at: head, signal });
  if (!result || result.exitCode !== 0 || result.stack.length !== 14) throw unavailable();
  const s = new TupleReader(result.stack);
  if (!s.readCell().equals(id)) throw unavailable();
  for (const address of [manifest.contracts.DlmmPoolFactory?.address, manifest.contracts.FeeRouter?.address, manifest.contracts.Treasury?.address, t3.root])
    if (!address || s.readAddress().toRawString() !== address) throw unavailable();
  // Consume the current bounded getter shape. Readiness/amounts are observations,
  // never evidence that a prior swap paid its recipient.
  const flags = s.readBigNumber(), ready = s.readBigNumber(), activeBin = s.readBigNumber();
  if (flags < 0n || flags > 255n || ![0n, -1n].includes(ready) || activeBin < -2147483648n || activeBin > 2147483647n) throw unavailable();
  for (let i = 0; i < 3; i++) { const amount = s.readBigNumber(); if (amount < 0n || amount >= 1n << 120n) throw unavailable(); }
  for (const width of [16n, 16n, 8n]) { const count = s.readBigNumber(); if (count < 0n || count >= 1n << width) throw unavailable(); }
  if (s.remaining) throw unavailable();
}

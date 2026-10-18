import { collectOwedWalletClaimEvidence } from './owedWalletClaimEvidence';
import { collectOwedEvidence, collectOwedOperationEvidence, type OwedRequest, type readOwedOperationRequest } from './owedEvidence';
import { bindOrderRelease, type OrderRelease } from '../orders/discovery';
import { pageOpenOrders } from '../orders/openOrders';
import { currentNativeRuntime } from '../api/serviceMetadata';
import { createReleaseLedgerPool, type ReleasePoolOptions } from '../ledger/releasePool';
import { PostgresLedgerStore, type LedgerSqlPool } from '../ledger/store';
import { assertLedgerDatabaseReady, type LedgerCatalog } from '../ledger/schemaReadiness';
import { runningLedgerBuild } from '../ledger/buildIdentity';
import { errorDiagnostic } from '../utils/logger';
import type { RuntimeDeps } from './worker';
import { collectCurrentOrders } from './orderChain';
import { PostgresOrderStore, type OrderStore } from './orderStore';
import { collectT3OperationEvidence, type CurrentT3OperationEvidence } from './t3OperationEvidence';
import { T3EvidenceError, type readT3OperationRequest } from './t3OperationRequest';
import { collectSpotOperationEvidence, type CurrentSpotOperationEvidence } from './spotOperationEvidence';
import { SpotEvidenceError, type ParsedSpotOperationRequest } from './spotOperationRequest';
import { createOperationEvidenceGate } from './operationEvidenceGate';
import { collectT3WalletClaimEvidence, type CurrentT3WalletClaimEvidence, type readT3WalletClaimRequest } from './t3WalletClaimEvidence';
import { collectOrderWalletClaimEvidence, type CurrentOrderWalletClaimEvidence, type readOrderWalletClaimRequest } from './orderWalletClaimEvidence';
import { collectOptionsOperationEvidence, type CurrentOptionsOperationEvidence, type readOptionsOperationRequest } from './optionsOperationEvidence';
import { collectFaucetOperationEvidence, type CurrentFaucetOperationEvidence, type readFaucetOperationRequest } from './faucetOperationEvidence';
import { collectOptionsWalletClaimEvidence, type CurrentOptionsWalletClaimEvidence, type readOptionsWalletClaimRequest } from './optionsWalletClaimEvidence';
import { collectFaucetRecoveryEvidence, type CurrentFaucetRecoveryEvidence, type readFaucetRecoveryRequest } from './faucetRecoveryEvidence';
import { collectFaucetProofSession, type FaucetProofSessionEvidence, type readFaucetProofSessionRequest } from './t3ProofSession';
import { collectLaunchpadOperationEvidence, type CurrentLaunchpadOperationEvidence, type readLaunchpadOperationRequest } from './launchpadOperationEvidence';
import { collectLaunchpadSalesEvidence, type CurrentLaunchpadSalesEvidence, type CurrentLaunchpadSalesRequest } from './launchpadSalesEvidence';
import { collectPoolOperationEvidence, type CurrentPoolOperationEvidence, type readPoolOperationRequest } from './poolOperationEvidence';
import { collectPoolWalletClaimEvidence, type CurrentPoolWalletClaimEvidence, type readPoolWalletClaimRequest } from './poolWalletClaimEvidence';
import { collectLaunchpadTokenEvidence, type CurrentLaunchpadTokenEvidence, type readLaunchpadTokenRequest } from './launchpadTokenEvidence';
import { collectPerpsOperationEvidence, type CurrentPerpsOperationEvidence, type readPerpsOperationRequest } from './perpsOperationEvidence';
import { collectPerpsWalletClaimEvidence, type CurrentPerpsWalletClaimEvidence, type readPerpsWalletClaimRequest } from './perpsWalletClaimEvidence';
import { collectWalletTransferEvidence, type CurrentWalletTransferEvidence, type readWalletTransferEvidenceRequest } from './walletTransferEvidence';
import { collectLaunchpadWalletClaimEvidence, type CurrentLaunchpadWalletClaimEvidence, type readLaunchpadWalletClaimRequest } from './launchpadWalletClaimEvidence';
import { collectLaunchpadOwedArchiveEvidence, type CurrentLaunchpadOwedArchiveEvidence, type CurrentLaunchpadOwedArchiveRequest } from './launchpadOwedArchiveEvidence';
import { collectLaunchpadHolderRecoveryEvidence, type CurrentLaunchpadHolderRecoveryEvidence, type readLaunchpadHolderRecoveryRequest } from './launchpadHolderRecoveryEvidence';
import { collectLaunchpadHolderProofSession, type LaunchpadHolderProofSessionEvidence, type readLaunchpadHolderProofSessionRequest } from './launchpadHolderProofSession';
import { ProductEvidenceError } from './productEvidence';

export class OrderPageError extends Error {
  constructor(readonly status: 400 | 409 | 503, readonly code: 'invalid_cursor' | 'cursor_mismatch' | 'upstream_unavailable') {
    super(status === 503 ? 'Current order evidence is unavailable.' : 'The order cursor is invalid or expired.');
  }
}
export type CurrentOrdersRuntime = { start(): void; stop(): Promise<void>; status(): 'disabled' | 'connecting' | 'ready' | 'unavailable';
  page(options: { cursor?: string; limit?: number }): Promise<ReturnType<typeof pageOpenOrders>>;
  operationEvidence(request: ReturnType<typeof readT3OperationRequest>, signal?: AbortSignal): Promise<CurrentT3OperationEvidence>;
  walletClaimEvidence(request: ReturnType<typeof readT3WalletClaimRequest>, signal?: AbortSignal): Promise<CurrentT3WalletClaimEvidence>;
  orderWalletClaimEvidence(request: ReturnType<typeof readOrderWalletClaimRequest>, signal?: AbortSignal): Promise<CurrentOrderWalletClaimEvidence>;
  poolOperationEvidence(request: ReturnType<typeof readPoolOperationRequest>, signal?: AbortSignal): Promise<CurrentPoolOperationEvidence>;
  poolWalletClaimEvidence(request: ReturnType<typeof readPoolWalletClaimRequest>, signal?: AbortSignal): Promise<CurrentPoolWalletClaimEvidence>;
  launchpadTokenEvidence(request: ReturnType<typeof readLaunchpadTokenRequest>, signal?: AbortSignal): Promise<CurrentLaunchpadTokenEvidence>;
  perpsOperationEvidence(request: ReturnType<typeof readPerpsOperationRequest>, signal?: AbortSignal): Promise<CurrentPerpsOperationEvidence>;
  perpsWalletClaimEvidence(request: ReturnType<typeof readPerpsWalletClaimRequest>, signal?: AbortSignal): Promise<CurrentPerpsWalletClaimEvidence>;
  walletTransferEvidence(request: ReturnType<typeof readWalletTransferEvidenceRequest>, signal?: AbortSignal): Promise<CurrentWalletTransferEvidence>;
  launchpadWalletClaimEvidence(request: ReturnType<typeof readLaunchpadWalletClaimRequest>, signal?: AbortSignal): Promise<CurrentLaunchpadWalletClaimEvidence>;
  owedEvidence(request: OwedRequest, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof collectOwedEvidence>>>;
  owedWalletClaimEvidence(request: ReturnType<typeof readOwedOperationRequest>, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof collectOwedWalletClaimEvidence>>>;
  owedOperationEvidence(request: ReturnType<typeof readOwedOperationRequest>, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof collectOwedOperationEvidence>>>;
  launchpadOwedArchiveEvidence(request: CurrentLaunchpadOwedArchiveRequest, signal?: AbortSignal): Promise<CurrentLaunchpadOwedArchiveEvidence>;
  launchpadHolderRecoveryEvidence(request: ReturnType<typeof readLaunchpadHolderRecoveryRequest>, signal?: AbortSignal): Promise<CurrentLaunchpadHolderRecoveryEvidence>;
  launchpadHolderProofSession(request: ReturnType<typeof readLaunchpadHolderProofSessionRequest>, signal?: AbortSignal): Promise<LaunchpadHolderProofSessionEvidence>;
  launchpadSales(request: CurrentLaunchpadSalesRequest, signal?: AbortSignal): Promise<CurrentLaunchpadSalesEvidence>;
  launchpadOperationEvidence(request: ReturnType<typeof readLaunchpadOperationRequest>, signal?: AbortSignal): Promise<CurrentLaunchpadOperationEvidence>;
  optionsOperationEvidence(request: ReturnType<typeof readOptionsOperationRequest>, signal?: AbortSignal): Promise<CurrentOptionsOperationEvidence>;
  faucetOperationEvidence(request: ReturnType<typeof readFaucetOperationRequest>, signal?: AbortSignal): Promise<CurrentFaucetOperationEvidence>;
  optionsWalletClaimEvidence(request: ReturnType<typeof readOptionsWalletClaimRequest>, signal?: AbortSignal): Promise<CurrentOptionsWalletClaimEvidence>;
  faucetProofSession(request: ReturnType<typeof readFaucetProofSessionRequest>, signal?: AbortSignal): Promise<FaucetProofSessionEvidence>;
  faucetRecoveryEvidence(request: ReturnType<typeof readFaucetRecoveryRequest>, signal?: AbortSignal): Promise<CurrentFaucetRecoveryEvidence>;
  spotOperationEvidence(request: ParsedSpotOperationRequest, signal?: AbortSignal): Promise<CurrentSpotOperationEvidence> };
function cursorSnapshot(cursor: string): string {
  try {
    if (!cursor || cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw Error();
    const bytes = Buffer.from(cursor, 'base64url'); if (bytes.toString('base64url') !== cursor) throw Error();
    const value = JSON.parse(bytes.toString('utf8'));
    if (typeof value?.snapshotId !== 'string' || !/^[0-9a-f]{64}$/.test(value.snapshotId)) throw Error();
    return value.snapshotId;
  } catch { throw new OrderPageError(400, 'invalid_cursor'); }
}
/** A page never refreshes rows underneath a cursor. Immutable snapshots remain
 * durable; current publication moves forward only after fresh collection. */
export async function readOrderPage(store: OrderStore, release: OrderRelease, options: { cursor?: string; limit?: number }, now = Date.now()) {
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new OrderPageError(400, 'invalid_cursor');
  const snapshot = options.cursor === undefined ? await store.current() : await store.snapshot(cursorSnapshot(options.cursor));
  if (!snapshot) throw new OrderPageError(options.cursor === undefined ? 503 : 409, options.cursor === undefined ? 'upstream_unavailable' : 'cursor_mismatch');
  try { return pageOpenOrders(snapshot, release, { ...options, limit, now }); }
  catch { throw new OrderPageError(options.cursor === undefined ? 503 : 409, options.cursor === undefined ? 'upstream_unavailable' : 'cursor_mismatch'); }
}
export function createOrdersRuntime(deps: RuntimeDeps, options: {
  poolFactory?: (url: string, hash: string, options?: ReleasePoolOptions) => Promise<LedgerSqlPool>;
  catalog?: LedgerCatalog;
} = {}): CurrentOrdersRuntime {
  const { config, manifest, logger, source } = deps;
  const native = currentNativeRuntime(config.network, manifest);
  if (!native) throw Error('Current orders require the validated current release');
  const release = bindOrderRelease(native);
  let pool: LedgerSqlPool | undefined, store: PostgresOrderStore | undefined;
  let stopped = false, started = false, failures = 0;
  let timer: NodeJS.Timeout | undefined, work: Promise<void> | undefined, controller: AbortController | undefined;
  let state: ReturnType<CurrentOrdersRuntime['status']> = config.databaseUrl ? 'connecting' : 'disabled';
  const evidenceRequests = createOperationEvidenceGate();
  const schedule = (ms: number) => { if (!stopped) { timer = setTimeout(run, ms); timer.unref(); } };
  const cycle = async () => {
    try {
      if (!store) {
        const catalog = options.catalog ?? runningLedgerBuild?.catalog;
        if (!catalog) throw Error('Canonical compiled order catalog is unavailable');
        runningLedgerBuild?.assertCurrent();
        pool = await (options.poolFactory ?? createReleaseLedgerPool)(config.databaseUrl!, native.manifestHash, { size: 3, statementTimeoutMs: 5_000, metrics: deps.metrics, role: 'worker' });
        await new PostgresLedgerStore(pool).initialize();
        await assertLedgerDatabaseReady(pool, native.manifestHash, catalog);
        store = new PostgresOrderStore(pool, release);
      }
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(new DOMException('Order collection deadline', 'TimeoutError')), 20_000); timeout.unref();
      try {
        const snapshot = await collectCurrentOrders(source, release, store, { signal: controller.signal });
        if (stopped) return;
        runningLedgerBuild?.assertCurrent();
        await store.publish(snapshot); state = 'ready'; failures = 0;
      } finally { clearTimeout(timeout); controller = undefined; }
      schedule(2_000);
    } catch (error) {
      if (stopped) return;
      state = 'unavailable'; logger.warn('current order evidence unavailable', { error: errorDiagnostic(error) });
      if (!store && pool) { await pool.end().catch(() => {}); pool = undefined; }
      schedule(Math.min(30_000, 2_000 * 2 ** Math.min(failures++, 4)));
    }
  };
  const run = () => { timer = undefined; if (!stopped && !work) work = cycle().finally(() => { work = undefined; }); };
  // All operation collectors share the release pool and the same live-work cap.
  // Completed results are never reused for a later current-chain request.
  const evidence = async <T>(collect: (store: PostgresOrderStore, signal: AbortSignal) => Promise<T>,
    unavailable: () => Error, signal?: AbortSignal): Promise<T> => {
    const currentStore = store;
    if (!currentStore || stopped) throw unavailable();
    runningLedgerBuild?.assertCurrent();
    return evidenceRequests.run(async active => {
      const result = await collect(currentStore, active); runningLedgerBuild?.assertCurrent(); return result;
    }, unavailable, signal);
  };
  return {
    status: () => state,
    start() { if (started || stopped || !config.databaseUrl) return; started = true; run(); },
    async stop() {
      stopped = true; clearTimeout(timer); controller?.abort();
      await Promise.allSettled([work, evidenceRequests.stop()]);
      await pool?.end(); pool = undefined; store = undefined; state = 'unavailable';
    },
    async page(query) {
      if (!store || stopped) throw new OrderPageError(503, 'upstream_unavailable');
      runningLedgerBuild?.assertCurrent();
      return readOrderPage(store, release, query);
    },
    operationEvidence(request, signal) {
      return evidence((store, active) => collectT3OperationEvidence(native, source, store, request, active),
        () => new T3EvidenceError(503, 'upstream_unavailable'), signal);
    },
    walletClaimEvidence(request, signal) {
      return evidence((store, active) => collectT3WalletClaimEvidence(native, source, store, request, active),
        () => new T3EvidenceError(503, 'upstream_unavailable'), signal);
    },
    orderWalletClaimEvidence(request, signal) {
      return evidence((store, active) => collectOrderWalletClaimEvidence(native, source, store, request, active),
        () => new SpotEvidenceError(503, 'upstream_unavailable'), signal);
    },
    spotOperationEvidence(request, signal) {
      return evidence((store, active) => collectSpotOperationEvidence(native, source, store, request, active),
        () => new SpotEvidenceError(503, 'upstream_unavailable'), signal);
    },
    poolOperationEvidence(request, signal) {
      return evidence((store, active) => collectPoolOperationEvidence(native, source, store, request, active),
        () => new ProductEvidenceError(503, 'upstream_unavailable'), signal);
    },
    poolWalletClaimEvidence(request, signal) {
      return evidence((store, active) => collectPoolWalletClaimEvidence(native, source, store, request, active),
        () => new ProductEvidenceError(503, 'upstream_unavailable'), signal);
    },
    launchpadTokenEvidence(request, signal) {
      return evidence((store, active) => collectLaunchpadTokenEvidence(native, source, store, request, active),
        () => new ProductEvidenceError(503, 'upstream_unavailable'), signal);
    },
    perpsOperationEvidence(request, signal) {
      return evidence((store, active) => collectPerpsOperationEvidence(native, source, store, request, active),
        () => new ProductEvidenceError(503, 'upstream_unavailable'), signal);
    },
    perpsWalletClaimEvidence(request, signal) {
      return evidence((store, active) => collectPerpsWalletClaimEvidence(native, source, store, request, active),
        () => new ProductEvidenceError(503, 'upstream_unavailable'), signal);
    },
    walletTransferEvidence(request, signal) {
      return evidence((store, active) => collectWalletTransferEvidence(native, source, store, request, active),
        () => new ProductEvidenceError(503, 'upstream_unavailable'), signal);
    },
    launchpadWalletClaimEvidence(request, signal) {
      return evidence((store, active) => collectLaunchpadWalletClaimEvidence(native, source, store, request, active),
        () => new ProductEvidenceError(503, 'upstream_unavailable'), signal);
    },
    owedEvidence(request, signal) { return evidence((store, active) => collectOwedEvidence(native, source, store, request, active), () => new ProductEvidenceError(503, 'upstream_unavailable'), signal); },
    owedOperationEvidence(request, signal) { return evidence((store, active) => collectOwedOperationEvidence(native, source, store, request, active), () => new ProductEvidenceError(503, 'upstream_unavailable'), signal); },
    owedWalletClaimEvidence(request, signal) { return evidence((store, active) => collectOwedWalletClaimEvidence(native, source, store, request, active), () => new ProductEvidenceError(503, 'upstream_unavailable'), signal); },
    launchpadOwedArchiveEvidence(request, signal) {
      return evidence((store, active) => collectLaunchpadOwedArchiveEvidence(native, source, store, request, active),
        () => new ProductEvidenceError(503, 'upstream_unavailable'), signal);
    },
    launchpadHolderRecoveryEvidence(request, signal) {
      return evidence((store, active) => collectLaunchpadHolderRecoveryEvidence(native, source, store, request, active),
        () => new ProductEvidenceError(503, 'upstream_unavailable'), signal);
    },
    launchpadHolderProofSession(request, signal) {
      return evidence((store, active) => collectLaunchpadHolderProofSession(native, source, store, request, active),
        () => new ProductEvidenceError(503, 'upstream_unavailable'), signal);
    },
    launchpadSales(request, signal) {
      return evidence((store, active) => collectLaunchpadSalesEvidence(native, source, store, request, active),
        () => new ProductEvidenceError(503, 'upstream_unavailable'), signal);
    },
    launchpadOperationEvidence(request, signal) {
      return evidence((store, active) => collectLaunchpadOperationEvidence(native, source, store, request, active),
        () => new ProductEvidenceError(503, 'upstream_unavailable'), signal);
    },
    optionsOperationEvidence(request, signal) {
      return evidence((store, active) => collectOptionsOperationEvidence(native, source, store, request, active),
        () => new ProductEvidenceError(503, 'upstream_unavailable'), signal);
    },
    optionsWalletClaimEvidence(request, signal) {
      return evidence((store, active) => collectOptionsWalletClaimEvidence(native, source, store, request, active),
        () => new ProductEvidenceError(503, 'upstream_unavailable'), signal);
    },
    faucetProofSession(request, signal) {
      return evidence((store, active) => collectFaucetProofSession(native, source, store, request, active),
        () => new ProductEvidenceError(503, 'upstream_unavailable'), signal);
    },
    faucetRecoveryEvidence(request, signal) {
      return evidence((store, active) => collectFaucetRecoveryEvidence(native, source, store, request, active),
        () => new ProductEvidenceError(503, 'upstream_unavailable'), signal);
    },
    faucetOperationEvidence(request, signal) {
      return evidence((store, active) => collectFaucetOperationEvidence(native, source, store, request, active),
        () => new ProductEvidenceError(503, 'upstream_unavailable'), signal);
    },
  };
}

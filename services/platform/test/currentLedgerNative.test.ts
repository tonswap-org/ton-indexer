import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const { Address } = createRequire(resolve(__dirname, '../../../package.json'))('@ton/core');
import { ledgerEventSchema, type LedgerEvent } from '../src/ledger.js';
import { ledgerNotification } from '../src/worker.js';
import { projectOwnerLedger } from '../../../src/ledger/project';
import { currentT3MintFixture } from '../../../src/scripts/support/currentT3Fixture';
import { currentDlmmRecoveryOriginals, currentDlmmFixtureBinding } from '../../../src/scripts/support/currentDlmmFixture';
import { currentDlmmProjectionFixture } from '../../../src/scripts/support/currentDlmmProjectionFixture';
import { currentPerpsCaptures } from '../../../src/scripts/support/currentPerpsCaptures';
import { perpsCaptureBinding } from '../../../src/scripts/ledger-current-perps-test';
import { currentPerpsProjectionFixture } from '../../../src/scripts/support/currentPerpsFixture';
import { currentOptionsProjectionFixture } from '../../../src/scripts/support/currentOptionsFixture';
import { currentLaunchpadCaptures } from '../../../src/scripts/support/currentLaunchpadCaptures';
import { currentLaunchpadProjectionFixture } from '../../../src/scripts/support/currentLaunchpadFixture';
import { currentLaunchpadBindingFromManifest } from '../../../src/ledger/currentLaunchpadProof';
import { readCurrentCaptureManifest, assertCurrentCaptureTargets, currentCaptureSha256 as sha } from '../../../src/scripts/current-capture-build';
import { database, config, session } from './helpers.js';
import { Store } from '../src/store.js';
import { Worker } from '../src/worker.js';
import { Providers } from '../src/providers.js';
import { PushSender } from '../src/push.js';
import { postgres, type Database } from '../src/db.js';
import { migrate } from '../src/migrate.js';

// These are unchanged native financial envelopes, producer receipts and source
// closures. The maintained adapters supply explicitly synthetic sandbox heads;
// neither this test nor its synthetic clock qualifies public consensus.
function optionsCapture(name: string) {
  const root = resolve(__dirname, '../../../src/scripts/fixtures/current-options-native');
  const build = resolve(root, '../current-capture-build');
  const indexBytes = readFileSync(resolve(root, 'index.json')), index = JSON.parse(indexBytes.toString());
  assert.equal(sha(indexBytes), '278173a1fe01ea68a0fbb34ab0ed3bf9dae022f0a9a7895d4bfa94f74e935cdf');
  const snapshot = readCurrentCaptureManifest({ nativeRoot: resolve(build, 'source'), artifactRoot: resolve(build, 'artifacts'),
    manifestPath: resolve(build, 'manifest.json'), expectedManifestSha256: '9d56c4bf5045e35207f01061f34f26eef6253fdc0b3a619d78cc21249bd319f5' });
  assertCurrentCaptureTargets(snapshot, Object.keys(snapshot.manifest.targets));
  assert.equal(index.manifestSha256, snapshot.sha256);
  const receiptBytes = readFileSync(resolve(root, 'producer-receipt.json')), receipt = JSON.parse(receiptBytes.toString());
  const log = readFileSync(resolve(root, 'producer.log'));
  assert.equal(sha(receiptBytes), index.producerReceiptSha256);
  assert.equal(sha(log), index.logSha256);
  assert.equal(sha(readFileSync(resolve(root, 'source-inventory.json'))), index.sourceInventorySha256);
  assert.equal(receipt.exitCode, 0); assert.equal(receipt.completed, true); assert.equal(receipt.sourcePrePostEqual, true);
  assert.equal(receipt.manifestSha256, snapshot.sha256); assert.match(log.toString(), /^\s+Tests\s+10 passed \(10\)$/m);
  const entry = index.files.find((f: any) => f.originalFile === name); assert(entry);
  const compressed = readFileSync(resolve(root, entry.file)); assert.equal(sha(compressed), entry.sha256);
  const bytes = brotliDecompressSync(compressed);
  assert.equal(bytes.length, entry.originalBytes); assert.equal(sha(bytes), entry.originalSha256);
  assert.equal(receipt.artifacts['captures/' + name], sha(bytes));
  const c = JSON.parse(bytes.toString());
  for (const [key, role] of Object.entries({ factoryHash: 'OptionFactory', vaultHash: 'OptionVault', managerHash: 'OptionSeriesManager',
    shoutHash: 'ShoutOption', outperfHash: 'OutperformanceOption', t3MasterHash: 'T3Hub', t3WalletHash: 'T3Wallet' }))
    assert.equal(c.binding.options[key], snapshot.manifest.targets[role].codeHash);
  assert.equal(c.binding.proofCodeHash, snapshot.manifest.targets.T3RecoveryProof.codeHash);
  for (const key of ['factory', 'vault', 'manager', 'governance', 'feeSink', 'treasury', 't3Root'])
    c.binding.options[key] = Address.parse(c.binding.options[key]);
  return c;
}

describe('current native ledger platform consumption', () => {
  const samples: { name: string; original: any; event: LedgerEvent }[] = [];
  beforeAll(async () => {
    // Native captures are in 2027; leave their original transaction times intact.
    vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000);
    async function add(name: string, input: Parameters<typeof projectOwnerLedger>[0]) {
      const result = await projectOwnerLedger(input);
      await new Promise(resolve => setTimeout(resolve, 0));
      for (const original of result.events) {
        const parsed = ledgerEventSchema.safeParse(original);
        expect(parsed.success, `${name}: ${original.id}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
        if (parsed.success) samples.push({ name, original, event: parsed.data });
      }
    }
    await add('t3', currentT3MintFixture().input);
    const sample = currentDlmmRecoveryOriginals()[0], dlmm = sample.capture ?? sample;
    await add('dlmm', currentDlmmProjectionFixture({ binding: currentDlmmFixtureBinding(dlmm), request: dlmm.request,
      transactions: dlmm.completeTransactions }));
    const perpsWanted = new Set(['open-default.json', 'refund-default.json']);
    for (const { file, capture } of currentPerpsCaptures()) {
      if (!perpsWanted.delete(file)) continue;
      await add(file, currentPerpsProjectionFixture({ ...capture, binding: perpsCaptureBinding(capture) }));
      if (!perpsWanted.size) break;
    }
    expect(perpsWanted.size).toBe(0);
    for (const file of ['buy-default.json', 'refund-default.json', 'payout-default.json', 'owed-default.json'])
      await add(`options:${file}`, currentOptionsProjectionFixture(optionsCapture(file)));
    const world = currentLaunchpadCaptures().next().value!;
    const capture = world.capture, binding = currentLaunchpadBindingFromManifest(capture.release);
    for (const owner of new Set<string>(world.requests.map((r: any) => r.owner)))
      await add(`launchpad:${owner}`, currentLaunchpadProjectionFixture({ binding, request: { owner },
        completeTransactions: capture.completeTransactions }));
    vi.mocked(Date.now).mockReturnValue((Math.max(...samples.flatMap(s => [s.event.utime, ...(s.event.settlement?.evidence ?? []).map(r => r.utime)])) + 3600) * 1000);
  }, 120_000);
  afterAll(() => vi.restoreAllMocks());

  it('preserves every current economics object without dropping its fields', () => {
    for (const key of ['currentDlmm', 'currentPerps', 'currentOptions', 'currentLaunchpad'] as const) {
      const selected = samples.filter(s => s.original.settlement?.[key]);
      expect(selected.length, key).toBeGreaterThan(0);
      for (const s of selected) expect(s.event.settlement![key]).toEqual(s.original.settlement[key]);
    }
    expect(samples.some(s => s.event.settlement?.t3?.stage === 'refunded')).toBe(true);
    expect(samples.some(s => s.event.settlement?.t3?.reserveRoots.length === 0)).toBe(true);
  });

  it('announces native current product settlement with physical cash and retained source evidence', () => {
    for (const key of ['currentDlmm', 'currentPerps', 'currentOptions', 'currentLaunchpad'] as const) {
      const events = samples.filter(s => s.event.settlement?.[key] && s.event.settlement.status === 'confirmed');
      expect(events.length, key).toBeGreaterThan(0);
      for (const { event, name } of events) {
        const notice = ledgerNotification(event);
        expect(notice, `${name}: ${key} ${event.settlement![key]!.kind}`).not.toBeNull();
        expect(notice!.category).toBe('activity');
        expect(notice!.title).not.toBe('Wallet transaction confirmed');
        expect(notice!.evidence.settlement).toEqual(event.settlement);
        expect(Date.parse(notice!.occurredAt)).toBe(Math.max(...event.settlement!.evidence.map(ref => ref.utime)) * 1000);
      }
    }
    for (const stage of ['minted', 'redeemed', 'refunded']) {
      const selected = samples.filter(s => s.event.settlement?.t3?.receipt && s.event.settlement.t3.stage === stage);
      expect(selected.length, stage).toBeGreaterThan(0);
      for (const { event } of selected) expect(ledgerNotification(event)?.category, stage).toBe('activity');
    }
  });

  it('refuses incomplete, missing-cash, substituted-owner and detached physical references', () => {
    for (const key of ['currentDlmm', 'currentPerps', 'currentOptions', 'currentLaunchpad'] as const) {
      const original = samples.find(s => s.event.settlement?.[key] && s.event.settlement.status === 'confirmed' &&
        s.event.settlement[key]!.cash.length)!.event;
      for (const mutate of [
        (event: LedgerEvent) => { event.settlement!.status = 'incomplete'; },
        (event: LedgerEvent) => { event.movements = event.movements.filter(m => m.asset.kind !== 'jetton'); },
        (event: LedgerEvent) => { event.settlement![key]!.owner = `0:${'11'.repeat(32)}`; },
        (event: LedgerEvent) => { event.settlement!.evidence.pop(); },
        (event: LedgerEvent) => { event.settlement![key]!.cash.push(structuredClone(event.settlement![key]!.cash[0]!) as never); },
      ]) {
        const event = structuredClone(original); mutate(event); expect(ledgerNotification(event), key).toBeNull();
      }
    }
  });

  it('does not call accounting allocations or owed recovery additional income', () => {
    const events = samples.filter(s => s.event.settlement?.currentOptions?.aggregateOwed && s.event.settlement.status === 'confirmed');
    expect(events.length).toBeGreaterThan(0);
    for (const { event } of events) expect(ledgerNotification(event)?.body).toContain('original income classification remains unresolved');
  });

  it('requires both physical legs of current Launchpad project-token delivery', () => {
    const event = structuredClone(samples.find(s => s.event.settlement?.currentLaunchpad &&
      s.event.settlement.status === 'confirmed' && s.event.movements.some(m => m.evidence?.kind === 'jetton_transfer'))!.event);
    expect(ledgerNotification(event)).not.toBeNull();
    const movement = event.movements.find(m => m.evidence?.kind === 'jetton_transfer')!;
    movement.evidence!.transactions = movement.evidence!.transactions!.filter(ref => ref.account === movement.asset.wallet);
    expect(ledgerNotification(event)).toBeNull();
  });

  it('refuses contradictory current T3 receipt stages and missing original cash', () => {
    for (const { event: original } of samples.filter(s => s.event.settlement?.t3?.receipt && s.event.settlement.status === 'confirmed')) {
      for (const mutate of [
        (event: LedgerEvent) => { event.movements = event.movements.filter(m => m.direction !== 'out'); },
        (event: LedgerEvent) => { event.settlement!.t3!.receipt!.hash = '00'.repeat(32); },
        (event: LedgerEvent) => { event.settlement!.t3!.receipt!.request.amountRaw = '0'; },
        (event: LedgerEvent) => { event.settlement!.t3!.stage = 'claimable'; },
      ]) {
        const event = structuredClone(original); mutate(event); expect(ledgerNotification(event)).toBeNull();
      }
    }
  });

  it('rejects malformed current shapes rather than admitting arbitrary records', () => {
    const original = samples.find(s => s.event.settlement?.currentPerps)!.event;
    const malformed: any = structuredClone(original); malformed.settlement.currentPerps.cash = [{ received: true }];
    expect(ledgerEventSchema.safeParse(malformed).success).toBe(false);
    const unknown: any = structuredClone(original); unknown.settlement.currentPerps.inventedCash = '1';
    expect(ledgerEventSchema.safeParse(unknown).success).toBe(false);
    const t3: any = structuredClone(samples.find(s => s.event.settlement?.t3?.stage === 'minted')!.event);
    t3.settlement.t3.reserveRoots = []; expect(ledgerEventSchema.safeParse(t3).success).toBe(false);
  });

  it('rejects retired product formats retained as historical evidence', () => {
    for (const name of ['t3-mint', 'perps-open', 'option-activation', 'option-exercise', 'launchpad-fixed-refund-confirmed']) {
      const fixture = JSON.parse(readFileSync(resolve(__dirname, `fixtures/${name}.json`), 'utf8'));
      const products = fixture.events.filter((e: any) => e.settlement && e.settlement.protocol !== 'jetton');
      expect(products.length, name).toBeGreaterThan(0);
      for (const event of products) expect(ledgerEventSchema.safeParse(event).success, name).toBe(false);
    }
  });

  it('persists native current settlement once after completion and keeps read state across publication revisions', async () => {
    const original = samples.find(s => s.event.settlement?.currentOptions?.kind === 'payout' &&
      s.event.settlement.status === 'confirmed')!.event;
    // Only the service network/asset namespace is translated for this isolated
    // test transport. Original addresses, amounts, hashes and times stay intact.
    const complete = structuredClone(original); complete.network = 'testnet';
    for (const m of complete.movements) m.asset.id = m.asset.id.replace(/^localnet:/, 'testnet:');
    const pending = structuredClone(complete); pending.settlement!.status = 'incomplete';
    pending.settlement!.currentOptions!.pendingOutRaw = '1';
    let db: Database, cleanup: () => Promise<void>;
    if (process.env.PLATFORM_TEST_DATABASE_URL) {
      const url = new URL(process.env.PLATFORM_TEST_DATABASE_URL);
      if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.startsWith('/tonswap_platform_test_'))
        throw Error('Native integration requires its disposable loopback test database.');
      const admin = postgres(url.toString()), schema = `current_ledger_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`CREATE SCHEMA ${schema}`); url.searchParams.set('options', `-csearch_path=${schema}`);
      db = postgres(url.toString()); await migrate(db);
      cleanup = async () => { await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); };
    } else { db = await database(); cleanup = () => db.close(); }
    try {
      const cfg = config(), store = new Store(db, cfg), owner = await session(store, complete.account);
      await store.setPreferences(owner, { activity: true });
      await db.query('UPDATE platform_preferences SET activity_enabled_at=to_timestamp($1) WHERE wallet_address=$2 AND network=$3',
        [Math.min(complete.utime, ...complete.settlement!.evidence.map(r => r.utime)) - 1, complete.account, 'testnet']);
      const job = (await store.lease('native-current-ledger', 10)).find(row => row.kind === 'poll_wallet')!;
      const since = (await store.walletMonitoring(complete.account, 'testnet')).activity!;
      const timestamp = new Date(Date.now()).toISOString(), checkpoint = `ledger-discovery:testnet:${complete.account}`;
      let revision = 1, current = pending;
      const worker = new Worker(cfg, store, new Providers(db, cfg), new PushSender(cfg), async () => {
        const generation = randomUUID();
        return new Response(JSON.stringify({ network: 'testnet', account: complete.account, since,
          throughRevision: String(revision), nextCursor: null,
          revisions: [{ revision: String(revision), generation, discoveredAt: timestamp,
            evidenceUtime: Math.max(...complete.settlement!.evidence.map(r => r.utime)), event: current }],
          coverage: { generation, publishedAt: timestamp, headObservedAt: timestamp, checkedAt: timestamp,
            snapshotComplete: true, historyComplete: true, decodingComplete: true, syncing: false, issues: [] } }));
      });
      await worker.pollWallet(job); expect((await store.inbox(owner, 100)).notifications).toHaveLength(0);
      current = complete; revision++; await worker.pollWallet(job);
      const delivered = (await store.inbox(owner, 100)).notifications;
      expect(delivered).toHaveLength(1); expect(delivered[0]!.title).toBe('Option settlement confirmed');
      await store.markRead(owner, delivered[0]!.id);
      current = { ...complete, id: 'rebuilt-native-current-event' }; revision++; await worker.pollWallet(job);
      const retained = (await store.inbox(owner, 100)).notifications;
      expect(retained).toHaveLength(1); expect(retained[0]!.id).toBe(delivered[0]!.id);
      expect(retained[0]!.readAt).not.toBeNull();
      expect(await store.checkpoint(checkpoint)).toMatchObject({ afterRevision: '3' });
    } finally { await cleanup(); }
  }, 30_000);
});

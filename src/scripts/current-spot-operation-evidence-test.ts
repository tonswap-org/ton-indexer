/** Retained native facts with explicitly synthetic consensus/getter responses.
 * Never invent missing original account envelopes or qualify a public release. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { Address, Cell, Dictionary, TupleReader, beginCell, contractAddress, loadMessage, parseTuple, serializeTuple, type TupleItem } from '@ton/core';
import type { AccountStateResponse, ChainHead } from '../data/dataSource';
import { hashReleaseManifest, type RuntimeReleaseManifest } from '../config/runtimeManifest';
import { readCurrentT3Wallet } from '../ledger/currentT3State';
import { orderCell, orderShard, verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { canonicalOrderTerms, orderInitialData, orderTermsToCell, parseOrderTerms } from '../orders/state';
import { collectSpotOperationEvidence, SPOT_EVIDENCE_LIMITS } from '../runtime/spotOperationEvidence';
import { readSpotOperationRequest, type CurrentSpotRequest } from '../runtime/spotOperationRequest';
import { boundaryState, canonicalPhysicalMessage, createPhysicalEvidenceReader, type PhysicalBoundary, type PhysicalEvidenceStore } from '../runtime/physicalEvidence';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';
import { fakeChainSource } from './support/fakeChainSource';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const digest = (cell: Cell) => cell.hash().toString('hex');
const addr = (raw: string): TupleItem => ({ type: 'slice', cell: beginCell().storeAddress(Address.parse(raw)).endCell() });
const integer = (value: bigint | number): TupleItem => ({ type: 'int', value: BigInt(value) });
const key = (row: OrderTransactionEvidence) => { const tx = verifyOrderTransaction(row); return `${row.account}:${tx.tx.lt}:${tx.hash}`; };
type CurrentAccount = { address: string; shardAccountBoc: string };
const budgetWidths = [['senderGas', 32], ['walletBounceGas', 32], ['burnWalletGas', 32], ['smallPayloadCells', 16],
  ['largeWalletGas', 32], ['largeSenderGas', 32], ['rentSeconds', 32], ['rentBits', 32], ['rentCells', 16],
  ['initBits', 32], ['initCells', 16], ['initCopies', 8], ['transferBits', 16], ['transferCells', 8], ['transferCopies', 8]] as const;

/** Mirrors the native getter from original storage, independent of the manifest. */
function poolObservation(data: Cell) {
  const s = data.beginParse(), flags = s.loadUint(8), binSpacing = s.loadUint(16), feePips = s.loadUint(32), xDecimals = s.loadUint(8);
  const activeBin = s.loadInt(32), fees = s.loadCoins(), bins = s.loadUint(16), positions = s.loadUint(16), campaigns = s.loadUint(8);
  const jet = s.loadRef().beginParse(), amm = s.loadRef().beginParse(); s.loadRef(); const cold = s.loadRef().beginParse(); s.endParse();
  const slots = jet.loadDict(Dictionary.Keys.Uint(8), { serialize() { throw Error('read only'); }, parse(p) {
    const master = p.loadAddress().toRawString(), wallet = p.loadMaybeAddress()?.toRawString() ?? null;
    const gas = p.loadUint(32), gram = p.loadCoins(), optional = p.loadBit(), budgetCell = p.loadRef(); p.endParse();
    const b = budgetCell.beginParse(), budget = {} as RuntimeReleaseManifest['spotMarkets'][number]['walletBudgetX'];
    for (const [name, width] of budgetWidths) budget[name] = b.loadUint(width);
    budget.creditProtection = b.loadBit(); b.endParse(); return { master, wallet, gas, gram, optional, budget, budgetCell };
  } });
  const t3 = slots.get(0), x = slots.get(1); assert(t3 && x && slots.size === 2);
  const factory = cold.loadAddress().toRawString(), feeSink = cold.loadAddress().toRawString(), treasury = cold.loadAddress().toRawString();
  const id = beginCell().storeAddress(Address.parse(x.master)).storeUint(binSpacing, 16).storeUint(feePips, 32)
    .storeUint(xDecimals, 8).storeUint(x.gas, 32).storeCoins(x.gram).storeRef(x.budgetCell).endCell();
  const stack: TupleItem[] = [{ type: 'cell', cell: id }, addr(factory), addr(feeSink), addr(treasury), addr(t3.master),
    integer(flags), integer((flags & 1) !== 0 && [...slots.values()].every(slot => slot.optional || slot.wallet) ? -1 : 0),
    integer(activeBin), integer(amm.loadCoins()), integer(amm.loadCoins()), integer(fees), integer(bins), integer(positions), integer(campaigns)];
  return { stack, factory, feeSink, treasury, t3, x, market: { symbol: 'X', pool: '', binSpacing, feePips, xDecimals,
    walletGasX: x.gas, walletGramX: x.gram.toString(), walletBudgetX: x.budget } };
}

export function spotEvidenceFixtureAdapter(manifest: RuntimeReleaseManifest, accounts: CurrentAccount[], rows: OrderTransactionEvidence[], time: number, getters: any[] = []) {
  const head: ChainHead = { workchain: -1, shard: '-9223372036854775808', seqno: 1, rootHashHex: '1'.repeat(64), fileHashHex: '2'.repeat(64), utime: time };
  const states = new Map(accounts.map(a => [a.address, boundaryState(a.address, a.shardAccountBoc, 1).state]));
  const retained = new Map(rows.map(evidence => [key(evidence), { evidence, seqno: 1 } satisfies PhysicalBoundary]));
  const control = { missingAccount: '', missingBoundary: '', missingProof: '', wrongCode: '', unprovenAbsence: '',
    uninitializedAccounts: new Set<string>(), reads: 0, archiveReads: 0 };
  const wallets = new Map<string, { owner: string; master: string; balance: bigint; code: Cell }>();
  for (const [address, state] of states) {
    if (!state.codeBoc || !state.dataBoc) continue;
    // Original native captures may include unrelated library-reference code.
    // Identity selection is by the exact release hash; account/transaction
    // envelopes still require ordinary roots in their own verifier.
    const roots = Cell.fromBoc(Buffer.from(state.codeBoc, 'base64')); assert.equal(roots.length, 1);
    const code = roots[0], token = manifest.tokens.find(t => t.walletCodeHash === digest(code));
    if (!token) continue;
    const observed = getters.filter(g => g.address === address && g.method === 'get_wallet_data');
    if (observed.length) {
      assert.equal(observed.length, 1); assert([0, 1].includes(observed[0].exitCode));
      const native = new TupleReader(parseTuple(orderCell(observed[0].resultBoc)));
      const balance = native.readBigNumber(), owner = native.readAddress().toRawString(), master = native.readAddress().toRawString(), walletCode = native.readCell();
      assert.equal(native.remaining, 0); assert.equal(digest(walletCode), token.walletCodeHash); assert.equal(master, token.root);
      wallets.set(address, { balance, owner, master, code: walletCode }); continue;
    }
    if (digest(code) === manifest.templates.T3Wallet) {
      const w = readCurrentT3Wallet(state.dataBoc); wallets.set(address, { owner: w.owner, master: w.master, balance: w.balance, code });
    } else {
      const s = orderCell(state.dataBoc).beginParse(); if (digest(code) === manifest.vendor.stablecoin.wallet.codeHash) s.loadUint(4);
      const balance = s.loadCoins(), owner = s.loadAddress().toRawString(), master = s.loadAddress().toRawString(); s.endParse();
      wallets.set(address, { balance, owner, master, code });
    }
  }
  const source = fakeChainSource({ network: 'localnet', head: async () => head,
    getAccountState: async (address, options): Promise<AccountStateResponse> => {
      assert.equal(options?.at, head, 'every current read uses the same full head'); control.reads++;
      const state = states.get(address); assert(state, `Missing original current envelope: ${address}`);
      if (state.shardAccountBoc && !orderShard(state.shardAccountBoc, address).shard.account)
        return { accountState: 'uninitialized', balance: '0', codeBoc: null, dataBoc: null,
          ...(control.unprovenAbsence === address ? {} : { provenAbsent: true as const }),
          anchor: { shardBlock: { ...head, workchain: 0 }, genUtime: time } };
      // Explicit synthetic current-absence seam test. No original capture cell
      // is changed and no replacement ShardAccount envelope is manufactured.
      if (control.uninitializedAccounts.has(address)) return { accountState: 'uninitialized', balance: '0', codeBoc: null, dataBoc: null,
        lastTxLt: '0', lastTxHash: undefined, anchor: { shardBlock: { ...head, workchain: 0 }, genUtime: time } };
      return { ...state, ...(control.missingProof === address ? { shardAccountBoc: undefined } : {}),
        ...(control.wrongCode === address ? { codeBoc: Cell.EMPTY.toBoc().toString('base64') } : {}),
        anchor: { shardBlock: { ...head, workchain: 0 }, genUtime: time } };
    },
    runGetMethod: async (address, method, args, options) => {
      assert.equal(options?.at, head, 'every getter uses the same full head');
      const state = states.get(address); assert(state?.dataBoc && state.codeBoc);
      const observed = getters.filter(g => g.address === address && g.method === method && orderCell(g.argsBoc).equals(serializeTuple(args ?? [])));
      if (observed.length) {
        assert.equal(observed.length, 1); const captured = { exitCode: observed[0].exitCode, stack: parseTuple(orderCell(observed[0].resultBoc)) };
        if (method === 'get_pool_info') assert(serializeTuple(captured.stack).equals(serializeTuple(poolObservation(orderCell(state.dataBoc)).stack)), 'native getter agrees with original storage');
        return captured;
      }
      if (getters.length && method !== 'get_jetton_data') throw Error(`Missing original native getter: ${method}`);
      if (method === 'get_pool_info') return { exitCode: 0, stack: poolObservation(orderCell(state.dataBoc)).stack };
      const token = manifest.tokens.find(t => t.root === address), wallet = wallets.get(address);
      if (token) {
        assert.equal(digest(orderCell(state.codeBoc)), token.masterCodeHash, 'actual captured master authority');
        const code = [...wallets.values()].find(w => w.master === address)?.code; assert(code, 'captured canonical wallet code');
        if (method === 'get_jetton_data') return { exitCode: 0, stack: [integer(0), integer(-1), { type: 'null' }, { type: 'cell', cell: Cell.EMPTY }, { type: 'cell', cell: code }] };
        assert.equal(method, 'get_wallet_address'); assert(args && args[0].type === 'slice');
        const owner = args[0].cell.beginParse().loadAddress().toRawString();
        const selected = [...wallets].filter(([, w]) => w.owner === owner && w.master === address); assert.equal(selected.length, 1);
        return { exitCode: 0, stack: [addr(selected[0][0])] };
      }
      assert.equal(method, 'get_wallet_data'); assert(wallet);
      return { exitCode: 0, stack: [integer(wallet.balance), addr(wallet.owner), addr(wallet.master), { type: 'cell', cell: wallet.code }] };
    },
    getTransactions: async () => { control.archiveReads++; throw Error('Original archive evidence is absent'); },
  });
  const store: PhysicalEvidenceStore = { evidenceBoundary: async (account, lt, hash) => control.missingAccount === account
    || control.missingBoundary === `${account}:${lt}:${hash}` ? null : retained.get(`${account}:${lt}:${hash}`) ?? null,
    retain: async () => { throw Error('Read-only retained evidence'); } };
  return { source, store, head, states, control };
}

function latestAccounts(rows: OrderTransactionEvidence[]): CurrentAccount[] {
  const latest = new Map<string, OrderTransactionEvidence>();
  for (const row of rows) if (!latest.has(row.account) || verifyOrderTransaction(latest.get(row.account)!).tx.lt < verifyOrderTransaction(row).tx.lt) latest.set(row.account, row);
  return [...latest].map(([address, row]) => ({ address, shardAccountBoc: row.afterShardAccountBoc }));
}
export function scopedSpotEvidenceManifest(pool: string, originalData: string, tokens: RuntimeReleaseManifest['tokens'], patches: Partial<RuntimeReleaseManifest> = {}) {
  const base = runtimeManifestFixture(), p = poolObservation(orderCell(originalData)), t3 = tokens.find(t => t.symbol === 'T3')!;
  const manifest = { ...base, network: 'ton:localnet' as const, releaseId: 'synthetic-native-spot-collector', tokens,
    contracts: { ...base.contracts, T3Hub: { address: t3.root, codeHash: t3.masterCodeHash },
      DlmmPoolFactory: { ...base.contracts.DlmmPoolFactory!, address: p.factory }, FeeRouter: { ...base.contracts.FeeRouter!, address: p.feeSink },
      Treasury: { ...base.contracts.Treasury!, address: p.treasury } }, spotMarkets: [{ ...p.market, pool }], ...patches };
  manifest.manifestHash = hashReleaseManifest(manifest); return manifest;
}

async function main() {
  const capturePath = process.argv[2], ordersPath = process.argv[3], outputPath = process.argv[4];
  assert(capturePath && isAbsolute(capturePath) && ordersPath && isAbsolute(ordersPath), 'Supply absolute direct capture JSON and retained G14 orders directory');
  const captureBytes = readFileSync(capturePath), capture = JSON.parse(captureBytes.toString());
  for (const artifact of Object.values(capture.artifacts) as any[]) {
    const bytes = readFileSync(artifact.file); assert.equal(hash(bytes), artifact.sha256); assert.equal(digest(Cell.fromBoc(bytes)[0]), artifact.codeHash);
  }
  const exported: unknown[] = [], originalNow = Date.now; let canonicalLinks = 0, differentOriginalEncodings = 0;
  try {
    for (const [index, c] of capture.cases.entries() as IterableIterator<[number, any]>) {
      assert(Array.isArray(c.currentAccounts) && c.currentAccounts.length > 0,
        'Pending native capture extension: each case needs original currentAccounts [{address, shardAccountBoc}], including both masters and all four wallets. Never reconstruct missing envelopes.');
      const rows = c.transactions as OrderTransactionEvidence[]; rows.forEach(verifyOrderTransaction);
      const manifest = scopedSpotEvidenceManifest(c.pool.address, c.pool.dataBoc, c.tokens);
      assert.notEqual(manifest.tokens[0].masterCodeHash, capture.artifacts.T3Hub.codeHash, 'test authority must not masquerade as production T3Hub');
      const a = spotEvidenceFixtureAdapter(manifest, c.currentAccounts, rows, c.now, c.getters); Date.now = () => c.now * 1000;
      const origin = rows.find(row => { const m = verifyOrderTransaction(row).tx.inMessage; return row.account === c.wallets.owner[c.side]
        && m?.info.type === 'internal' && m.info.src.toRawString() === c.owner && m.body.bits.length >= 32 && m.body.beginParse().preloadUint(32) === 0x0f8a7ea5; });
      assert(origin); const message = verifyOrderTransaction(origin).tx.inMessage!; assert(message.info.type === 'internal');
      const request: CurrentSpotRequest = { kind: 'direct', network: 'localnet', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
        owner: c.owner, pool: c.pool.address, payRoot: c.tokens[c.side].root, receiveRoot: c.tokens[1 - c.side].root,
        sourceWallet: origin.account, valueNano: message.info.value.coins.toString(), bodyBoc: message.body.toBoc().toString('base64'), bodyHash: digest(message.body) };
      const parsed = readSpotOperationRequest(request, manifest), response = await collectSpotOperationEvidence(manifest, a.source, a.store, parsed);
      assert.equal(response.coverage.complete, true, JSON.stringify(response.coverage)); response.transactions.forEach(verifyOrderTransaction);
      assert(response.transactions.length > 0 && response.transactions.length <= SPOT_EVIDENCE_LIMITS.returnedTransactions);
      assert(Buffer.byteLength(JSON.stringify(response)) <= SPOT_EVIDENCE_LIMITS.responseBytes);
      for (const row of response.transactions) { const checked = verifyOrderTransaction(row);
        for (const outgoing of checked.outgoing.values()) for (const next of response.transactions) {
          const incoming = verifyOrderTransaction(next).incoming;
          if (incoming && canonicalPhysicalMessage(outgoing).equals(canonicalPhysicalMessage(incoming))) {
            canonicalLinks++; if (!outgoing.equals(incoming)) differentOriginalEncodings++;
          }
        }
      }
      const before = a.control.reads; await collectSpotOperationEvidence(manifest, a.source, a.store, parsed); assert(a.control.reads > before);
      a.control.uninitializedAccounts = new Set([c.wallets.owner[1 - c.side], c.wallets.pool[1 - c.side]]);
      const unusedAbsent = await collectSpotOperationEvidence(manifest, a.source, a.store, parsed);
      assert.equal(unusedAbsent.coverage.complete, c.refund, 'Only a fully proved refund may omit unused receive accounts');
      if (c.refund) assert(unusedAbsent.accounts.every(row => !a.control.uninitializedAccounts.has(row.address)));
      a.control.uninitializedAccounts.clear();
      const tampered = readSpotOperationRequest({ ...request, valueNano: (BigInt(request.valueNano) + 1n).toString() }, manifest);
      const missingValue = await collectSpotOperationEvidence(manifest, a.source, a.store, tampered);
      assert(!missingValue.coverage.complete && missingValue.coverage.gaps.some(g => g.code === 'original_request_unobserved'));
      a.control.missingAccount = origin.account;
      const missing = await collectSpotOperationEvidence(manifest, a.source, a.store, parsed); assert.equal(missing.coverage.complete, false);
      const physical = createPhysicalEvidenceReader(a.source, a.store, a.head, { newTransactions: 0 });
      const work = await physical.history(origin.account, await physical.current(origin.account), 1);
      assert(!work.complete && work.gaps.some(g => g.code === 'archive_work_limit'));
      a.control.missingAccount = ''; a.control.missingProof = c.pool.address;
      await assert.rejects(collectSpotOperationEvidence(manifest, a.source, a.store, parsed)); a.control.missingProof = '';
      a.control.wrongCode = request.payRoot; await assert.rejects(collectSpotOperationEvidence(manifest, a.source, a.store, parsed)); a.control.wrongCode = '';
      await assert.rejects(collectSpotOperationEvidence({ ...manifest, templates: { ...manifest.templates, DlmmPool: '0'.repeat(64) } }, a.source, a.store, parsed));
      exported.push({ index, side: c.side, refund: c.refund, expectedOutput: c.expectedOutput, request, manifest, response });
      console.log('direct', index, c.side, c.refund, response.transactions.length);
    }
    assert(canonicalLinks > 0); assert(differentOriginalEncodings > 0, 'Retain real legal message placement differences');

    const receiptBytes = readFileSync(join(ordersPath, 'producer-receipt.json')), receipt = JSON.parse(receiptBytes.toString()); assert.equal(receipt.exitCode, 0);
    for (const [name, expected] of Object.entries(receipt.artifacts)) assert.equal(hash(readFileSync(join(ordersPath, name))), expected);
    const native = JSON.parse(readFileSync(join(ordersPath, 'case-01.json'), 'utf8'));
    const rows: OrderTransactionEvidence[] = native.transactions.map((r: any) => ({ account: r.account, transactionBoc: r.boc,
      beforeShardAccountBoc: r.before.originalShardAccount, afterShardAccountBoc: r.after.originalShardAccount })); rows.forEach(verifyOrderTransaction);
    const creation = rows.find(row => { const m = verifyOrderTransaction(row).tx.inMessage; return m && m.body.bits.length >= 32 && m.body.beginParse().preloadUint(32) === 0x4f435254; }); assert(creation);
    const tx = verifyOrderTransaction(creation), message = tx.tx.inMessage!; assert(message.info.type === 'internal');
    const body = message.body.beginParse(); body.loadUint(32); body.loadUintBig(64); const nonce = body.loadUintBig(64).toString(), termsCell = body.loadRef(); body.endParse();
    const terms = parseOrderTerms(termsCell), pool = terms.pool.toRawString(), accounts = latestAccounts(rows);
    const state = boundaryState(pool, accounts.find(a => a.address === pool)!.shardAccountBoc, 1).state, p = poolObservation(orderCell(state.dataBoc!));
    const base = runtimeManifestFixture(), tokens = [
      { ...base.tokens.find(t => t.symbol === 'T3')!, root: p.t3.master },
      { ...base.tokens.find(t => t.symbol === 'TS')!, symbol: 'X', root: p.x.master, decimals: p.market.xDecimals },
    ];
    const manifest = scopedSpotEvidenceManifest(pool, state.dataBoc!, tokens);
    manifest.contracts.SpotOrderFactory = { address: creation.account, codeHash: receipt.compiled.SpotOrderFactory.codeHash };
    manifest.templates.SpotOrder = receipt.compiled.SpotOrder.codeHash; manifest.manifestHash = hashReleaseManifest(manifest);
    const orderCode = Cell.fromBoc(readFileSync(join(ordersPath, receipt.compiled.SpotOrder.boc)))[0];
    assert.equal(digest(orderCode), manifest.templates.SpotOrder);
    const order = contractAddress(0, { code: orderCode, data: orderInitialData(Address.parse(creation.account), message.info.src, BigInt(nonce)) }).toRawString();
    const request: CurrentSpotRequest = { kind: 'order-create', network: 'localnet', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
      owner: message.info.src.toRawString(), factory: creation.account, order, nonce, pool, inputRoot: terms.inputMaster.toRawString(), termsBoc: termsCell.toBoc().toString('base64'), termsHash: digest(termsCell) };
    const now = Math.max(...rows.map(row => verifyOrderTransaction(row).tx.now)), a = spotEvidenceFixtureAdapter(manifest, accounts, rows, now); Date.now = () => now * 1000;
    const parsed = readSpotOperationRequest(request, manifest);
    const incomplete = await collectSpotOperationEvidence(manifest, a.source, a.store, parsed);
    assert(!incomplete.coverage.complete && incomplete.coverage.gaps.some(g => g.code === 'archive_evidence_unavailable'),
      'The latest G14 child snapshot has omitted predecessor transactions; never declare it complete.');
    const child = rows.find(row => row.account === order && verifyOrderTransaction(row).incoming
      && [...tx.outgoing.values()].some(raw => canonicalPhysicalMessage(raw).equals(canonicalPhysicalMessage(verifyOrderTransaction(row).incoming!)))); assert(child);
    // A bounded creation observation tests the original factory/child facts. The
    // pool envelope and head are explicitly synthetic adapter context, not a
    // claim that the incomplete G14 archive supplies a coherent live snapshot.
    const initialAccounts = accounts.filter(row => row.address !== creation.account && row.address !== order)
      .concat(latestAccounts([creation, child]));
    const initial = spotEvidenceFixtureAdapter(manifest, initialAccounts, [creation, child], now);
    const response = await collectSpotOperationEvidence(manifest, initial.source, initial.store, parsed);
    assert.equal(response.coverage.complete, true, JSON.stringify(response.coverage)); assert.equal(response.transactions.length, 2);
    const initialized = verifyOrderTransaction(response.transactions[1]);
    assert(!initialized.before.account || initialized.before.account.storage.state.type === 'uninit');
    const init = initialized.tx.inMessage!.body.beginParse(); assert.equal(init.loadUint(32), 0x4f494e49); init.loadUintBig(64);
    assert(init.loadRef().equals(canonicalOrderTerms(termsCell, message.info.src, tx.tx.now))); init.endParse();
    assert.equal(terms.startAt, tx.tx.now, 'G14 covers equality, not a nonzero startAt clamp');
    const changed = orderTermsToCell({ ...terms, minOutTotal: terms.minOutTotal + 1n });
    const changedResponse = await collectSpotOperationEvidence(manifest, initial.source, initial.store,
      readSpotOperationRequest({ ...request, termsBoc: changed.toBoc().toString('base64'), termsHash: digest(changed) }, manifest));
    assert(!changedResponse.coverage.complete && changedResponse.coverage.gaps.some(g => g.code === 'creation_request_mismatch'));
    initial.control.missingAccount = creation.account;
    assert.equal((await collectSpotOperationEvidence(manifest, initial.source, initial.store, parsed)).coverage.complete, false);
    exported.push({ request, manifest, response, incompleteLatestCoverage: incomplete.coverage, scope: 'Original G14 factory and child initialization in a bounded synthetic observation; latest G14 history is incomplete. startAt equals transaction time; no nonzero clamp qualification.' });
    if (process.argv[5]) {
      assert(isAbsolute(process.argv[5])); const clampBytes = readFileSync(process.argv[5]), clamp = JSON.parse(clampBytes.toString());
      const originalRows = clamp.delayed.creationBoundaries as OrderTransactionEvidence[]; originalRows.forEach(verifyOrderTransaction);
      const originalTerms = orderCell(clamp.delayed.termsBoc), reviewed = parseOrderTerms(originalTerms);
      const f = originalRows.map(row => ({ account: row.account, ...verifyOrderTransaction(row) })).find(t => t.account === clamp.factory && t.succeeded
        && t.tx.inMessage?.body.bits.length! >= 32 && t.tx.inMessage!.body.beginParse().preloadUint(32) === 0x4f435254); assert(f);
      const b = f.tx.inMessage!.body.beginParse(); b.loadUint(32); b.loadUintBig(64); assert.equal(b.loadUintBig(64).toString(), clamp.delayed.nonce); assert(b.loadRef().equals(originalTerms)); b.endParse();
      const transformed = canonicalOrderTerms(originalTerms, Address.parse(clamp.owner), f.tx.now);
      assert(transformed.equals(orderCell(clamp.delayed.storedTermsBoc))); assert.equal(parseOrderTerms(transformed).startAt, reviewed.startAt + 1);
      const child = originalRows.map(row => ({ account: row.account, ...verifyOrderTransaction(row) })).find(t => t.account === clamp.delayed.order && t.succeeded && t.incoming
        && [...f.outgoing.values()].some(raw => canonicalPhysicalMessage(raw).equals(canonicalPhysicalMessage(t.incoming!)))); assert(child);
      const initialized = child.tx.inMessage!.body.beginParse(); assert.equal(initialized.loadUint(32), 0x4f494e49); initialized.loadUintBig(64);
      assert(initialized.loadRef().equals(transformed)); initialized.endParse();
      exported.push({ capturePath: process.argv[5], captureSha256: hash(clampBytes),
        scope: 'Shared canonicalOrderTerms matches original native factory/child delayed processing with a one-second clamp. This fixture uses placeholder pool/input addresses and does not qualify the full collector or a current pool.' });
    }
    if (outputPath) { assert(isAbsolute(outputPath)); writeFileSync(outputPath, JSON.stringify({ schema: 'tonswap-spot-collector-test-v1',
      scope: 'Original native transaction/account cells; synthetic head and getter adapter; synthetic issuing authority is pinned to its actual captured code. No live release qualification.',
      capturePath, captureSha256: hash(captureBytes), ordersPath, ordersReceiptSha256: hash(receiptBytes), canonicalLinks, differentOriginalEncodings, cases: exported }, null, 2) + '\n', { flag: 'wx' }); }
    console.log('Original direct Spot/refund and order initialization collection checks passed.');
  } finally { Date.now = originalNow; }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

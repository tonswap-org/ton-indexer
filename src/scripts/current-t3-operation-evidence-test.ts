import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { Address, Cell, beginCell, contractAddress, loadMessage, type TupleItem } from '@ton/core';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';
import { hashReleaseManifest } from '../config/releaseManifest';
import { readCurrentT3Hub, readCurrentT3Wallet } from '../ledger/currentT3State';
import { readT3OperationRequest, type CurrentT3Request } from '../runtime/t3OperationRequest';
import { collectT3OperationEvidence } from '../runtime/t3OperationEvidence';
import { collectT3WalletClaimEvidence, readT3WalletClaimRequest } from '../runtime/t3WalletClaimEvidence';
import { t3PathRoot } from '../ledger/currentT3Wire';
import { boundaryState, createPhysicalEvidenceReader, type PhysicalBoundary, type PhysicalEvidenceStore } from '../runtime/physicalEvidence';
import { orderCell, verifyOrderTransaction } from '../orders/evidence';
import { fakeChainSource } from './support/fakeChainSource';
import type { AccountStateResponse, ChainHead } from '../data/dataSource';

/** This adapter uses original retained native cells and synthetic chain/getter
 * responses. It tests collection/correlation only, never consensus or live admission. */
async function main() {
  const root = process.argv[2]; assert(root && isAbsolute(root), 'Supply retained native t3Recovery capture directory');
  const bytes = (name: string) => readFileSync(resolve(root, name));
  const receipt = JSON.parse(bytes('producer-receipt.json').toString()); assert.equal(receipt.exitCode, 0);
  for (const [name, expected] of Object.entries(receipt.artifacts))
    assert.equal(createHash('sha256').update(bytes(name)).digest('hex'), expected, name + ' original artifact');
  const code = (role: string) => Cell.fromBoc(bytes(receipt.compiled[role].boc))[0];
  for (const [role, value] of Object.entries(receipt.compiled) as [string, any][])
    assert.equal(code(role).hash().toString('hex'), value.codeHash);
  const captured = JSON.parse(bytes('case-01.json').toString());
  const beforeLt = process.argv[4]; if (beforeLt) assert(/^[1-9][0-9]*$/.test(beforeLt));
  const rows: PhysicalBoundary[] = captured.transactions.map((row: any) => ({ seqno: 1, evidence: { account: row.account,
    transactionBoc: row.boc, beforeShardAccountBoc: row.before.originalShardAccount, afterShardAccountBoc: row.after.originalShardAccount } }));
  if (beforeLt) for (let index = rows.length - 1; index >= 0; index--)
    if (verifyOrderTransaction(rows[index].evidence).tx.lt >= BigInt(beforeLt)) rows.splice(index, 1);
  const latest = new Map<string, PhysicalBoundary>();
  for (const row of rows) { const checked = verifyOrderTransaction(row.evidence), previous = latest.get(row.evidence.account);
    if (!previous || verifyOrderTransaction(previous.evidence).tx.lt < checked.tx.lt) latest.set(row.evidence.account, row); }
  const states = new Map([...latest].map(([account, row]) => [account, boundaryState(account, row.evidence.afterShardAccountBoc, 1).state]));
  const hubEntry = [...states].find(([, state]) => state.codeBoc && orderCell(state.codeBoc).hash().equals(code('T3Hub').hash()))!;
  assert(hubEntry); const [hub, hubState] = hubEntry, state = readCurrentT3Hub(hubState.dataBoc!);
  const base = runtimeManifestFixture();
  const capturedCode = (hash: string) => orderCell([...states.values()].find(value => value.codeBoc && orderCell(value.codeBoc).hash().toString('hex') === hash)!.codeBoc!);
  const stableCode = capturedCode(base.vendor.stablecoin.wallet.codeHash);
  const walletCodes = [0, 1, 2].map(slot => capturedCode(state.policies.get(slot)!.codeHash));
  const masterCodes = [0, 1, 2].map(slot => orderCell(states.get(state.slots.get(slot)!.master)!.codeBoc!));
  for (const master of masterCodes) assert.equal(master.hash().toString('hex'), base.vendor.stablecoin.minter.codeHash);
  const tokens = [...state.slots].map(([slot, profile]) => ({ symbol: ['USDT', 'USDC', 'KUSD'][slot], root: profile.master,
    decimals: 9 - Math.log10(state.policies.get(slot)!.scale), masterCodeHash: masterCodes[slot].hash().toString('hex'), walletCodeHash: walletCodes[slot].hash().toString('hex') }));
  tokens.unshift({ symbol: 'T3', root: hub, decimals: 9, masterCodeHash: code('T3Hub').hash().toString('hex'), walletCodeHash: state.walletCodeHash });
  const manifest = { ...base, network: 'ton:localnet' as const, globalId: -3, releaseId: 'synthetic-native-t3-collector-test',
    contracts: { ...base.contracts, T3Hub: { address: hub, codeHash: code('T3Hub').hash().toString('hex') }, Governance: { ...base.contracts.Governance!, address: state.governance } },
    templates: { ...base.templates, T3Wallet: state.walletCodeHash, T3RecoveryProof: state.proofCodeHash },
    vendor: { ...base.vendor, stablecoin: { ...base.vendor.stablecoin, wallet: { ...base.vendor.stablecoin.wallet, codeHash: stableCode.hash().toString('hex') } } }, tokens };
  manifest.manifestHash = hashReleaseManifest(manifest);
  const wallets = new Map<string, { owner: string; master: string; balance: bigint; code: Cell }>();
  for (const [account, value] of states) {
    if (!value.codeBoc || !value.dataBoc) continue;
    const walletCode = orderCell(value.codeBoc), hash = walletCode.hash().toString('hex');
    if (hash === state.walletCodeHash) { const w = readCurrentT3Wallet(value.dataBoc); wallets.set(account, { ...w, code: walletCode }); }
    else if (walletCodes.some(c => c.hash().equals(walletCode.hash()))) {
      const s = orderCell(value.dataBoc).beginParse(); if (walletCode.hash().equals(stableCode.hash())) s.loadUint(4);
      const balance = s.loadCoins(), owner = s.loadAddress().toRawString(), master = s.loadAddress().toRawString(); s.endParse();
      wallets.set(account, { balance, owner, master, code: walletCode });
    }
  }
  const unixTime = Math.max(...rows.map(row => verifyOrderTransaction(row.evidence).tx.now)) + 1;
  const head: ChainHead = { workchain: -1, shard: '-9223372036854775808', seqno: 1, rootHashHex: '1'.repeat(64), fileHashHex: '2'.repeat(64), utime: unixTime };
  const addr = (raw: string): TupleItem => ({ type: 'slice', cell: beginCell().storeAddress(Address.parse(raw)).endCell() });
  let reads = 0, missingHubHistory = false, corruptCurrent = false, missingWalletHistory = false;
  const source = fakeChainSource({ network: 'localnet', head: async () => head,
    getAccountState: async (account, options): Promise<AccountStateResponse> => {
      assert.equal(options?.at, head); reads++;
      const current = states.get(account);
      if (current) return { ...current, ...(corruptCurrent && account === hub ? { shardAccountBoc: undefined } : {}), anchor: { shardBlock: { ...head, workchain: 0 }, genUtime: unixTime } };
      const token = tokens.find(t => t.root === account);
      if (token) return { balance: '0', accountState: 'active', codeBoc: masterCodes[['USDT', 'USDC', 'KUSD'].indexOf(token.symbol)].toBoc().toString('base64') };
      return { balance: '0', accountState: 'uninitialized', lastTxLt: '0', lastTxHash: '0'.repeat(64) };
    },
    runGetMethod: async (account, method, args, options) => {
      assert.equal(options?.at, head); const token = tokens.find(t => t.root === account), wallet = wallets.get(account);
      const slot = token ? ['USDT', 'USDC', 'KUSD'].indexOf(token.symbol) : -1;
      const walletCode = token?.symbol === 'T3' ? code('T3Wallet') : walletCodes[slot];
      if (method === 'get_jetton_data') return { exitCode: 0, stack: [{ type: 'int', value: 0n }, { type: 'int', value: -1n }, { type: 'null' }, { type: 'cell', cell: Cell.EMPTY }, { type: 'cell', cell: walletCode }] };
      if (method === 'get_wallet_address') {
        assert(args && args[0].type === 'slice'); const owner = args[0].cell.beginParse().loadAddress().toRawString();
        const known = [...wallets].find(([, w]) => w.owner === owner && w.master === account)?.[0];
        const derived = known ?? contractAddress(0, { code: walletCode, data: beginCell().storeCoins(0).storeAddress(Address.parse(owner)).storeAddress(Address.parse(account)).endCell() }).toRawString();
        return { exitCode: 0, stack: [addr(derived)] };
      }
      assert.equal(method, 'get_wallet_data'); assert(wallet);
      return { exitCode: 0, stack: [{ type: 'int', value: wallet.balance }, addr(wallet.owner), addr(wallet.master), { type: 'cell', cell: wallet.code }] };
    },
    getTransactions: async () => { throw Error('Missing retained evidence stays unavailable in this adapter'); },
  });
  const retained = new Map(rows.map(row => { const tx = verifyOrderTransaction(row.evidence); return [`${row.evidence.account}:${tx.tx.lt}:${tx.hash}`, row]; }));
  const store: PhysicalEvidenceStore = { evidenceBoundary: async (account, lt, hash) => (missingHubHistory && account === hub || missingWalletHistory && wallets.get(account)?.master === hub) ? null : retained.get(`${account}:${lt}:${hash}`) ?? null,
    retain: async () => { throw Error('This test reads retained original facts only'); } };
  const makeRequest = (kind: 'mint' | 'redeem', wanted = 0) => {
    let found = 0;
    for (const row of rows) {
      const checked = verifyOrderTransaction(row.evidence); if (!checked.incoming) continue;
      const message = loadMessage(checked.incoming.beginParse()); if (message.info.type !== 'internal' || message.info.bounced || message.body.bits.length < 32) continue;
      const b = message.body.beginParse(), op = b.loadUint(32); if (op !== (kind === 'mint' ? 0x0f8a7ea5 : 0x595f07bc)) continue;
      try {
        const queryId = b.loadUintBig(64).toString(), amountRaw = b.loadCoins().toString(); let intent: Cell;
        if (kind === 'mint') { assert.equal(b.loadAddress().toRawString(), hub); b.loadMaybeAddress(); b.loadMaybeRef(); b.loadCoins(); intent = b.loadBit() ? b.loadRef() : beginCell().storeSlice(b).endCell(); }
        else { b.loadAddress(); intent = b.loadMaybeRef()!; }
        const terms = intent.beginParse(); assert.equal(terms.loadUint(32), kind === 'mint' ? 0x54334d4e : 0x54335244);
        const single = kind === 'redeem' ? terms.loadBit() : false, outputToken = kind === 'redeem' ? terms.loadUint(2) as 0 | 1 | 2 : 0;
        if (kind === 'redeem') assert.equal(terms.loadBit(), false);
        const minimumRaw = terms.loadCoins().toString(), recipient = terms.loadAddress().toRawString(); terms.endParse();
        const common = { network: 'localnet', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash, owner: message.info.src.toRawString(), hub,
          queryId, amountRaw, recipient, minimumRaw, bodyBoc: message.body.toBoc().toString('base64'), bodyHash: message.body.hash().toString('hex') };
        const master = wallets.get(row.evidence.account)!.master, input = tokens.findIndex(t => t.root === master) - 1;
        const request: CurrentT3Request = kind === 'mint' ? { ...common, kind, collateralRoot: master, input: input as 0 | 1 | 2,
          sourceWallet: row.evidence.account, valueNano: message.info.value.coins.toString(), submittedAt: unixTime * 1000 }
          : { ...common, kind, wallet: row.evidence.account, single, outputToken, createdAt: unixTime * 1000 };
        const parsed = readT3OperationRequest(request, manifest);
        if (found++ === wanted) return parsed;
      } catch { /* Another original operation is outside the requested shape. */ }
    }
    throw Error('No original ' + kind + ' request found');
  };
  const originalNow = Date.now; Date.now = () => unixTime * 1000;
  const exported: unknown[] = [];
  try {
    for (const kind of ['mint', 'redeem'] as const) {
      const request = makeRequest(kind), result = await collectT3OperationEvidence(manifest, source, store, request);
      assert.equal(result.schema, 'tonswap-t3-operation-evidence-v1'); assert.equal(result.request.bodyHash, request.request.bodyHash);
      assert.deepEqual(result.asOf, { masterchainSeqno: 1, unixTime, blockRootHash: head.rootHashHex });
      assert(result.receipts.length > 0, JSON.stringify(result.coverage)); assert(result.transactions.length > 0, JSON.stringify(result.coverage));
      assert.equal(result.coverage.complete, true, JSON.stringify(result.coverage));
      assert(!result.coverage.gaps.some(gap => gap.code === 'receipt_transaction_unavailable'), 'credit keys must correlate through logs, not hub LT');
      for (const row of result.transactions) verifyOrderTransaction(row);
      assert(result.receipts.every(row => row.owner === request.request.owner));
      assert(result.transactions.length <= 256); assert(result.receipts.length <= 32); assert(Buffer.byteLength(JSON.stringify(result)) <= 8 * 1024 * 1024);
      exported.push({ request: request.request, response: result, binding: { network: 'localnet', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
        hub, governance: state.governance, hubCodeHash: code('T3Hub').hash().toString('hex'), walletCodeHash: state.walletCodeHash, recoveryProofCodeHash: state.proofCodeHash,
        reserves: [0, 1, 2].map(slot => ({ slot, symbol: ['USDT', 'USDC', 'KUSD'][slot], master: state.slots.get(slot)!.master,
          masterCodeHash: masterCodes[slot].hash().toString('hex'), walletCodeHash: walletCodes[slot].hash().toString('hex'), decimals: tokens[slot + 1].decimals })) } });
      console.log(kind, result.receipts.length, result.transactions.length, result.coverage);
    }
    // Native sandbox setup tops up treasury GRAM outside a transaction. Every
    // individual transaction still verifies, but the full physical account
    // history must refuse that gap instead of normalizing either boundary.
    const discontinuity = rows.find(row => {
      const checked = verifyOrderTransaction(row.evidence), previous = retained.get(`${row.evidence.account}:${checked.tx.prevTransactionLt}:${checked.tx.prevTransactionHash.toString(16).padStart(64, '0')}`);
      return previous && !orderCell(previous.evidence.afterShardAccountBoc).equals(orderCell(row.evidence.beforeShardAccountBoc));
    });
    assert(discontinuity, 'Retained native treasury top-up remains explicit');
    const physical = createPhysicalEvidenceReader(source, store, head, { newTransactions: 0 });
    const discontinuous = await physical.history(discontinuity.evidence.account, await physical.current(discontinuity.evidence.account), 256);
    assert.equal(discontinuous.complete, false);
    assert(discontinuous.gaps.some(gap => gap.code === 'archive_evidence_unavailable'), 'Out-of-transaction balance changes never become continuous physical history');
    const before = reads; await collectT3OperationEvidence(manifest, source, store, makeRequest('mint')); assert(reads > before, 'current account reads are never cached');
    const walletRequest = readT3WalletClaimRequest(makeRequest('redeem').request, manifest);
    const claims = await collectT3WalletClaimEvidence(manifest, source, store, walletRequest);
    assert.equal(claims.coverage.complete, true, JSON.stringify(claims.coverage));
    assert.equal(claims.request.bodyHash, walletRequest.request.bodyHash); assert.equal(claims.claims.records.length, 1);
    for (const record of claims.claims.records) {
      assert.equal(record.burn, true); assert.equal(record.recipient, walletRequest.request.owner);
      assert.equal(t3PathRoot(BigInt(record.id), orderCell(record.recordBoc), orderCell(record.proofBoc)).toString(16).padStart(64, '0'), claims.claims.root);
    }
    const claimReads = reads; await collectT3WalletClaimEvidence(manifest, source, store, walletRequest); assert(reads > claimReads);
    missingWalletHistory = true;
    const missingClaims = await collectT3WalletClaimEvidence(manifest, source, store, walletRequest);
    assert.equal(missingClaims.coverage.complete, false); assert.equal(missingClaims.claims.records.length, 0);
    assert(missingClaims.coverage.gaps.some(gap => gap.code === 'wallet_history_incomplete')); missingWalletHistory = false;
    const absentRequest = { ...walletRequest, body: beginCell().storeUint(0, 32).endCell() };
    const absentClaims = await collectT3WalletClaimEvidence(manifest, source, store, absentRequest);
    assert.equal(absentClaims.coverage.complete, false); assert.equal(absentClaims.claims.records.length, 0);
    assert(absentClaims.coverage.gaps.some(gap => gap.code === 'original_request_unobserved'));
    const wrongWallet = structuredClone(walletRequest.request); wrongWallet.wallet = hub;
    await assert.rejects(collectT3WalletClaimEvidence(manifest, source, store, readT3WalletClaimRequest(wrongWallet, manifest)));
    const aborted = new AbortController(); aborted.abort(); await assert.rejects(collectT3WalletClaimEvidence(manifest, source, store, walletRequest, aborted.signal));
    const burnTransaction = rows.find(row => row.evidence.account === walletRequest.request.wallet
      && verifyOrderTransaction(row.evidence).tx.lt.toString() === claims.claims.records[0].originLt)!.evidence;
    exported.push({ walletClaimRequest: walletRequest.request, walletClaimResponse: claims, burnTransaction });
    for (let index = 1; index < 32; index++) {
      let next: ReturnType<typeof readT3WalletClaimRequest>;
      try { next = readT3WalletClaimRequest(makeRequest('redeem', index).request, manifest); }
      catch (error) { if (String(error).includes('No original redeem request found')) break; throw error; }
      const result = await collectT3WalletClaimEvidence(manifest, source, store, next);
      assert.equal(result.coverage.complete, true, JSON.stringify(result.coverage));
      const origins = rows.filter(row => row.evidence.account === next.request.wallet && result.claims.records.some(record => record.originLt === verifyOrderTransaction(row.evidence).tx.lt.toString()));
      for (const record of result.claims.records)
        assert.equal(t3PathRoot(BigInt(record.id), orderCell(record.recordBoc), orderCell(record.proofBoc)).toString(16).padStart(64, '0'), result.claims.root);
      exported.push({ walletClaimRequest: next.request, walletClaimResponse: result, burnTransaction: origins.length === 1 ? origins[0].evidence : null });
      console.log('wallet-claim', index, result.claims.records.map(record => ({ id: record.id, failed: record.failed, cancelled: record.cancelled, attempt: record.attempt })), result.claims.failures.length);
    }
    missingHubHistory = true; const missing = await collectT3OperationEvidence(manifest, source, store, makeRequest('mint'));
    assert.equal(missing.coverage.complete, false); assert(missing.coverage.gaps.some(gap => gap.code === 'hub_history_incomplete')); assert.equal(missing.receipts.length, 0);
    missingHubHistory = false; corruptCurrent = true; await assert.rejects(collectT3OperationEvidence(manifest, source, store, makeRequest('mint')));
    if (process.argv[3]) {
      assert(isAbsolute(process.argv[3])); writeFileSync(process.argv[3], JSON.stringify({ schema: 'tonswap-t3-collector-test-v1',
        scope: 'Original case-01 native bytes; synthetic consensus/getter adapter and all-stablecoin reserve configuration. Selected operation graphs do not cross sandbox treasury top-ups; full physical histories across those top-ups are rejected. No live deployment or release qualification.',
        capture: root, originalPrefixBeforeLt: beforeLt ?? null, producerReceiptSha256: createHash('sha256').update(bytes('producer-receipt.json')).digest('hex'), cases: exported }, null, 2) + '\n', { flag: 'wx' });
    }
    console.log('Original native T3 mint/redeem collection, receipt-log correlation, immutable physical facts, current reads, sandbox balance-discontinuity and missing-history refusal passed.');
  } finally { Date.now = originalNow; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

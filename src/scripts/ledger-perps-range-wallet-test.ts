import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Address, Cell, Dictionary, beginCell, loadTransaction } from '@ton/core';
import { PGlite } from '@electric-sql/pglite';
import { qualifyPerpsRangeWallet } from '../ledger/perpsRangeWallet';
import { PerpsRangeService } from '../ledger/perpsRange';
import { readT3RecoveryWallet } from '../ledger/t3RecoveryState';
import { decodeOriginalTransaction } from '../data/transactionEvidence';
import { canonicalLedgerHash } from '../ledger/normalize';
import { PostgresLedgerStore, type LedgerSqlPool } from '../ledger/store';
import type { TonDataSource, AccountStateResponse, RawTransaction } from '../data/dataSource';
import { perpsWalletAddress } from '../ledger/perpsWire';
import { loadOpcodes } from '../utils/opcodes';
import { readCurrentJettonWalletStorage, writeCurrentJettonWalletStorage } from '../ledger/jettonWalletState';

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));
const hash = (boc: string) => Cell.fromBase64(boc).hash().toString('hex');
const boc = (cell: Cell) => cell.toBoc().toString('base64');

export async function testPerpsRangeWalletIdentity() {
  const historical = fixture('perps-range-wallet-testnet-20260914.json');
  for (const account of historical.accounts) {
    assert.equal(hash(account.codeBoc), account.codeHash);
    assert.equal(hash(account.dataBoc), account.dataHash);
    assert.throws(() => readT3RecoveryWallet(account.dataBoc), 'the immutable earlier testnet layout is unsupported');
  }
  const parallelCapture = fixture('perps-referral-current/perps-wallet-current-local.json');
  for (const account of parallelCapture.accounts) {
    assert.equal(hash(account.codeBoc), account.codeHash); assert.equal(hash(account.dataBoc), account.dataHash);
    const decoded = readT3RecoveryWallet(account.dataBoc);
    qualifyPerpsRangeWallet('localnet', account.address, decoded.owner, decoded.root, Cell.fromBase64(account.codeBoc), { balance: '0', accountState: account.state, ...account });
  }
  const folder = 'perps-range-funded-current';
  const provenance = fixture(`${folder}/provenance.json`);
  for (const artifact of provenance.artifacts) {
    const bytes = readFileSync(join(__dirname, 'fixtures', folder, artifact.relative));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
  }
  const open = fixture(`${folder}/open.json`), close = fixture(`${folder}/close.json`);
  const range = fixture(`${folder}/range.json`);
  for (const captured of [open, close, range]) {
    assert.equal(hash(captured.engineCode), provenance.engineCodeHash);
    assert.equal(hash(captured.poolCode), provenance.poolCodeHash);
  }
  const rvWallet = perpsWalletAddress(Cell.fromBase64(open.walletCode), open.root, open.riskVault);
  const codes = new Map([[open.engine, open.engineCode], [open.pool, open.poolCode],
    [open.riskVault, open.riskVaultCode], [open.riskController, open.riskControllerCode],
    [open.ownerWallet, open.walletCode], [open.engineWallet, open.walletCode], [rvWallet, open.walletCode]]);
  const rows: Array<{ account: string; raw: RawTransaction; transaction: string; oldStorage: string; newStorage: string }> = range.transactions.map((saved: any) => {
    const cell = Cell.fromBase64(saved.transaction), tx = loadTransaction(cell.beginParse());
    const account = `0:${tx.address.toString(16).padStart(64, '0')}`;
    return { ...saved, account, raw: decodeOriginalTransaction(cell, Address.parse(account)) as RawTransaction };
  }).sort((a: any, b: any) => BigInt(a.raw.lt) < BigInt(b.raw.lt) ? -1 : 1);
  assert(/^[1-9][0-9]*$/.test(range.rangeStartLt), 'explicit initial fixture boundary is required');
  const executed = rows.filter(row => BigInt(row.raw.lt) >= BigInt(range.rangeStartLt));
  assert(executed.length > 10);
  for (const row of executed) {
    const prior = executed.find(p => p.account === row.account && p.raw.lt === row.raw.prevTransactionLt);
    if (!prior) continue;
    const beforeTx = loadTransaction(Cell.fromBase64(prior.transaction).beginParse());
    const afterTx = loadTransaction(Cell.fromBase64(row.transaction).beginParse());
    assert(beforeTx.stateUpdate.newHash.equals(afterTx.stateUpdate.oldHash), 'uninterrupted original account-state commitments');
    assert.equal(hash(prior.newStorage), hash(row.oldStorage), 'no post-boundary storage injection');
  }
  const currentWallets = { wallets: [
    ['ownerWallet', open.ownerWallet, open.owner], ['engineWallet', open.engineWallet, open.engine], ['riskVaultWallet', rvWallet, open.riskVault],
  ].map(([role, address, owner]) => {
    const row = rows.filter((row: any) => row.account === address).at(-1)!;
    assert(row, `actual ${role} transaction exists`);
    return { role, address, owner, root: open.root, state: 'active', codeBoc: open.walletCode,
      codeHash: hash(open.walletCode), dataBoc: row.newStorage, dataHash: hash(row.newStorage) };
  }) };
  for (const account of currentWallets.wallets) {
    const data = readT3RecoveryWallet(account.dataBoc);
    assert.equal(data.owner, account.owner); assert.equal(data.root, account.root);
    const asset = qualifyPerpsRangeWallet('localnet', account.address, account.owner, account.root,
      Cell.fromBase64(account.codeBoc), { balance: '0', accountState: 'active', ...account });
    assert.deepEqual(asset, { kind: 'jetton', id: `localnet:jetton:${data.root}`, master: data.root,
      wallet: account.address, owner: data.owner });
    assert(!('decimals' in asset) && !('symbol' in asset), 'historical identity never guesses display precision');
  }
  let authenticWalletStates = 0;
  for (const row of rows.filter(row => [open.ownerWallet, open.engineWallet].includes(row.account))) {
    for (const dataBoc of [row.oldStorage, row.newStorage].filter(value => value && !Cell.fromBase64(value).equals(Cell.EMPTY))) {
      qualifyPerpsRangeWallet('localnet', row.account, row.account === open.ownerWallet ? open.owner : open.engine,
        open.root, Cell.fromBase64(open.walletCode), { accountState: 'active', balance: '0', codeBoc: open.walletCode, dataBoc });
      authenticWalletStates++;
    }
  }
  assert(authenticWalletStates >= rows.filter((row: any) => [open.ownerWallet, open.engineWallet].includes(row.account)).length);
  assert(authenticWalletStates >= 12, 'real OPEN/CLOSE transfer states, including noninitial journals');
  const current = currentWallets.wallets.find((account: any) => account.role === 'ownerWallet')!, decoded = readT3RecoveryWallet(current.dataBoc), code = Cell.fromBase64(current.codeBoc);
  const valid: AccountStateResponse = { balance: '0', accountState: 'active', codeBoc: current.codeBoc, dataBoc: current.dataBoc };
  const qualify = (state = valid, wallet = current.address, owner = decoded.owner, root = decoded.root) =>
    qualifyPerpsRangeWallet('localnet', wallet, owner, root, code, state);
  const rejects = (state: AccountStateResponse) => assert.throws(() => qualify(state), /perps_range_wallet_identity_unverified/);
  for (const state of ['uninitialized', 'frozen', null, undefined] as const) rejects({ ...valid, accountState: state });
  rejects({ ...valid, codeBoc: undefined }); rejects({ ...valid, dataBoc: undefined });
  rejects({ ...valid, codeBoc: boc(Cell.EMPTY) });
  assert.throws(() => qualify(valid, decoded.owner), /identity_unverified/);
  assert.throws(() => qualify(valid, current.address, decoded.root), /identity_unverified/);
  assert.throws(() => qualify(valid, current.address, decoded.owner, decoded.owner), /identity_unverified/);
  const data = Cell.fromBase64(current.dataBoc);
  const withRefs = (refs: Cell[]) => boc(refs.reduce((builder, ref) => builder.storeRef(ref), beginCell().storeBits(data.bits)).endCell());
  rejects({ ...valid, dataBoc: boc(beginCell().storeCoins(0).storeAddress(Address.parse(decoded.owner)).storeAddress(Address.parse(decoded.root)).endCell()) });
  rejects({ ...valid, dataBoc: boc(beginCell().storeSlice(data.beginParse()).storeBit(0).endCell()) });
  rejects({ ...valid, dataBoc: withRefs([data.refs[0]]) });
  if (data.refs.length < 4) rejects({ ...valid, dataBoc: withRefs([...data.refs, Cell.EMPTY]) });
  for (const index of [0, 1, 2]) {
    const refs = [...data.refs]; refs[index] = beginCell().storeSlice(refs[index].beginParse()).storeBit(0).endCell();
    rejects({ ...valid, dataBoc: withRefs(refs) });
    refs[index] = Cell.EMPTY; rejects({ ...valid, dataBoc: withRefs(refs) });
  }
  const walletStorage = readCurrentJettonWalletStorage(data);
  const invalidBurn = beginCell().storeUint(6, 8).storeUint(0, 64).storeCoins(0).storeUint(0, 256).storeAddress(null).endCell();
  rejects({ ...valid, dataBoc: boc(writeCurrentJettonWalletStorage({...walletStorage, burnJournal: invalidBurn})) });
  const invalidMint = beginCell().storeUint(1, 8).storeUint(0, 64).storeUint(0, 64).storeCoins(0).storeUint(0, 256).endCell();
  rejects({ ...valid, dataBoc: boc(writeCurrentJettonWalletStorage({...walletStorage, mintJournal: invalidMint})) });
  const receipts = Dictionary.loadDirect(Dictionary.Keys.BigUint(64), {serialize: () => {throw Error('read only');}, parse: slice => {
    const status = slice.loadUint(8), wireId = slice.loadUintBig(64), queryId = slice.loadUintBig(64), amount = slice.loadCoins(), requestHash = slice.loadUintBig(256);
    return {status, wireId, queryId, amount, requestHash};
  }}, walletStorage.mintReceipts);
  assert(receipts.size > 0, 'real mint produced a retained current mint receipt');
  const malformed = (journal: Cell) => boc(beginCell().storeBits(data.bits).storeRef(data.refs[0]).storeRef(data.refs[1]).storeRef(journal).endCell());
  rejects({...valid, dataBoc: malformed(beginCell().storeRef(walletStorage.burnJournal).storeRef(walletStorage.mintJournal).endCell())});
  rejects({...valid, dataBoc: malformed(beginCell().storeRef(walletStorage.burnJournal).storeRef(walletStorage.mintJournal).storeDict(null).endCell())});
  const receiptCodec = {serialize: (value: any, builder: any) => {builder.storeUint(value.status, 8).storeUint(value.wireId, 64)
    .storeUint(value.queryId, 64).storeCoins(value.amount).storeUint(value.requestHash, 256);}, parse: () => {throw Error('write only');}};
  const [receiptKey, originalReceipt] = [...receipts][0];
  for (const change of [{wireId: receiptKey + 1n}, {amount: 0n}, {status: 1}]) {
    const altered = Dictionary.empty(Dictionary.Keys.BigUint(64), receiptCodec).set(receiptKey, {...originalReceipt, ...change});
    const envelope = beginCell().storeDict(altered).endCell();
    rejects({...valid, dataBoc: boc(writeCurrentJettonWalletStorage({...walletStorage, mintReceipts: envelope.refs[0]}))});
  }
  // This retained wallet-only capture still has the exact current JettonWallet runtime; it is not Perps-engine evidence.
  const referral = fixture(`${folder}/current-wallets.json`).wallets.find((account: any) => account.role === 'referralWallet');
  assert.equal(hash(referral.codeBoc), hash(open.walletCode)); assert.equal(hash(referral.dataBoc), referral.dataHash);
  const referralData = readCurrentJettonWalletStorage(Cell.fromBase64(referral.dataBoc));
  const referralMintReceipts = Dictionary.loadDirect(Dictionary.Keys.BigUint(64), {serialize: () => {throw Error('read only');}, parse: slice => {
    const status = slice.loadUint(8), wireId = slice.loadUintBig(64), queryId = slice.loadUintBig(64), amount = slice.loadCoins(), requestHash = slice.loadUintBig(256);
    return {status, wireId, queryId, amount, requestHash};
  }}, referralData.mintReceipts);
  assert(referralMintReceipts.size > 0, 'current admin referral wallet retains its authentic prior mint receipt');
  assert(Dictionary.loadDirect(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell(), referralData.referralNotifications).size > 0,
    'real referral transfer populated the mandatory notification dictionary');
  // Keep the authentic wallet's derived account and code while substituting the stored owner/root.
  for (const swapOwner of [true, false]) {
    const altered = writeCurrentJettonWalletStorage({...walletStorage,
      owner: Address.parse(swapOwner ? decoded.root : decoded.owner),
      root: Address.parse(swapOwner ? decoded.root : decoded.owner)});
    rejects({ ...valid, dataBoc: boc(altered) });
  }

  // Both actual funded OPEN and plain CLOSE share one bounded range. Full
  // original peer history supplies lower witnesses; no hash link is reconstructed.
  const db = new PGlite();
  const pool: LedgerSqlPool = { query: async (q, p) => !p && q.includes(';') ? { rows: (await db.exec(q)).at(-1)?.rows ?? [] } : db.query(q, p),
    connect: async () => pool, end: () => db.close() };
  const store = new PostgresLedgerStore(pool);
  const head = (account: string) => rows.filter(row => row.account === account).at(-1)!;
  const from = Math.min(...rows.filter(row => open.transactions.some((r: any) => r.transaction === row.transaction)).map(row => row.raw.utime));
  const to = Math.max(...rows.map(row => row.raw.utime)) + 1;
  for (const row of rows) {
    const prior = rows.find(p => p.account === row.account && p.raw.lt === row.raw.prevTransactionLt);
    if (prior) assert.equal(canonicalLedgerHash(prior.raw.hash), canonicalLedgerHash(row.raw.prevTransactionHash!), 'retained original hash links');
  }
  const reads: Array<[string, number]> = []; let forbiddenReads = 0;
  const forbidden = async () => { forbiddenReads++; throw Error('latest-head getter/metadata unavailable'); };
  const source = { network: 'localnet', getMasterchainInfo: async () => ({ seqno: 1000, timestamp: to }),
    getAccountStateAtSeqno: async (account: string, seqno: number) => {
      reads.push([account, seqno]); assert.equal(seqno, 1000);
      const row = head(account); assert(row);
      return { accountState: 'active', balance: '0', codeBoc: codes.get(account) ?? open.walletCode,
        dataBoc: row.newStorage, lastTxLt: row.raw.lt, lastTxHash: row.raw.hash };
    }, getTransactions: async (account: string, limit: number, lt: string) => rows.filter(row => row.account === account && BigInt(row.raw.lt) <= BigInt(lt))
      .map(row => row.raw).reverse().slice(0, limit),
    getAccountState: forbidden, runGetMethod: forbidden, getJettonBalance: forbidden, getJettonMetadata: forbidden,
  } as unknown as TonDataSource;
  const service = new PerpsRangeService('localnet', store, source, loadOpcodes(),
    { t3Root: open.root, perpsEngine: open.engine, perpsEngineCodeHash: hash(open.engineCode) });
  try {
    await store.initialize();
    // Exact archive boundaries remain independent of current-head identity.
    for (const row of rows.filter((row: any) => codes.has(row.account))) {
      for (const [lt, txHash, dataBoc] of [[row.raw.prevTransactionLt, row.raw.prevTransactionHash, row.oldStorage], [row.raw.lt, row.raw.hash, row.newStorage]]) {
        await pool.query('INSERT INTO ledger_account_states(network,account,lt,hash,snapshot) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING',
          ['localnet', row.account, lt, canonicalLedgerHash(txHash!), JSON.stringify({ seqno: 999, state: { accountState: 'active', balance: '0', codeBoc: codes.get(row.account),
            dataBoc, lastTxLt: lt, lastTxHash: txHash } })]);
      }
    }
    const generation = randomUUID();
    await pool.query("INSERT INTO ledger_perps_ranges(generation,network,account,from_utime,to_utime,binding,status) VALUES($1,'localnet',$2,$3,$4,$5,'pending')",
      [generation, open.owner, from, to, (service as any).binding]);
    await service.collect(generation);
    const page = await service.page(open.owner, { scope: 'perps', fromUtime: from, toUtime: to });
    assert.equal(page.coverage.range?.status, 'complete');
    const opened = page.events.find(event => event.settlement?.perps?.request.operation === 'open');
    assert.equal(opened?.settlement?.perps?.outcome, 'accepted');
    assert.equal(opened?.settlement?.perps?.oracleExecution?.admission?.version, 'perps-funded-admission-v1');
    assert(opened?.settlement?.perps?.oracleExecution?.admission?.reservation);
    assert(opened?.settlement?.perps?.oracleExecution?.admission?.vaultResponse);
    assert(opened?.settlement?.perps?.oracleExecution?.admission?.policyRequest);
    assert(opened?.settlement?.perps?.oracleExecution?.admission?.policyResponse);
    const event = page.events.find(event => event.settlement?.perps?.request.operation === 'close');
    assert.equal(event?.settlement?.status, 'confirmed', JSON.stringify(page.coverage));
    assert.equal(event?.settlement?.perps?.outcome, 'accepted');
    assert.equal(event?.settlement?.perps?.payout.status, 'completed');
    assert.equal(event?.settlement?.perps?.counterpartyPayout.status, 'none');
    assert.equal(event?.settlement?.perps?.counterpartyPayout.amountRaw, '0');
    assert.equal(event?.settlement?.perps?.after?.position, null);
    assert.equal(forbiddenReads, 0, 'successful actual CLOSE range requires no latest-head identity, balance or display metadata');
    assert.deepEqual(new Set(reads.map(([a]) => a)), new Set([open.owner, open.ownerWallet, open.engine, open.engineWallet, open.pool, open.riskVault, open.riskController, rvWallet]));
    assert(reads.every(([, seqno]) => seqno === 1000));
    const capturedState = source.getAccountStateAtSeqno!;
    for (const failure of ['wrong-code', 'uninitialized', 'wrong-data-owner', 'wrong-rv-owner']) {
      source.getAccountStateAtSeqno = async (account, seqno) => {
        const state = await capturedState(account, seqno);
        if (account !== (failure === 'wrong-rv-owner' ? rvWallet : open.engineWallet)) return state;
        if (failure === 'wrong-code') return { ...state, codeBoc: boc(Cell.EMPTY) };
        if (failure === 'uninitialized') return { ...state, accountState: 'uninitialized' };
        return { ...state, dataBoc: head(open.ownerWallet).newStorage };
      };
      const denied = randomUUID();
      await pool.query("INSERT INTO ledger_perps_ranges(generation,network,account,from_utime,to_utime,binding,status) VALUES($1,'localnet',$2,$3,$4,$5,'pending')",
        [denied, open.owner, from, to, (service as any).binding]);
      await assert.rejects(service.collect(denied), /perps_range_wallet_identity_unverified/);
      const result = (await pool.query('SELECT status,error_code,snapshot FROM ledger_perps_ranges WHERE generation=$1', [denied])).rows[0];
      assert.deepEqual(result, { status: 'failed', error_code: 'perps_range_wallet_identity_unverified', snapshot: null });
    }
    source.getAccountStateAtSeqno = capturedState;
    const actualTransactions = source.getTransactions.bind(source);
    source.getTransactions = async (account, ...args) => account === rvWallet ? [] : actualTransactions(account, ...args);
    const missingPeer = randomUUID();
    await pool.query("INSERT INTO ledger_perps_ranges(generation,network,account,from_utime,to_utime,binding,status) VALUES($1,'localnet',$2,$3,$4,$5,'pending')",
      [missingPeer, open.owner, from, to, (service as any).binding]);
    await assert.rejects(service.collect(missingPeer), /perps_range_chain_unverified/);
    const incomplete = (await pool.query('SELECT status,error_code,snapshot FROM ledger_perps_ranges WHERE generation=$1', [missingPeer])).rows[0];
    assert.deepEqual(incomplete, { status: 'failed', error_code: 'perps_range_chain_unverified', snapshot: null });
    assert.equal(forbiddenReads, 0, 'bad captured identity also has no latest-head fallback');
  } finally { await service.stop(); await db.close(); }
  console.log(`PASS same-master wallet identity: 3 current-source wallets, 2 unchanged obsolete-layout rejections, ${authenticWalletStates} real Tolk states, strict rejection vectors, actual funded OPEN and normal CLOSE range with unavailable getters/metadata`);
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Address, beginCell, Cell, Dictionary } from '@ton/core';
import { activeOrderAccount } from '../orders/evidence';
import { verifyLaunchpadTransaction } from '../ledger/currentLaunchpadProof';
import { decodeLaunchChild } from '../ledger/currentLaunchpadState';
import { verifyLaunchpadArchiveClaim, verifyLaunchpadHolderClaim, verifyLaunchpadRecoveredOwed } from '../ledger/currentLaunchpadRecovery';
import { CurrentOwedArchiveTree } from '../runtime/launchpadOwedArchiveEvidence';
import { runtimeManifestFixture } from './fixtures/runtimeManifest';

const bytes = readFileSync(join(__dirname, 'fixtures/current-launchpad-native/recovery-accounting-originals.json.gz'));
assert.equal(createHash('sha256').update(bytes).digest('hex'), '749a7225ae042d352dd7660644528ca842d975a802d3ec2cd40757e0a246d29f');
const fixture = JSON.parse(gunzipSync(bytes).toString());
assert.equal(fixture.schema, 'tonswap-launchpad-recovery-accounting-originals-v1');
const manifest = runtimeManifestFixture();
let native = 0, negative = 0;
let template: ReturnType<typeof decodeLaunchChild> | undefined;
function changedFrontier(child: ReturnType<typeof decodeLaunchChild>) {
  const codec = { serialize(value: Cell, builder: ReturnType<typeof beginCell>) { builder.storeSlice(value.beginParse()); },
    parse(s: ReturnType<Cell['beginParse']>) { const value = beginCell().storeSlice(s).endCell(); s.skip(s.remainingBits); while (s.remainingRefs) s.loadRef(); return value; } };
  const books = Dictionary.loadDirect(Dictionary.Keys.Uint(8), codec, child.owed), book = books.get(0)!.beginParse();
  const total = book.loadCoins(), count = book.loadUint(16), entries = book.loadMaybeRef(), archiveCell = book.loadMaybeRef(); book.endParse(); assert(archiveCell); const archive = archiveCell.beginParse();
  const archiveCount = archive.loadUintBig(65), root = archive.loadUintBig(256), archiveTotal = archive.loadCoins(), frontier = archive.loadDict(Dictionary.Keys.Uint(8), Dictionary.Values.BigUint(256)); archive.endParse();
  frontier.set(0, (frontier.get(0) ?? 0n) ^ 1n);
  const changed = beginCell().storeUint(archiveCount, 65).storeUint(root, 256).storeCoins(archiveTotal).storeDict(frontier).endCell();
  books.set(0, beginCell().storeCoins(total).storeUint(count, 16).storeMaybeRef(entries).storeMaybeRef(changed).endCell());
  return { ...child, owed: beginCell().storeDictDirect(books).endCell() };
}
for (const sample of fixture.cases) {
  const tx = verifyLaunchpadTransaction(sample.evidence); assert(tx.succeeded);
  const before = decodeLaunchChild(activeOrderAccount(tx.before, manifest.templates.SaleFixed).data);
  const after = decodeLaunchChild(activeOrderAccount(tx.after, manifest.templates.SaleFixed).data);
  template ??= before;
  if (sample.kind === 'holder') {
    const result = verifyLaunchpadHolderClaim(tx, before, after);
    assert(BigInt(result.amountRaw) > 0n); assert.equal(result.slot, 0);
    assert.throws(() => verifyLaunchpadHolderClaim({ ...tx, succeeded: false }, before, after)); negative++;
    assert.throws(() => verifyLaunchpadHolderClaim(tx, before, before)); negative++;
    assert.throws(() => verifyLaunchpadHolderClaim(tx, before, { ...after, owed: before.owed })); negative++;
  } else {
    const body = tx.tx.inMessage!.body, result = verifyLaunchpadArchiveClaim(body, tx.account, before, after);
    assert(BigInt(result.amountRaw) > 0n); assert.equal(result.slot, 0);
    assert.throws(() => verifyLaunchpadArchiveClaim(body, tx.account, before, before)); negative++;
    assert.throws(() => verifyLaunchpadArchiveClaim(body, '0:' + 'f'.repeat(64), before, after)); negative++;
    const forgedFrontier = changedFrontier(after);
    assert.throws(() => verifyLaunchpadArchiveClaim(body, tx.account, before, forgedFrontier)); negative++;
    const s = body.beginParse(); s.skip(32); const query = s.loadUintBig(64), slot = s.loadUint(8), id = s.loadUintBig(64), owner = s.loadAddress(), amount = s.loadCoins();
    const wrong = beginCell().storeUint(0x434c4d41, 32).storeUint(query, 64).storeUint(slot, 8).storeUint(id, 64).storeAddress(owner).storeCoins(amount).storeRef(Cell.EMPTY).endCell();
    assert.throws(() => verifyLaunchpadArchiveClaim(wrong, tx.account, before, after)); negative++;
  }
  native++; console.log(sample.kind, sample.file.split('/').slice(-2).join('/'), 'original accounting verified');
}
assert.equal(native, 6); assert(template);

// These integer/state vectors exercise the exact cap1 reducer and its archive
// commitments. They are not original execution or physical money evidence.
const holder = '0:' + 'a'.repeat(64), beneficiary = Address.parse('0:' + 'b'.repeat(64)), amount = 13n;
const archive = (tree: CurrentOwedArchiveTree, patch: Partial<{ count: bigint; root: bigint; total: bigint; frontier: Map<number, bigint> }> = {}) => {
  const frontier = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.BigUint(256));
  for (const [level, value] of patch.frontier ?? tree.frontier) frontier.set(level, value);
  return beginCell().storeUint(patch.count ?? tree.count, 65).storeUint(patch.root ?? tree.root, 256).storeCoins(patch.total ?? tree.total).storeDict(frontier).endCell();
};
const child = (entries: Dictionary<Address, bigint>, archived: Cell | null, total: bigint) => {
  const book = beginCell().storeCoins(total).storeUint(entries.size, 16).storeDict(entries).storeMaybeRef(archived).endCell();
  const books = Dictionary.empty(Dictionary.Keys.Uint(8), { serialize(value: Cell, builder: ReturnType<typeof beginCell>) { builder.storeSlice(value.beginParse()); }, parse() { throw Error('write only'); } });
  books.set(0, book); return { ...template!, owed: beginCell().storeDictDirect(books).endCell() };
};
for (const count of [1, 1024]) {
  const entries = Dictionary.empty(Dictionary.Keys.Address(), Dictionary.Values.BigVarUint(4)); entries.set(beneficiary, 7n);
  for (let i = 1; i < count; i++) entries.set(Address.parse('0:' + i.toString(16).padStart(64, '0')), 1n);
  const total = BigInt(count + 6), before = child(entries, null, total), tree = new CurrentOwedArchiveTree(holder, 0);
  tree.append(0n, beneficiary.toRawString(), amount);
  const after = child(entries, archive(tree), total + amount);
  verifyLaunchpadRecoveredOwed(holder, 0, beneficiary.toRawString(), amount, before, after);
  // Same owner still archives once count reaches the current direct cap.
  const direct = Dictionary.empty(Dictionary.Keys.Address(), Dictionary.Values.BigVarUint(4)); for (const [owner, value] of entries) direct.set(owner, value); direct.set(beneficiary, 7n + amount);
  assert.throws(() => verifyLaunchpadRecoveredOwed(holder, 0, beneficiary.toRawString(), amount, before, child(direct, null, total + amount))); negative++;
  for (const patch of [{ count: 2n }, { root: tree.root ^ 1n }, { total: amount + 1n }, { frontier: new Map([[0, 1n]]) }]) {
    assert.throws(() => verifyLaunchpadRecoveredOwed(holder, 0, beneficiary.toRawString(), amount, before, child(entries, archive(tree, patch), total + amount))); negative++;
  }
  // After a consumed leaf, the updated frontier must survive a later append.
  tree.consume(0n, beneficiary.toRawString(), amount, tree.proof(0n));
  const consumed = child(entries, archive(tree), total);
  tree.append(1n, beneficiary.toRawString(), amount);
  verifyLaunchpadRecoveredOwed(holder, 0, beneficiary.toRawString(), amount, consumed, child(entries, archive(tree), total + amount));
}
console.log(`Current Launchpad recovery: ${native} original JRCM/CLMA accounting boundaries, cap1/full-book/consumed-prefix vectors and ${negative} negative claims passed; cash remains separate.`);

import { Address, beginCell, Cell, Dictionary, loadMessage, loadTransaction, storeShardAccount, type ShardAccount, type Slice } from '@ton/core';
import type { RuntimeReleaseManifest } from '../config/runtimeManifest';
import type { ChainSource } from '../data/dataSource';
import { assertFreshHeadTime } from '../data/freshHead';
import { createJettonWalletReader } from '../data/jettonWallet';
import { activeOrderAccount, orderCell, orderShard, verifyOrderTransaction, type OrderTransactionEvidence } from '../orders/evidence';
import { createPhysicalEvidenceReader, type PhysicalBoundary, type PhysicalEvidenceStore, type PhysicalGap } from './physicalEvidence';
import { launchAddress, readLaunchChild, readLaunchFactory, readLaunchSaleConfig, readLaunchpadProjectToken } from './launchpadEvidenceState';
import { orderHash } from '../orders/discovery';
import { archiveCheckpoint, readArchiveCheckpointHistory, type ArchiveBoundaryCheckpoint, type ArchiveCheckpointStore } from './archiveCheckpoint';
import { productAddress, productUint, ProductEvidenceError, requireProduct } from './productEvidence';

export const OWED_ARCHIVE_LIMITS = Object.freeze({ history: 10000, newTransactions: 64, records: 32, bytes: 8 * 1024 * 1024 });
export type CurrentLaunchpadOwedArchiveRequest = { network: string; releaseId: string; manifestHash: string; owner: string;
  factory: string; sale: string; target: string; creator: string; nonce: string; model: 0 | 1 | 2; slot: 0 | 1 };
export function readLaunchpadOwedArchiveRequest(value: unknown, manifest: RuntimeReleaseManifest): CurrentLaunchpadOwedArchiveRequest {
  try {
    requireProduct(value && typeof value === 'object' && !Array.isArray(value)); const v = value as Record<string, unknown>;
    requireProduct(Object.keys(v).sort().join() === ['network','releaseId','manifestHash','owner','factory','sale','target','creator','nonce','model','slot'].sort().join());
    if (v.network !== manifest.network.slice(4) || v.releaseId !== manifest.releaseId || v.manifestHash !== manifest.manifestHash
      || v.factory !== manifest.contracts.SaleFactory?.address) throw new ProductEvidenceError(409, 'release_mismatch');
    for (const key of ['owner','factory','sale','target','creator']) productAddress(v[key]); productUint(v.nonce, 64);
    requireProduct([0,1,2].includes(v.model as number) && [0,1].includes(v.slot as number) && v.target === v.sale);
    return structuredClone(v) as CurrentLaunchpadOwedArchiveRequest;
  } catch (error) { if (error instanceof ProductEvidenceError) throw error; throw new ProductEvidenceError(400, 'bad_request'); }
}
export type CurrentLaunchpadOwedArchiveEvidence = {
  schema: 'tonswap-launchpad-owed-archive-evidence-v1'; releaseId: string; manifestHash: string;
  asOf: { masterchainSeqno: number; unixTime: number; blockRootHash: string };
  request: Pick<CurrentLaunchpadOwedArchiveRequest, 'owner' | 'factory' | 'sale' | 'target' | 'creator' | 'nonce' | 'model' | 'slot'>;
  coverage: { complete: boolean; gaps: PhysicalGap[] };
  holder: { address: string; shardAccountBoc: string } | null;
  archive: { slot: number; count: string; root: string; total: string; records: Array<{
    id: string; owner: string; amountRaw: string; proofBoc: string; appendTransaction: OrderTransactionEvidence;
  }> } | null;
};
export class ArchiveReconstructionPending extends ProductEvidenceError {
  constructor(readonly traversed: number, readonly verified: number) { super(503, 'upstream_unavailable'); }
}
const unavailable = () => new ProductEvidenceError(503, 'upstream_unavailable');
function check(ok: unknown): asserts ok { if (!ok) throw unavailable(); }
const slice = (c: Cell) => { check(!c.isExotic); return c.beginParse(); };
const hex = (value: bigint) => value.toString(16).padStart(64, '0');
const hash = (cell: Cell) => BigInt('0x' + cell.hash().toString('hex'));
const pair = (a: bigint, b: bigint) => hash(beginCell().storeUint(3, 8).storeUint(a, 256).storeUint(b, 256).endCell());
export const owedArchiveLeaf = (holder: string, slot: number, id: bigint, owner: string, amount: bigint) =>
  hash(beginCell().storeUint(1, 8).storeAddress(Address.parse(holder)).storeUint(slot, 8).storeUint(id, 64).storeAddress(Address.parse(owner)).storeUint(amount, 120).endCell());
const consumedLeaf = (holder: string, slot: number, id: bigint) => hash(beginCell().storeUint(2, 8).storeAddress(Address.parse(holder)).storeUint(slot, 8).storeUint(id, 64).endCell());

/** Owed archives use inline domain1/2 leaves and domain3 pairs. T3 receipt
 * trees have different leaf encoding and cannot supply these witnesses. */
export class CurrentOwedArchiveTree {
  private levels = Array.from({ length: 65 }, () => new Map<bigint, bigint>());
  private zero = [hash(beginCell().storeUint(0, 8).endCell())];
  readonly frontier = new Map<number, bigint>();
  count = 0n; total = 0n;
  constructor(readonly holder: string, readonly slot: number) { for (let i = 0; i < 64; i++) this.zero.push(pair(this.zero[i], this.zero[i])); }
  get root() { return this.levels[64].get(0n) ?? this.zero[64]; }
  private set(id: bigint, leaf: bigint) {
    this.levels[0].set(id, leaf);
    for (let level = 0; level < 64; level++) {
      id >>= 1n;
      this.levels[level + 1].set(id, pair(this.levels[level].get(id << 1n) ?? this.zero[level], this.levels[level].get((id << 1n) | 1n) ?? this.zero[level]));
    }
  }
  append(id: bigint, owner: string, amount: bigint) {
    check(id === this.count && this.count < 1n << 64n && amount > 0n && this.total + amount < 1n << 120n);
    const leaf = owedArchiveLeaf(this.holder, this.slot, id, owner, amount); let cursor = id, node = leaf, stored = false;
    for (let level = 0; level < 64; level++, cursor >>= 1n) {
      if (!(cursor & 1n)) { if (!stored) { this.frontier.set(level, node); stored = true; } node = pair(node, this.zero[level]); }
      else { const prefix = this.frontier.get(level); check(prefix !== undefined); node = pair(prefix, node); }
    }
    this.set(id, leaf); check(node === this.root); this.count++; this.total += amount;
  }
  consume(id: bigint, owner: string, amount: bigint, proof: Cell) {
    check(id < this.count && amount > 0n && amount <= this.total);
    let old = owedArchiveLeaf(this.holder, this.slot, id, owner, amount), next = consumedLeaf(this.holder, this.slot, id), cursor = id, step: Cell | null = proof;
    let difference = id ^ this.count, frontierLevel = -1; while (difference) { frontierLevel++; difference >>= 1n; }
    const frontier = new Map(this.frontier);
    for (let level = 0; level < 64; level++, cursor >>= 1n) {
      check(step); const s = slice(step); check(s.remainingBits === 257); const sibling = s.loadUintBig(256); step = s.loadMaybeRef(); s.endParse();
      check((step === null) === (level === 63)); if (level === frontierLevel) frontier.set(level, next);
      old = cursor & 1n ? pair(sibling, old) : pair(old, sibling); next = cursor & 1n ? pair(sibling, next) : pair(next, sibling);
    }
    check(old === this.root); this.set(id, consumedLeaf(this.holder, this.slot, id)); check(next === this.root);
    this.frontier.clear(); for (const [level, value] of frontier) this.frontier.set(level, value); this.total -= amount;
  }
  proof(id: bigint) {
    check(id >= 0n && id < this.count); const siblings: bigint[] = [];
    for (let level = 0; level < 64; level++, id >>= 1n) siblings.push(this.levels[level].get(id ^ 1n) ?? this.zero[level]);
    let proof: Cell | null = null; for (let level = 63; level >= 0; level--) proof = beginCell().storeUint(siblings[level], 256).storeMaybeRef(proof).endCell(); return proof!;
  }
}
export type ArchiveState = { count: bigint; root: bigint; total: bigint; frontier: Map<number, bigint> };
function archiveCell(c: Cell): ArchiveState {
  const s = slice(c), count = s.loadUintBig(65), root = s.loadUintBig(256), total = s.loadCoins();
  const frontier = s.loadDict(Dictionary.Keys.Uint(8), Dictionary.Values.BigUint(256)); s.endParse();
  check(count > 0n && count <= 1n << 64n && [...frontier.keys()].every(level => level < 64)); return { count, root, total, frontier: new Map(frontier) };
}
function archivedState(data: Cell, slot: number, empty: ArchiveState): ArchiveState {
  const s = slice(data); s.loadRef(); s.loadMaybeRef(); const managed = slice(s.loadRef()); s.loadRef(); s.endParse();
  managed.loadMaybeRef();
  const books = managed.loadDict(Dictionary.Keys.Uint(8), { serialize() { throw unavailable(); }, parse(q: Slice) {
    const total = q.loadCoins(), count = q.loadUint(16), entries = q.loadMaybeRef();
    const archive = q.loadMaybeRef(); q.endParse(); const current = archive ? archiveCell(archive) : empty;
    // The authenticated native state commits the live dictionary. Archive
    // reconstruction does not project those unrelated live owners or totals.
    // Avoid expanding up to 1024 entries at every historical boundary.
    check(count<=1024&&(entries===null)===(count===0)&&total>=current.total&&(count!==0||total===current.total));return current;
  } });
  managed.loadMaybeRef(); managed.endParse(); return books.get(slot) ?? empty;
}
function sameArchive(actual: ArchiveState, tree: CurrentOwedArchiveTree) {
  check(actual.count === tree.count && actual.root === tree.root && actual.total === tree.total && actual.frontier.size === tree.frontier.size
    && [...actual.frontier].every(([level, value]) => tree.frontier.get(level) === value));
}
type ArchiveReadContext = { identity: ArchiveIdentity; readState?: never } | { identity?: never; readState(shard: ShardAccount, empty: ArchiveState, allowUninitialized: boolean): ArchiveState };
type ArchiveIdentity = ReturnType<typeof readLaunchChild>['id'];
type StoredArchiveState = { count: string; root: string; total: string; frontier: [number, string][] };
type ArchiveEvent = { kind: 'append' | 'consume'; id: string; owner: string; amount: string; proof?: string };
type ArchiveFacts = { before: StoredArchiveState; after: StoredArchiveState; events: ArchiveEvent[] };
const storedArchive = (state: ArchiveState): StoredArchiveState => ({ count: String(state.count), root: hex(state.root), total: String(state.total),
  frontier: [...state.frontier].sort(([a], [b]) => a - b).map(([level, value]) => [level, hex(value)]) });
function decodedArchive(value: StoredArchiveState): ArchiveState {
  check(value && /^(0|[1-9][0-9]*)$/.test(value.count) && /^(0|[1-9][0-9]*)$/.test(value.total)
    && /^[0-9a-f]{64}$/.test(value.root) && Array.isArray(value.frontier) && value.frontier.length <= 64);
  const count = BigInt(value.count), total = BigInt(value.total), frontier = new Map<number, bigint>();
  check(count <= 1n << 64n && total < 1n << 120n);
  for (const [level, hash] of value.frontier) { check(Number.isInteger(level) && level >= 0 && level < 64 && !frontier.has(level) && /^[0-9a-f]{64}$/.test(hash)); frontier.set(level, BigInt('0x' + hash)); }
  return { count, root: BigInt('0x' + value.root), total, frontier };
}
function saleArchiveState(shard: ShardAccount, input: { codeHash: string; identity: ArchiveIdentity; slot: number }, empty: ArchiveState, allowUninitialized: boolean) {
  if (shard.account?.storage.state.type !== 'active') { check(allowUninitialized && shard.lastTransactionLt === 0n && shard.lastTransactionHash === 0n); return empty; }
  const data = activeOrderAccount(shard, input.codeHash).data, child = readLaunchChild(data);
  check(Object.entries(input.identity).every(([key, value]) => child.id[key as keyof typeof child.id] === value));
  return archivedState(data, input.slot, empty);
}
function readArchiveState(shard: ShardAccount, input: {codeHash:string;slot:number} & ArchiveReadContext, empty: ArchiveState, allowUninitialized:boolean) {
  return input.readState ? input.readState(shard,empty,allowUninitialized) : saleArchiveState(shard,{...input,identity:input.identity!},empty,allowUninitialized);
}
export function summarizeArchiveBoundary(row: PhysicalBoundary, input: { scope: string; holder: string; slot: number; codeHash: string } & ArchiveReadContext): ArchiveBoundaryCheckpoint {
  const t = verifyOrderTransaction(row.evidence); check(row.evidence.account === input.holder);
  const emptyTree = new CurrentOwedArchiveTree(input.holder, input.slot), empty = { count: 0n, root: emptyTree.root, total: 0n, frontier: new Map<number, bigint>() };
  const facts: ArchiveFacts = { before: storedArchive(readArchiveState(t.before, input, empty, t.tx.prevTransactionLt === 0n)),
    after: storedArchive(readArchiveState(t.after, input, empty, false)), events: [] };
  if (t.succeeded) {
    const incoming = t.tx.inMessage;
    if (incoming?.info.type === 'internal' && !incoming.info.bounced && incoming.body.bits.length >= 32 && slice(incoming.body).preloadUint(32) === 0x434c4d41) {
      const body = slice(incoming.body); body.loadUint(32); body.loadUintBig(64); const slot = body.loadUint(8), id = body.loadUintBig(64), owner = body.loadAddress().toRawString(), amount = body.loadCoins(), proof = body.loadRef(); body.endParse();
      if (slot === input.slot) facts.events.push({ kind: 'consume', id: String(id), owner, amount: String(amount), proof: proof.toBoc().toString('base64') });
    }
    for (const raw of t.outgoing.values()) {
      const m = loadMessage(slice(raw)); if (m.info.type !== 'external-out' || m.body.bits.length < 32 || slice(m.body).preloadUint(32) !== 0x4a415243) continue;
      const body = slice(m.body); body.loadUint(32); const slot = body.loadUint(8), id = body.loadUintBig(64), owner = body.loadAddress().toRawString(), amount = body.loadCoins(); body.endParse();
      if (slot !== input.slot) continue; check(m.info.src.toRawString() === input.holder && Address.parse(owner).workChain === 0);
      facts.events.push({ kind: 'append', id: String(id), owner, amount: String(amount) });
    }
  }
  return archiveCheckpoint({ scope: input.scope, account: input.holder, lt: String(t.tx.lt), hash: t.hash,
    previousLt: String(t.tx.prevTransactionLt), previousHash: hex(t.tx.prevTransactionHash),
    before: orderCell(row.evidence.beforeShardAccountBoc).hash().toString('hex'), after: orderCell(row.evidence.afterShardAccountBoc).hash().toString('hex'),
    seqno: row.seqno, unixTime: t.tx.now, payload: facts });
}
export async function replayArchiveFacts(input: { rows: readonly ArchiveBoundaryCheckpoint[]; holder: string; owner: string; slot: number; codeHash: string;
  current: ShardAccount; signal?: AbortSignal; evidence(row: ArchiveBoundaryCheckpoint): Promise<OrderTransactionEvidence> } & ArchiveReadContext) {
  check(input.rows.length > 0 && input.rows.length <= OWED_ARCHIVE_LIMITS.history);
  const tree = new CurrentOwedArchiveTree(input.holder, input.slot), empty = { count: 0n, root: tree.root, total: 0n, frontier: new Map<number, bigint>() };
  const records = new Map<bigint, { owner: string; amount: bigint; append: ArchiveBoundaryCheckpoint; consumed: boolean }>();
  let previous: ArchiveBoundaryCheckpoint | undefined;
  for (const [i, row] of [...input.rows].reverse().entries()) {
    input.signal?.throwIfAborted(); if (i % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    check(row.account === input.holder && (previous ? row.previousLt === previous.lt && row.previousHash === previous.hash && row.before === previous.after : row.previousLt === '0' && row.previousHash === '0'.repeat(64)));
    const facts = row.payload as ArchiveFacts; check(facts && Array.isArray(facts.events)); sameArchive(decodedArchive(facts.before), tree);
    for (const event of facts.events) {
      check(event && /^(0|[1-9][0-9]*)$/.test(event.id) && /^[1-9][0-9]*$/.test(event.amount) && /^0:[0-9a-f]{64}$/.test(event.owner));
      const id = BigInt(event.id), amount = BigInt(event.amount); check(id < 1n << 64n && amount < 1n << 120n);
      if (event.kind === 'consume') {
        const record = records.get(id); check(record && !record.consumed && record.owner === event.owner && record.amount === amount && typeof event.proof === 'string');
        tree.consume(id, event.owner, amount, orderCell(event.proof)); record.consumed = true;
      } else {
        check(event.kind === 'append' && !event.proof && !records.has(id) && records.size < OWED_ARCHIVE_LIMITS.history);
        tree.append(id, event.owner, amount); records.set(id, { owner: event.owner, amount, append: row, consumed: false });
      }
    }
    sameArchive(decodedArchive(facts.after), tree); previous = row;
  }
  check(previous!.after === beginCell().store(storeShardAccount(input.current)).endCell().hash().toString('hex'));
  sameArchive(readArchiveState(input.current, input, empty, false), tree);
  const selected = [...records].filter(([, record]) => !record.consumed && record.owner === input.owner), result = [];
  for (const [id, record] of selected.slice(0, OWED_ARCHIVE_LIMITS.records)) {
    input.signal?.throwIfAborted(); const appendTransaction = await input.evidence(record.append);
    // A stored summary never substitutes for the original proof returned to clients.
    check(orderHash(summarizeArchiveBoundary({ evidence: appendTransaction, seqno: record.append.seqno }, { ...input, scope: record.append.scope })) === orderHash(record.append));
    result.push({ id: String(id), owner: record.owner, amountRaw: String(record.amount), proofBoc: tree.proof(id).toBoc().toString('base64'), appendTransaction });
  }
  return { tree, candidateCount: selected.length, records: result };
}
export async function reconstructLaunchpadOwedArchive(input: { rows: readonly PhysicalBoundary[]; holder: string; owner: string; slot: number; codeHash: string;
  current: ShardAccount; identity: ArchiveIdentity; signal?: AbortSignal }) {
  const evidence = new Map<string, OrderTransactionEvidence>(), rows: ArchiveBoundaryCheckpoint[] = [];
  for (const row of input.rows) {
    input.signal?.throwIfAborted(); if (rows.length % 16 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    const summary = summarizeArchiveBoundary(row, { ...input, scope: '0'.repeat(64) }); rows.push(summary); evidence.set(summary.hash, row.evidence);
  }
  rows.sort((a, b) => BigInt(a.lt) > BigInt(b.lt) ? -1 : 1);
  return replayArchiveFacts({ ...input, rows, evidence: async row => evidence.get(row.hash)! });
}

export async function collectLaunchpadOwedArchiveEvidence(manifest: RuntimeReleaseManifest, source: ChainSource, store: PhysicalEvidenceStore & ArchiveCheckpointStore,
  request: CurrentLaunchpadOwedArchiveRequest, signal?: AbortSignal): Promise<CurrentLaunchpadOwedArchiveEvidence> {
  signal?.throwIfAborted(); check(`ton:${source.network}` === manifest.network); const head = await source.head({ signal }); assertFreshHeadTime(head.utime);
  const { network: _network, releaseId: _releaseId, manifestHash: _hash, ...identity } = request;
  const response: CurrentLaunchpadOwedArchiveEvidence = { schema: 'tonswap-launchpad-owed-archive-evidence-v1', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
    asOf: { masterchainSeqno: head.seqno, unixTime: head.utime, blockRootHash: head.rootHashHex }, request: identity, coverage: { complete: false, gaps: [] }, holder: null, archive: null };
  const reader = createPhysicalEvidenceReader(source, store, head, { signal, newTransactions: OWED_ARCHIVE_LIMITS.newTransactions });
  try {
    const factoryState = await reader.current(request.factory), factory = readLaunchFactory(activeOrderAccount(orderShard(factoryState.shardAccountBoc!, request.factory).shard, manifest.contracts.SaleFactory!.codeHash).data, manifest);
    const id = { factory: request.factory, creator: request.creator, nonce: BigInt(request.nonce), model: request.model, role: 0 };
    requireProduct(request.sale === launchAddress(id, factory.codes.get(request.model)!));
    const current = await reader.current(request.sale), shard = orderShard(current.shardAccountBoc!, request.sale).shard;
    const child = readLaunchChild(activeOrderAccount(shard, factory.pins[request.model]).data); check(child.config);
    check(Object.entries(id).every(([key, value]) => child.id[key as keyof typeof child.id] === value));
    const config = readLaunchSaleConfig(child.config), lp = launchAddress({ ...id, role: 1 }, factory.codes.get(3)!), vesting = launchAddress({ ...id, role: 2 }, factory.codes.get(4)!);
    check(config.fee === manifest.contracts.FeeRouter?.address && config.lp === lp && config.vesting === (config.terms.vesting ? vesting : null));
    const project = await readLaunchpadProjectToken(manifest, source, config.terms.project, head, signal), t3 = manifest.tokens.find(t => t.symbol === 'T3');
    check(t3 && t3.root === manifest.contracts.T3Hub?.address && project.decimals === config.terms.decimals && child.slots.size === 2);
    const tokens = [t3, project]; check(tokens.every((token, slot) => child.slots.get(slot)?.master === token.root));
    const token = tokens[request.slot], slot = child.slots.get(request.slot); check(slot?.wallet);
    const wallet = await createJettonWalletReader({ source, tokens: [{ master: token.root, masterCodeHash: token.masterCodeHash, walletCodeHash: token.walletCodeHash }] }).identity(token.root, request.sale, { at: head, signal }); check(wallet.wallet === slot.wallet);
    response.holder = { address: request.sale, shardAccountBoc: current.shardAccountBoc! };
    const scope = orderHash({ schema: 'tonswap-sale-archive-boundary-v1', releaseId: manifest.releaseId, manifestHash: manifest.manifestHash,
      holder: request.sale, slot: request.slot, codeHash: factory.pins[request.model], identity: { ...id, nonce: String(id.nonce) } });
    const history = await readArchiveCheckpointHistory({ scope, account: request.sale, store, signal, historyLimit: OWED_ARCHIVE_LIMITS.history,
      current: { lt: String(shard.lastTransactionLt), hash: hex(shard.lastTransactionHash), shardHash: orderCell(current.shardAccountBoc!).hash().toString('hex'), seqno: head.seqno, unixTime: head.utime },
      verify: async (lt, hash) => summarizeArchiveBoundary(await reader.exact(request.sale, lt, hash), { scope, holder: request.sale, slot: request.slot, codeHash: factory.pins[request.model], identity: id }) });
    if (!history.complete) throw new ArchiveReconstructionPending(history.rows.length, history.verified);
    {
      const result = await replayArchiveFacts({ rows: history.rows, holder: request.sale, owner: request.owner, slot: request.slot, codeHash: factory.pins[request.model], current: shard, identity: id, signal,
        evidence: async row => (await reader.exact(request.sale, row.lt, row.hash)).evidence });
      const getter = await source.runGetMethod(request.sale, 'get_owed_archive', [{ type: 'int', value: BigInt(request.slot) }], { at: head, signal });
      const expected = [result.tree.count, result.tree.root, result.tree.total]; check([0,1].includes(getter.exitCode) && getter.stack.length === 3 && getter.stack.every((item, i) => item.type === 'int' && item.value === expected[i]));
      if (result.candidateCount > OWED_ARCHIVE_LIMITS.records) response.coverage.gaps.push({ code: 'owed_archive_candidate_limit', account: request.sale });
      else response.archive = { slot: request.slot, count: result.tree.count.toString(), root: hex(result.tree.root), total: result.tree.total.toString(), records: result.records };
    }
  } catch (error) { if (signal?.aborted || error instanceof ArchiveReconstructionPending) throw error; if (error instanceof ProductEvidenceError && error.status === 400) throw error; response.coverage.gaps.push({ code: 'owed_archive_evidence_unavailable', account: request.sale }); }
  if (Buffer.byteLength(JSON.stringify(response)) > OWED_ARCHIVE_LIMITS.bytes) { response.archive = null; response.holder = null; response.coverage.gaps.push({ code: 'response_size_limit', account: request.sale }); }
  response.coverage.complete = response.coverage.gaps.length === 0; signal?.throwIfAborted(); assertFreshHeadTime(head.utime); return response;
}

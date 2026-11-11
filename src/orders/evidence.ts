import { Address, Cell, Dictionary, loadAccount, loadShardAccount, loadTransaction } from '@ton/core';
import { decodeOriginalTransaction } from '../data/transactionEvidence';

export const digest = (cell: Cell): string => cell.hash().toString('hex');
export function requireOrder(ok: unknown, message: string): asserts ok {
  if (!ok) throw Error(`Order evidence: ${message}`);
}
export function orderCell(boc: string): Cell {
  requireOrder(typeof boc === 'string' && boc.length <= 16 * 1024 * 1024, 'invalid BOC size');
  const bytes = Buffer.from(boc, 'base64');
  requireOrder(bytes.toString('base64') === boc, 'noncanonical BOC');
  const cells = Cell.fromBoc(bytes);
  requireOrder(cells.length === 1 && !cells[0].isExotic, 'ordinary single-root BOC required');
  return cells[0];
}
export function orderShard(boc: string, address: string) {
  const cell = orderCell(boc), slice = cell.beginParse(), shard = loadShardAccount(slice);
  slice.endParse();
  requireOrder(cell.refs.length === 1 && !cell.refs[0].isExotic, 'invalid ShardAccount graph');
  const accountSlice = cell.refs[0].beginParse();
  if (accountSlice.loadBit()) loadAccount(accountSlice);
  accountSlice.endParse();
  requireOrder(!shard.account || shard.account.addr.equals(Address.parse(address)), 'account address mismatch');
  return { cell, shard, accountHash: digest(cell.refs[0]) };
}

/** These original cells must come from the authenticated chain/archive adapter.
 * Hash correspondence is checked here; this module does not establish consensus. */
export type OrderTransactionEvidence = {
  account: string; transactionBoc: string; beforeShardAccountBoc: string; afterShardAccountBoc: string;
};
export function verifyOrderTransaction(e: OrderTransactionEvidence) {
  const address = Address.parse(e.account), cell = orderCell(e.transactionBoc);
  requireOrder(address.workChain === 0 && address.toRawString() === e.account, 'canonical basechain account required');
  decodeOriginalTransaction(cell, address);
  const slice = cell.beginParse(), tx = loadTransaction(slice); slice.endParse();
  const before = orderShard(e.beforeShardAccountBoc, e.account), after = orderShard(e.afterShardAccountBoc, e.account);
  requireOrder(before.accountHash === tx.stateUpdate.oldHash.toString('hex') && after.accountHash === tx.stateUpdate.newHash.toString('hex'), 'transaction state commitment mismatch');
  requireOrder(before.shard.lastTransactionLt === tx.prevTransactionLt && before.shard.lastTransactionHash === tx.prevTransactionHash, 'before predecessor mismatch');
  requireOrder(after.shard.lastTransactionLt === tx.lt && after.shard.lastTransactionHash === BigInt('0x' + digest(cell)), 'after transaction identity mismatch');
  const raw = cell.beginParse(); raw.skip(4 + 256 + 64 + 256 + 64 + 32 + 15 + 2 + 2);
  const messages = raw.loadRef().beginParse(), incoming = messages.loadMaybeRef();
  const outgoing = messages.loadDict(Dictionary.Keys.Uint(15), Dictionary.Values.Cell()); messages.endParse();
  requireOrder(outgoing.size === tx.outMessagesCount, 'outgoing message count mismatch');
  const description = tx.description;
  const succeeded = description.type === 'generic' && !description.aborted && !description.destroyed
    && description.computePhase.type === 'vm' && description.computePhase.success
    && [0, 1].includes(description.computePhase.exitCode)
    && !!description.actionPhase && description.actionPhase.valid && description.actionPhase.success
    && description.actionPhase.resultCode === 0;
  return { tx, hash: digest(cell), before: before.shard, after: after.shard, incoming, outgoing, succeeded };
}

export function activeOrderAccount(shard: ReturnType<typeof orderShard>['shard'], codeHash: string) {
  requireOrder(shard.account?.storage.state.type === 'active', 'active account required');
  const state = shard.account.storage.state.state;
  requireOrder(state.code && state.data && digest(state.code) === codeHash, 'current code pin mismatch');
  requireOrder(state.splitDepth === undefined && state.special === undefined && (!state.libraries || state.libraries.size === 0), 'unexpected account profile');
  return { code: state.code, data: state.data };
}

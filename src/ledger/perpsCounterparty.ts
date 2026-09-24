import { Address, beginCell, Cell, Dictionary } from '@ton/core';
import type { Flow, Node, ProjectionInput } from './project';
import { chainCoversTransaction } from './project';
import type { LedgerEvidenceRef } from './types';
import type { LedgerPerpsEngine } from './perps';
import type { PerpsBoundary } from './perpsOracle';
import { perpsRiskAction } from './perpsState';
import { perpsPositionKey, perpsWalletAddress, perpsControl } from './perpsWire';
import { businessBodyCell, messageKey, tokenWire, SETTLEMENT_INTERNAL, TRANSFER } from './wire';
import { canonicalLedgerHash } from './normalize';
import { decodeNativeFundingContext } from './nativeFunding';
export type PerpsCounterpartyPaymentProof = {
  version: 'perps-counterparty-payment-v1'; vault: string; vaultCodeHash: string; rvWallet: string;
  beneficiaryOwner: string; beneficiaryWallet: string; payoutWireQueryId: string;
  actionId: string; bucketId: number; positionId: string; priorActionId: string; priorRequestHash: string;
  requestHash: string; amountRaw: string; reservation: LedgerEvidenceRef; dispatch: LedgerEvidenceRef;
  delivery: LedgerEvidenceRef; walletFinality: LedgerEvidenceRef; hook: LedgerEvidenceRef;
};
export type PerpsCounterpartyPayout = { status: 'none' | 'pending' | 'completed'; amountRaw: string;
  evidence: LedgerEvidenceRef[]; proof?: PerpsCounterpartyPaymentProof };
const ref = (n: Node): LedgerEvidenceRef => ({ account: n.account, lt: n.raw.lt, hash: canonicalLedgerHash(n.raw.hash), utime: n.raw.utime });
const addr = (x?: string) => { try { return x ? Address.parse(x).toRawString() : null; } catch { return null; } };
const ok = (n: Node) => n.raw.success && (!n.raw.status || n.raw.status === 'success') && !n.raw.inMessage?.bounced;
const end = (s: ReturnType<Cell['beginParse']>) => { if (s.remainingBits || s.remainingRefs) throw Error('Noncanonical RiskVault payout data'); };
export function readRiskVaultPayoutJournal(data: Cell, bucket: number, action: string, expectedRoot: string, walletCodeHash: string) {
  if (data.bits.length || data.refs.length !== 4) throw Error('Unsupported RiskVault root');
  const config = data.refs[1]; if (config.bits.length || config.refs.length !== 4) throw Error('Unsupported RiskVault config');
  const token = config.refs[3].beginParse();
  if (token.loadAddress().toRawString() !== expectedRoot || token.loadRef().hash().toString('hex') !== walletCodeHash) throw Error('Foreign RiskVault wallet identity');
  end(token);
  const tail = data.refs[3]; if (tail.bits.length !== 336 || tail.refs.length !== 4) throw Error('Unsupported RiskVault tail');
  const version = tail.beginParse(); version.skip(320); if (version.loadUint(16) !== 3) throw Error('Unsupported RiskVault version');
  const ds = tail.refs[2].beginParse(), entries = ds.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
  const queue = ds.loadRef().beginParse(); end(ds);
  const head = queue.loadUintBig(64), endIndex = queue.loadUintBig(64);
  const ready = queue.loadDict(Dictionary.Keys.BigUint(64), Dictionary.Values.BigUint(256)); end(queue);
  if (head > endIndex || BigInt(ready.size) !== endIndex - head) throw Error('Noncanonical RiskVault ready FIFO');
  for (const [index, entryKey] of ready) {
    const target = entries.get(entryKey);
    if (index < head || index >= endIndex || !target || target.bits.length < 352 ||
        target.beginParse().skip(344).loadUint(8) !== 1) throw Error('Unbound RiskVault ready FIFO entry');
  }
  const key = BigInt(`0x${beginCell().storeUint(0x52564f55, 32).storeUint(2, 8).storeUint(bucket, 16).storeUint(BigInt(action), 64).endCell().hash().toString('hex')}`);
  const cell = entries.get(key); if (!cell) return null;
  const s = cell.beginParse(); if (s.loadUint(8) !== 2 || s.loadUint(16) !== bucket || s.loadUintBig(64).toString() !== action) throw Error('Wrong RiskVault payout key');
  const requestHash = s.loadUintBig(256).toString(16).padStart(64, '0'), status = s.loadUint(8), requested = s.loadCoins().toString(), amount = s.loadCoins().toString(), wire = s.loadUintBig(64).toString();
  s.loadIntBig(64);
  const native = s.loadRef().beginParse(), managed = native.loadBoolean();
  const nativeAmounts = [native.loadCoins(), native.loadCoins(), native.loadCoins()];
  const nativeOwners = nativeAmounts.map(amount => {
    const owner = native.loadRef();
    if (amount === 0n) { if (owner.bits.length || owner.refs.length) throw Error('Unexpected RiskVault native owner'); return null; }
    return decodeNativeFundingContext(owner);
  });
  end(native);
  const route = s.loadRef().beginParse(); end(s);
  const requester = route.loadMaybeAddress()?.toRawString() ?? null, recipient = route.loadMaybeAddress()?.toRawString() ?? null,
    destination = route.loadMaybeAddress()?.toRawString() ?? null, metadata = route.loadRef(); end(route);
  return { requestHash, status, requested, amount, wire, requester, recipient, destination, metadata,
    native: { managed, amounts: nativeAmounts.map(String), owners: nativeOwners } };
}
/** A canonical RVPS journal is a pending claim. Only an actual typed wallet
 * credit, finality and authenticated engine hook prove the distinct LP payment. */
export async function provePerpsCounterpartyPayment(args: {
  input: ProjectionInput; engine: LedgerPerpsEngine; execution: Node; states: PerpsBoundary;
  nodes: Node[]; flows: Flow[]; marketId: number; claim: { actionId: string; requestHash: string; beneficiary: string; amountRaw: string };
  receiptFor: (node: Node, index: number) => Node | null; boundary: (node: Node) => Promise<PerpsBoundary | null>;
}): Promise<{ payout: PerpsCounterpartyPayout; nodes: Node[]; flow?: Flow }> {
  const { input, engine, execution, states, claim, receiptFor } = args;
  const pending = { payout: { status: 'pending', amountRaw: claim.amountRaw, evidence: [] } as PerpsCounterpartyPayout, nodes: [] as Node[] };
  try {
    const vault = states.after.riskVault, positionId = perpsPositionKey(input.owner, args.marketId);
    if (!vault || claim.beneficiary !== input.owner || BigInt(claim.amountRaw) <= 0n) return pending;
    const action = perpsRiskAction(states.after, 1, positionId), body = action?.requestBody;
    if (!action || action.actionId !== claim.actionId || action.requestHash !== claim.requestHash || !body) return pending;
    const s = body.beginParse(); if (s.loadUint(32) !== 0x52565053 || s.loadUintBig(64).toString() !== claim.actionId) return pending;
    const bucket = s.loadUint(16); if (bucket !== states.after.riskVaultBucketId || s.loadUintBig(256).toString(16).padStart(64, '0') !== positionId) return pending;
    const priorActionId = s.loadUintBig(64).toString(), priorRequestHash = s.loadUintBig(256).toString(16).padStart(64, '0');
    if (s.loadCoins().toString() !== claim.amountRaw) return pending;
    const target = s.loadRef().beginParse(); end(s); target.loadCoins(); target.loadCoins(); target.loadCoins();
    if (target.loadAddress().toRawString() !== input.owner) return pending;
    const metadata = target.loadRef(); end(target);
    const edge = (node: Node, destination: string, predicate: (body: Cell) => boolean) => {
      const matches = node.raw.outMessages.flatMap((m, i) => {
        const b = businessBodyCell(m), next = receiptFor(node, i);
        return b && next && ok(next) && addr(m.source) === node.account && addr(m.destination) === destination &&
          !m.bounced && next.account === destination && messageKey(m) && messageKey(m) === messageKey(next.raw.inMessage) && predicate(b) ? [next] : [];
      });
      return matches.length === 1 ? matches[0] : null;
    };
    const reservation = edge(execution, vault, b => b.equals(body)); if (!reservation) return pending;
    const rvWallet = perpsWalletAddress(states.after.walletCode, engine.root, vault);
    let vaultCodeHash: string | null = null;
    const read = async (node: Node) => {
      const snapshot = await input.stateAt(vault, node.raw.lt, node.raw.hash);
      if (!snapshot?.state.codeBoc || !snapshot.state.dataBoc) return null;
      const hash = Cell.fromBase64(snapshot.state.codeBoc).hash().toString('hex');
      if (vaultCodeHash && vaultCodeHash !== hash) return null; vaultCodeHash = hash;
      return readRiskVaultPayoutJournal(Cell.fromBase64(snapshot.state.dataBoc), bucket, claim.actionId, engine.root, engine.walletCodeHash);
    };
    const exact = (j: Awaited<ReturnType<typeof read>>) => j && j.requestHash === claim.requestHash && j.requested === claim.amountRaw && j.amount === claim.amountRaw &&
      j.requester === engine.address && j.recipient === input.owner && j.destination === engine.ownerWallet && j.metadata.equals(metadata);
    const reserved = await read(reservation); if (!exact(reserved) || ![1, 2].includes(reserved!.status)) return pending;
    const vaultNodes = args.nodes.filter(n => n.account === vault && ok(n) && BigInt(n.raw.lt) >= BigInt(reservation.raw.lt));
    if (vaultNodes.length > 512) return pending;
    for (const flow of args.flows.filter(f => f.confirmed && f.wire.op === SETTLEMENT_INTERNAL && f.wire.amountRaw === claim.amountRaw &&
      f.source.account === rvWallet && f.recipient.account === engine.ownerWallet && f.sourceAsset.master === engine.root && f.recipientAsset.master === engine.root)) {
      const dispatchParents = vaultNodes.filter(n => edge(n, rvWallet, b => {
        const transfer = tokenWire({ body: b.toBoc().toString('base64') });
        return transfer?.op === TRANSFER && transfer.queryId === flow.wire.queryId && transfer.amountRaw === claim.amountRaw && transfer.owner === input.owner &&
          transfer.response === vault && transfer.custom?.equals(beginCell().storeUint(0x4a535454, 32).endCell()) === true && transfer.forwardTonRaw === '0' && transfer.forward.equals(Cell.EMPTY);
      })?.id === flow.source.id);
      if (dispatchParents.length !== 1) continue;
      const dispatchParent = dispatchParents[0], dispatched = await read(dispatchParent);
      if (!exact(dispatched) || dispatched!.status !== 2 || dispatched!.wire !== flow.wire.queryId) continue;
      const control = (node: Node, destination: string, opcode: number) => edge(node, destination, b => {
        const c = perpsControl({ body: b.toBoc().toString('base64') }, opcode);
        return c?.queryId === flow.wire.queryId && c.amountRaw === claim.amountRaw && c.destination === engine.ownerWallet;
      });
      const accepted = control(flow.recipient, rvWallet, 0x4a534143), succeeded = accepted && control(accepted, vault, 0x4a535543),
        finalize = succeeded && control(succeeded, rvWallet, 0x4a53464e), finalized = finalize && control(finalize, vault, 0x4a53464b);
      if (!accepted || !succeeded || !finalize || !finalized) continue;
      const delivered = await read(finalized); if (!exact(delivered) || delivered!.status !== 3 || delivered!.wire !== flow.wire.queryId) continue;
      const hookBody = beginCell().storeUint(0x52565048, 32).storeUint(bucket, 16).storeUint(BigInt(claim.actionId), 64)
        .storeUint(BigInt(`0x${claim.requestHash}`), 256).storeCoins(BigInt(claim.amountRaw)).storeAddress(Address.parse(input.owner)).storeRef(metadata).endCell();
      for (const hookParent of vaultNodes.filter(n => BigInt(n.raw.lt) >= BigInt(finalized.raw.lt))) {
        const hook = edge(hookParent, engine.address, b => b.equals(hookBody)); if (!hook) continue;
        const hookEntry = await read(hookParent); if (!exact(hookEntry) || hookEntry!.status !== 3 || hookEntry!.wire !== flow.wire.queryId) continue;
        const terminal = await args.boundary(hook), terminalAction = terminal && perpsRiskAction(terminal.after, 1, positionId);
        if (!terminalAction || terminalAction.actionId !== claim.actionId || terminalAction.requestHash !== claim.requestHash || terminalAction.status !== 4 || terminalAction.settledAmountRaw !== claim.amountRaw) continue;
        const nodes = [...new Map([execution, reservation, dispatchParent, flow.source, flow.recipient, accepted, succeeded, finalize, finalized, hookParent, hook].map(n => [n.id, n])).values()];
        if (!nodes.every(n => chainCoversTransaction(input.chains.get(n.account), n.raw))) continue;
        const proof: PerpsCounterpartyPaymentProof = { version: 'perps-counterparty-payment-v1', vault, vaultCodeHash: vaultCodeHash!, rvWallet,
          beneficiaryOwner: input.owner, beneficiaryWallet: engine.ownerWallet, payoutWireQueryId: flow.wire.queryId,
          actionId: claim.actionId, bucketId: bucket, positionId, priorActionId, priorRequestHash, requestHash: claim.requestHash, amountRaw: claim.amountRaw,
          reservation: ref(reservation), dispatch: ref(flow.source), delivery: ref(flow.recipient), walletFinality: ref(finalized), hook: ref(hook) };
        return { payout: { status: 'completed', amountRaw: claim.amountRaw, evidence: nodes.map(ref), proof }, nodes, flow };
      }
    }
  } catch { /* Missing, malformed or old layouts cannot certify a payment. */ }
  return pending;
}

import type { Node, ProjectionInput } from "./project";
import type { LedgerOptionFactory } from "./options";
import { perpsControl, perpsWalletAddress } from "./perpsWire";
import { SETTLEMENT_INTERNAL, TRANSFER, tokenWire } from "./wire";
import { canonicalLedgerAddress, canonicalLedgerHash } from "./normalize";
export const optionTransactionSucceeded = (n: Node) =>
  n.raw.success &&
  (!n.raw.status || n.raw.status === "success");
export const optionNodeOk = (n: Node) =>
  optionTransactionSucceeded(n) &&
  !n.raw.inMessage?.bounced;
export const optionRef = (n: Node) => ({
  account: n.account,
  lt: n.raw.lt,
  hash: canonicalLedgerHash(n.raw.hash),
  utime: n.raw.utime,
});
export const optionUnique = (ns: Node[]) => [
  ...new Map(ns.map((n) => [n.id, n])).values(),
];
const addr = (s?: string) => {
  try {
    return s ? canonicalLedgerAddress(s) : null;
  } catch {
    return null;
  }
};
/** Exact standard Jetton settlement handshake, including the source wallet's
 * durable Finalized receipt. This proves physical delivery, not controller accounting. */
export function proveOptionCash(
  input: ProjectionInput,
  factory: LedgerOptionFactory,
  start: Node,
  recipient: string,
  wireId: string,
  amountRaw: string,
  receiptFor: (n: Node, i: number) => Node | null,
) {
  if (
    !factory.walletCode ||
    !factory.qualification ||
    wireId === "0" ||
    amountRaw === "0" ||
    // A successful recovery may dispatch real cash while handling a bounced
    // incoming message. Product decoders separately prove its recovery trigger.
    !optionTransactionSucceeded(start)
  )
    return null;
  const sourceWallet = perpsWalletAddress(
      factory.walletCode,
      factory.collateralRoot,
      start.account,
    ),
    destinationWallet = perpsWalletAddress(
      factory.walletCode,
      factory.collateralRoot,
      recipient,
    );
  const sourceAsset = input.wallets.get(sourceWallet),
    destinationAsset = input.wallets.get(destinationWallet);
  if (
    sourceAsset?.owner !== start.account ||
    destinationAsset?.owner !== recipient ||
    [sourceAsset, destinationAsset].some(
      (a) => a.master !== factory.collateralRoot,
    )
  )
    return null;
  const dispatches = start.raw.outMessages.flatMap((m, i) => {
    const r = tokenWire(m),
      next = receiptFor(start, i);
    return addr(m.source) === start.account &&
      addr(m.destination) === sourceWallet &&
      !m.bounced &&
      r?.op === TRANSFER &&
      r.queryId === wireId &&
      r.amountRaw === amountRaw &&
      r.owner === recipient &&
      r.custom?.bits.length === 32 &&
      r.custom.refs.length === 0 &&
      r.custom.beginParse().preloadUint(32) === 0x4a535454 &&
      next &&
      optionNodeOk(next)
      ? [{ source: next, request: r }]
      : [];
  });
  if (dispatches.length !== 1) return null;
  const { source, request } = dispatches[0];
  const credits = source.raw.outMessages.flatMap((m, i) => {
    const w = tokenWire(m),
      next = receiptFor(source, i);
    return addr(m.source) === sourceWallet &&
      addr(m.destination) === destinationWallet &&
      !m.bounced &&
      w?.op === SETTLEMENT_INTERNAL &&
      w.owner === start.account &&
      w.queryId === wireId &&
      w.amountRaw === amountRaw &&
      w.response === sourceWallet &&
      w.forward.hash().equals(request.forward.hash()) &&
      next &&
      optionNodeOk(next)
      ? [next]
      : [];
  });
  if (credits.length !== 1) return null;
  const credit = credits[0];
  const edge = (n: Node, destination: string, op: number) => {
    const found = n.raw.outMessages.flatMap((m, i) => {
      const v = perpsControl(m, op),
        next = receiptFor(n, i);
      return addr(m.source) === n.account &&
        addr(m.destination) === destination &&
        !m.bounced &&
        v?.queryId === wireId &&
        v.amountRaw === amountRaw &&
        v.destination === destinationWallet &&
        next &&
        optionNodeOk(next)
        ? [next]
        : [];
    });
    return found.length === 1 ? found[0] : null;
  };
  const credited = edge(credit, sourceWallet, 0x4a534143),
    succeeded = credited && edge(credited, start.account, 0x4a535543),
    finalized = succeeded && edge(succeeded, sourceWallet, 0x4a53464e),
    terminal = finalized && edge(finalized, start.account, 0x4a53464b);
  if (!credited || !succeeded || !finalized || !terminal) return null;
  const nodes = optionUnique([
    start,
    source,
    credit,
    credited,
    succeeded,
    finalized,
    terminal,
  ]);
  if (nodes.some((n) => !input.chains.get(n.account)?.historyComplete))
    return null;
  return { source, credit, terminal, sourceWallet, destinationWallet, nodes };
}

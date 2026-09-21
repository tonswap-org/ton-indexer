import { Cell } from "@ton/core";
import type {
  LedgerAsset,
  LedgerEvent,
  LedgerEvidenceRef,
  LedgerMovement,
} from "./types";
import type { Flow, Node, ProjectionInput } from "./project";
import { canonicalLedgerAddress, canonicalLedgerHash } from "./normalize";
import { bodyCell, NOTIFY, tokenWire } from "./wire";
import * as w from "./t3Wire";
import { recoverT3Burn } from "./t3Recovery";
export type LedgerT3Hub = {
  address: string;
  root: string;
  codeHash: string;
  redemptionBinding?: import("../config/ledgerT3").LedgerT3RedemptionBinding;
  reserveRoots: string[];
  vaults: string[];
  receiver?: string;
  redemptions: Map<
    string,
    {
      payoutId: string;
      consumed: boolean;
      wireId: string;
      getter: NonNullable<LedgerMovement["evidence"]["getter"]>;
    }
  >;
};
export type T3LedgerOperation = {
  anchor: Node;
  kind: "t3_mint" | "t3_redeem";
  queryId: string;
  confirmed: boolean;
  evidence: LedgerEvidenceRef[];
  issue?: string;
  settlement: NonNullable<LedgerEvent["settlement"]>;
};
const addr = (v?: string) => {
  try {
    return v ? canonicalLedgerAddress(v) : null;
  } catch {
    return null;
  }
};
const ok = (n: Node) =>
  n.raw.success &&
  (!n.raw.status || n.raw.status === "success") &&
  !n.raw.inMessage?.bounced;
const ref = (n: Node): LedgerEvidenceRef => ({
  account: n.account,
  lt: n.raw.lt,
  hash: canonicalLedgerHash(n.raw.hash),
  utime: n.raw.utime,
});
const unique = (n: Node[]) => [...new Map(n.map((v) => [v.id, v])).values()];
const sum = (values: string[]) =>
  values.reduce((n, v) => n + BigInt(v), 0n).toString();
const equal = (a: string[], b: string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const zeros = () => ["0", "0", "0"];
const owned = (asset: LedgerAsset | undefined, owner: string) =>
  asset?.owner === owner || asset?.controller === owner;
export async function decodeT3(
  input: ProjectionInput,
  nodes: Node[],
  flows: Flow[],
  receiptFor: (n: Node, i: number) => Node | null,
  attach: (a: Node, b: Node) => void,
) {
  const operations: T3LedgerOperation[] = [],
    usedFlows = new Set<string>(),
    seen = new Map<string, Node>();
  const complete = (ns: Node[]) =>
    unique(ns).every((n) => input.chains.get(n.account)?.historyComplete);
  const edge = <T>(
    n: Node,
    dest: string,
    parse: (m: Node["raw"]["inMessage"]) => T | null,
    match: (v: T) => boolean,
  ) =>
    n.raw.outMessages.flatMap((m, i) => {
      const v = parse(m),
        next = receiptFor(n, i);
      return addr(m.source) === n.account &&
        addr(m.destination) === dest &&
        v &&
        match(v) &&
        next &&
        next.account === dest &&
        ok(next) &&
        !m.bounced
        ? [{ node: next, value: v, index: i }]
        : [];
    });
  const one = <T>(a: T[]) => (a.length === 1 ? a[0] : null);
  const finish = (
    anchor: Node,
    ns: Node[],
    kind: T3LedgerOperation["kind"],
    meta: NonNullable<NonNullable<LedgerEvent["settlement"]>["t3"]>,
    confirmed: boolean,
    issue: string | undefined,
  ) => {
    ns = unique([anchor, ...ns]);
    for (const n of ns) if (n.event) attach(anchor, n);
    meta.localNetworkFees = ns.map((n) => ({
      transaction: ref(n),
      amountRaw: n.raw.totalFeesRaw ?? null,
      includedInOwnerFeeMovements: Boolean(n.event),
    }));
    const evidence = ns.map(ref);
    operations.push({
      anchor,
      kind,
      queryId: meta.queryId,
      confirmed,
      evidence,
      issue,
      settlement: {
        status: confirmed ? "confirmed" : "incomplete",
        protocol: "t3",
        operation: kind,
        queryId: meta.queryId,
        t3: meta,
        evidence,
      },
    });
    if (meta.feeBreakdown === "unavailable")
      anchor.event?.issues.push("t3_protocol_fee_breakdown_unavailable");
  };
  const feeState = async (hub: LedgerT3Hub, n: Node) => {
    try {
      if (!n.raw.prevTransactionLt || !n.raw.prevTransactionHash) return null;
      const before = await input.stateAt(
          hub.address,
          n.raw.prevTransactionLt,
          n.raw.prevTransactionHash,
        ),
        after = await input.stateAt(hub.address, n.raw.lt, n.raw.hash);
      if (
        !before?.state.dataBoc ||
        !after?.state.dataBoc ||
        [before, after].some(
          (s) =>
            !s.state.codeBoc ||
            Cell.fromBase64(s.state.codeBoc).hash().toString("hex") !==
              hub.codeHash,
        )
      )
        return null;
      const b = w.t3State(before.state.dataBoc),
        a = w.t3State(after.state.dataBoc);
      if (a.root !== hub.root || b.root !== hub.root) return null;
      return {
        state: b,
        evidence: {
          kind: "t3_mint" as const,
          stateBeforeHash: b.dataHash,
          stateAfterHash: a.dataHash,
          beforeSeqno: before.seqno,
          afterSeqno: after.seqno,
          transactions: [ref(n)],
        },
      };
    } catch {
      return null;
    }
  };
  const notifications = (flow: Flow, hub: string) =>
    edge(
      flow.recipient,
      hub,
      tokenWire,
      (v) =>
        v.op === NOTIFY &&
        v.queryId === flow.wire.queryId &&
        v.amountRaw === flow.wire.amountRaw &&
        v.owner === flow.sourceAsset.owner &&
        v.forward.hash().equals(flow.wire.forward.hash()) &&
        (v.senderWallet === undefined ||
          v.senderWallet === flow.source.account),
    );
  for (const hub of input.t3Hubs?.values() ?? []) {
    const deposits = flows.filter(
      (f) =>
        f.sourceAsset.owner === input.owner &&
        f.recipientAsset.owner === hub.address &&
        hub.vaults.includes(f.recipient.account) &&
        hub.reserveRoots.includes(f.sourceAsset.master!) &&
        w.depositNote(f.wire.forward),
    );
    // The business receipt is emitted only when the hub consumes the exact root success tuple.
    for (const hubNode of nodes.filter(
      (n) => n.account === hub.address && ok(n),
    )) {
      const succeeded = w.mintAck(hubNode.raw.inMessage, w.MINT_SUCCEEDED);
      if (
        !succeeded ||
        succeeded.recipient !== input.owner ||
        addr(hubNode.raw.inMessage?.source) !== hub.root
      )
        continue;
      const receipts = hubNode.raw.outMessages.flatMap((m, i) => {
          const r = w.mintReceipt(m);
          return addr(m.destination) === input.owner &&
            r?.recipient === input.owner &&
            r.amountRaw === succeeded.amountRaw &&
            r.amountRaw !== "0"
            ? [{ r, node: receiptFor(hubNode, i) }]
            : [];
        }),
        receipt = one(receipts);
      if (!receipt) continue;
      const r = receipt.r,
        key = `mint:${hub.address}:${hub.root}:${succeeded.wireId}:${succeeded.requestHash}`;
      const creditCandidates = nodes
        .filter(
          (n) =>
            owned(input.wallets.get(n.account), input.owner) &&
            ok(n) &&
            addr(n.raw.inMessage?.source) === hub.root,
        )
        .flatMap((n) => {
          const v = w.mintInternal(n.raw.inMessage);
          return v &&
            v.caller === hub.address &&
            v.recipient === input.owner &&
            v.queryId === succeeded.queryId &&
            v.wireId === succeeded.wireId &&
            v.amountRaw === succeeded.amountRaw &&
            v.requestHash === succeeded.requestHash &&
            v.requestHash === w.mintRequestHash(hub.root, n.account, v)
            ? [{ node: n, v }]
            : [];
        });
      const credit = creditCandidates.sort((a, b) =>
        BigInt(a.node.raw.lt) < BigInt(b.node.raw.lt) ? -1 : 1,
      )[0];
      const ds = deposits.filter((f) => f.wire.queryId === r.queryId),
        anchor = ds[0]?.source ?? credit?.node ?? receipt.node;
      if (!anchor?.event) continue;
      if (seen.has(key)) {
        for (const n of [
          hubNode,
          receipt.node,
          ...creditCandidates.map((c) => c.node),
        ])
          if (n?.event) attach(seen.get(key)!, n);
        continue;
      }
      seen.set(key, anchor);
      let ns: Node[] = [hubNode, ...(receipt.node ? [receipt.node] : [])];
      const meta: NonNullable<NonNullable<LedgerEvent["settlement"]>["t3"]> = {
        hub: hub.address,
        root: hub.root,
        owner: input.owner,
        recipient: input.owner,
        queryId: r.queryId,
        amountRaw: r.amountRaw,
        rootQueryId: succeeded.queryId,
        wireId: succeeded.wireId,
        requestHash: succeeded.requestHash,
        reserveRoots: hub.reserveRoots,
        basketRaw: r.basketRaw,
        deliveredRaw: zeros(),
        stage: "unresolved",
        feeBreakdown: "unavailable",
        localNetworkFees: [],
      };
      let issue = "t3_mint_delivery_unverified",
        proved = false,
        origin: Node | undefined;
      if (
        credit &&
        input.wallets.get(credit.node.account)?.master === hub.root
      ) {
        ns.push(...creditCandidates.map((c) => c.node));
        const roots = nodes
            .filter((n) => n.account === hub.root && ok(n))
            .flatMap((n) => {
              const start = w.mintStart(n.raw.inMessage);
              return start &&
                addr(n.raw.inMessage?.source) === hub.address &&
                start.response === hub.address &&
                start.queryId === credit.v.queryId &&
                start.amountRaw === credit.v.amountRaw &&
                start.recipient === input.owner &&
                start.forwardTonRaw === credit.v.forwardTonRaw &&
                start.forward.hash().equals(credit.v.forward.hash()) &&
                n.raw.outMessages.some(
                  (_, i) => receiptFor(n, i)?.id === credit.node.id,
                )
                ? [{ node: n, start }]
                : [];
            }),
          root = one(roots);
        const ack = one(
          edge(
            credit.node,
            hub.root,
            (m) => w.mintAck(m, w.MINT_ACCEPTED),
            (v) =>
              v.queryId === succeeded.queryId &&
              v.wireId === succeeded.wireId &&
              v.amountRaw === succeeded.amountRaw &&
              v.requestHash === succeeded.requestHash,
          ),
        );
        const successEdge =
          ack &&
          edge(
            ack.node,
            hub.address,
            (m) => w.mintAck(m, w.MINT_SUCCEEDED),
            (v) =>
              v.queryId === succeeded.queryId &&
              v.wireId === succeeded.wireId &&
              v.amountRaw === succeeded.amountRaw &&
              v.recipient === input.owner &&
              v.requestHash === succeeded.requestHash,
          ).some((e) => e.node.id === hubNode.id);
        const final = one(
          edge(
            hubNode,
            hub.root,
            w.mintFinalize,
            (v) =>
              v.queryId === succeeded.queryId &&
              v.amountRaw === succeeded.amountRaw &&
              v.recipient === input.owner &&
              v.requestHash === succeeded.requestHash,
          ),
        );
        const finalized =
          final &&
          one(
            edge(
              final.node,
              hub.address,
              (m) => w.mintFinalize(m, w.MINT_FINALIZED),
              (v) =>
                v.queryId === succeeded.queryId &&
                v.amountRaw === succeeded.amountRaw &&
                v.recipient === input.owner &&
                v.requestHash === succeeded.requestHash,
            ),
          );
        if (root && ack && successEdge && final && finalized) {
          ns.push(root.node, ack.node, final.node, finalized.node);
          origin =
            one(
              nodes.filter(
                (n) =>
                  n.account === hub.address &&
                  ok(n) &&
                  n.raw.outMessages.some(
                    (_, i) => receiptFor(n, i)?.id === root.node.id,
                  ),
              ),
            ) ?? undefined;
          if (origin) ns.push(origin);
          proved = true;
        }
        // A successful canonical wallet credit is an exact movement even while later confirmation is incomplete.
        credit.node.event!.movements.push({
          id: `${input.network}:${key}:credit`,
          direction: "in",
          purpose: "t3_mint",
          asset: input.wallets.get(credit.node.account)!,
          amountRaw: r.amountRaw,
          source: hub.root,
          destination: input.owner,
          evidence: {
            kind: "t3_mint",
            opcode: w.MINT_INTERNAL,
            bodyHash: bodyCell(credit.node.raw.inMessage)!
              .hash()
              .toString("hex"),
            transactions: ns.map(ref),
          },
        });
      }
      const totals = hub.reserveRoots.map((root) =>
        sum(
          ds
            .filter((f) => f.sourceAsset.master === root)
            .map((f) => f.wire.amountRaw),
        ),
      );
      let funding = ds.length > 0 && equal(totals, r.basketRaw);
      for (const d of ds) {
        ns.push(d.source, d.recipient);
        const notification = one(notifications(d, hub.address));
        if (notification) ns.push(notification.node);
        else funding = false;
        usedFlows.add(d.id);
        const m = d.source.event?.movements.find((m) => m.id === `${d.id}:out`);
        if (m) m.purpose = "t3_collateral";
      }
      const initialRequest = origin
          ? w.mintRequest(origin.raw.inMessage)
          : null,
        initialNote = origin ? tokenWire(origin.raw.inMessage) : null;
      const originalDeposit = initialNote ? w.depositNote(initialNote.forward) : null;
      if (initialRequest) meta.referrer = initialRequest.referrer;
      else if (originalDeposit) meta.referrer = originalDeposit.referrer;
      const initialMint =
        Boolean(
          initialRequest?.queryId === r.queryId &&
            initialRequest.recipient === input.owner &&
            (equal(initialRequest.basketRaw, r.basketRaw) ||
              equal(initialRequest.basketRaw, zeros())),
        ) ||
        Boolean(
          initialNote?.op === NOTIFY &&
            initialNote.owner === input.owner &&
            initialNote.queryId === r.queryId &&
            hub.vaults.includes(addr(origin?.raw.inMessage?.source) ?? "") &&
            w.depositNote(initialNote.forward)?.flags === 1,
        );
      const state = origin && initialMint ? await feeState(hub, origin) : null;
      if (state && funding) {
        const bps = BigInt(Math.min(10000, state.state.mintFeeBps)),
          fees = r.basketRaw.map((v) =>
            r.basketRaw.filter((x) => x !== "0").length === 3
              ? "0"
              : (BigInt(v) - (BigInt(v) * (10000n - bps)) / 10000n).toString(),
          );
        meta.feeBreakdown = "verified";
        meta.feeAmountsRaw = fees;
        meta.feeEvidence = state.evidence;
        // Allocate the exact per-asset skim across actual input debits; principal + fee equals each gross debit.
        for (let i = 0; i < 3; i++) {
          let remaining = BigInt(fees[i]);
          for (const d of ds.filter(
            (d) => d.sourceAsset.master === hub.reserveRoots[i],
          )) {
            const m = d.source.event?.movements.find(
              (m) => m.id === `${d.id}:out`,
            );
            if (!m || (m.evidence.kind === "native_message" || m.evidence.kind === "transaction_fee" || m.evidence.kind === "message_forward_fee")) continue;
            const tokenEvidence: Omit<typeof m.evidence, "transactionStatus"> = m.evidence;
            const fee =
              remaining < BigInt(m.amountRaw) ? remaining : BigInt(m.amountRaw);
            remaining -= fee;
            if (fee > 0n) {
              d.source.event!.movements.push({
                ...m,
                id: `${d.id}:t3-fee`,
                direction: "fee",
                purpose: "protocol_fee",
                amountRaw: fee.toString(),
                evidence: { ...tokenEvidence, ...state.evidence },
              });
              m.amountRaw = (BigInt(m.amountRaw) - fee).toString();
            }
          }
        }
      }
      proved = proved && funding && initialMint && complete(ns);
      if (proved) {
        meta.stage = "minted";
        issue = "";
        meta.mintedRaw = r.amountRaw;
      } else
        issue = !funding
          ? "t3_mint_funding_unverified"
          : !initialMint
            ? "t3_mint_original_request_unverified"
          : !complete(ns)
            ? "related_account_history_incomplete"
            : issue;
      finish(anchor, ns, "t3_mint", meta, proved, issue || undefined);
    }
    // Deposits without a completed mint retain their gross debit and fees with an explicit pending settlement.
    for (const d of deposits)
      if (!usedFlows.has(d.id)) {
        usedFlows.add(d.id);
        const ns = [
          d.source,
          d.recipient,
          ...notifications(d, hub.address).map((e) => e.node),
        ];
        finish(
          d.source,
          ns,
          "t3_mint",
          {
            hub: hub.address,
            root: hub.root,
            owner: input.owner,
            recipient: input.owner,
            queryId: d.wire.queryId,
            amountRaw: null,
            referrer: w.depositNote(d.wire.forward)?.referrer ?? null,
            stage: "unresolved",
            reserveRoots: hub.reserveRoots,
            basketRaw: hub.reserveRoots.map((r) =>
              r === d.sourceAsset.master ? d.wire.amountRaw : "0",
            ),
            deliveredRaw: zeros(),
            feeBreakdown: "unavailable",
            localNetworkFees: [],
          },
          false,
          "t3_mint_settlement_unconfirmed",
        );
      }
    const successfulBurn = (n: Node) => {
      const r = w.burnRequest(n.raw.inMessage);
      if (!r || !ok(n)) return false;
      const root = one(
        edge(
          n,
          hub.root,
          w.burnNotify,
          (v) =>
            v.queryId === r.queryId &&
            v.amountRaw === r.amountRaw &&
            v.owner === input.owner &&
            v.response === hub.address &&
            v.payload.hash().equals(r.payload.hash()),
        ),
      );
      const proof =
        root &&
        one(
          edge(
            root.node,
            hub.address,
            w.burnNotify,
            (v) =>
              w.burnProof(v.payload)?.queryId === r.queryId &&
              w.burnProof(v.payload)?.payload.hash().equals(r.payload.hash()) === true &&
              v.owner === input.owner &&
              v.amountRaw === r.amountRaw,
          ),
        );
      const ack =
        proof &&
        one(
          edge(
            proof.node,
            hub.root,
            w.burnAck,
            (v) =>
              v.queryId === proof.value.queryId &&
              v.amountRaw === r.amountRaw &&
              v.requestHash === w.burnIntentHash(input.owner, r.queryId),
          ),
        );
      return Boolean(
        ack &&
          one(
            edge(
              ack.node,
              n.account,
              w.burnAck,
              (v) =>
                v.queryId === r.queryId &&
                v.amountRaw === r.amountRaw &&
                v.requestHash ===
                  w.burnRequestHash(hub.root, n.account, input.owner, r),
            ),
          ),
      );
    };
    for (const { node: walletNode } of nodes
      .filter(
        (n) =>
          n.event &&
          input.wallets.get(n.account)?.owner === input.owner &&
          input.wallets.get(n.account)?.master === hub.root &&
          w.burnRequest(n.raw.inMessage),
      )
      .map((node) => ({ node, settled: successfulBurn(node) }))
      .sort(
        (a, b) =>
          Number(b.settled) - Number(a.settled) ||
          Number(ok(b.node)) - Number(ok(a.node)) ||
          (BigInt(a.node.raw.lt) < BigInt(b.node.raw.lt) ? -1 : 1),
      )) {
      const asset = input.wallets.get(walletNode.account),
        request = w.burnRequest(walletNode.raw.inMessage);
      if (
        !walletNode.event ||
        asset?.owner !== input.owner ||
        asset.master !== hub.root ||
        !request ||
        request.response !== hub.address ||
        addr(walletNode.raw.inMessage?.source) !== input.owner
      )
        continue;
      const key = `redeem:${hub.address}:${input.owner}:${request.queryId}`;
      if (seen.has(key)) {
        attach(seen.get(key)!, walletNode);
        continue;
      }
      seen.set(key, walletNode);
      let ns = [walletNode],
        issue = "t3_burn_proof_unverified",
        burned = false,
        proved = false;
      const identity = hub.redemptions.get(request.queryId),
        meta: NonNullable<NonNullable<LedgerEvent["settlement"]>["t3"]> = {
          hub: hub.address,
          root: hub.root,
          owner: input.owner,
          recipient: request.recipient,
          queryId: request.queryId,
          amountRaw: request.amountRaw,
          referrer: request.referrer,
          stage: "unresolved",
          reserveRoots: hub.reserveRoots,
          basketRaw: zeros(),
          deliveredRaw: zeros(),
          feeBreakdown: "unavailable",
          localNetworkFees: [],
        };
      if (identity) {
        meta.payoutId = identity.payoutId;
        meta.wireId = identity.wireId;
        meta.identityEvidence = identity.getter;
      }
      if (hub.receiver && request.recipient === input.owner)
        meta.receiver = hub.receiver;
      const root = ok(walletNode)
        ? one(
            edge(
              walletNode,
              hub.root,
              w.burnNotify,
              (v) =>
                v.queryId === request.queryId &&
                v.amountRaw === request.amountRaw &&
                v.owner === input.owner &&
                v.response === hub.address &&
                v.payload.hash().equals(request.payload.hash()),
            ),
          )
        : null;
      const proof =
        root &&
        one(
          edge(root.node, hub.address, w.burnNotify, (v) => {
            const p = w.burnProof(v.payload);
            return (
              v.owner === input.owner &&
              v.amountRaw === request.amountRaw &&
              v.response === hub.address &&
              p?.queryId === request.queryId &&
              p.payload.hash().equals(request.payload.hash())
            );
          }),
        );
      const hubAck =
        proof &&
        one(
          edge(
            proof.node,
            hub.root,
            w.burnAck,
            (v) =>
              v.queryId === proof.value.queryId &&
              v.amountRaw === request.amountRaw &&
              v.requestHash === w.burnIntentHash(input.owner, request.queryId),
          ),
        );
      const accepted =
        hubAck &&
        one(
          edge(
            hubAck.node,
            walletNode.account,
            w.burnAck,
            (v) =>
              v.queryId === request.queryId &&
              v.amountRaw === request.amountRaw &&
              v.requestHash ===
                w.burnRequestHash(
                  hub.root,
                  walletNode.account,
                  input.owner,
                  request,
                ),
          ),
        );
      const requests = nodes
        .filter(
          (n) =>
            n.account === hub.address &&
            ok(n) &&
            addr(n.raw.inMessage?.source) === input.owner,
        )
        .flatMap((n) => {
          const v = w.redeemRequest(n.raw.inMessage);
          return v &&
            v.owner === input.owner &&
            v.queryId === request.queryId &&
            v.recipient === request.recipient &&
            v.amountRaw === request.amountRaw &&
            v.slippage === request.slippage &&
            v.mode === request.mode &&
            v.outputToken === request.outputToken &&
            v.referrer === request.referrer
            ? [n]
            : [];
        });
      let execution = requests.length === 1 ? requests[0] : undefined;
      if (root && proof && hubAck && accepted) {
        ns.push(root.node, proof.node, hubAck.node, accepted.node);
        burned = true;
      } else if (root && proof) {
        const recovery = await recoverT3Burn(
          input,
          hub,
          walletNode,
          root.node,
          proof.node,
          proof.value.queryId,
          request,
          requests,
          receiptFor,
        );
        ns.push(...recovery.nodes);
        if (recovery.metadata) {
          meta.burnRecovery = recovery.metadata;
          execution = recovery.continuation;
          burned = true;
        } else issue = recovery.issue ?? issue;
      }
      if (burned) {
        meta.requestHash = w.burnIntentHash(input.owner, request.queryId);
        walletNode.event.movements.push({
          id: `${input.network}:${key}:burn`,
          direction: "out",
          purpose: "t3_burn",
          asset,
          amountRaw: request.amountRaw,
          source: input.owner,
          destination: hub.root,
          evidence: {
            kind: "t3_burn",
            opcode: 0x595f07bc,
            bodyHash: bodyCell(walletNode.raw.inMessage)!
              .hash()
              .toString("hex"),
            transactions: ns.map(ref),
          },
        });
      }
      const recoveryIdentityMatches =
        !meta.burnRecovery ||
        meta.burnRecovery.continuation.after.proof?.payoutId ===
          identity?.payoutId;
      if (!recoveryIdentityMatches)
        issue = "t3_recovery_payout_identity_mismatch";
      if (
        burned &&
        recoveryIdentityMatches &&
        identity?.consumed &&
        identity.wireId === proof!.value.queryId &&
        identity.payoutId !== "0" &&
        execution
      ) {
        ns.push(execution);
        issue = "t3_redemption_payout_unverified";
        const receipts = nodes
          .filter((n) => n.account === hub.address && ok(n))
          .flatMap((n) =>
            n.raw.outMessages.flatMap((m, i) => {
              const r = w.redeemReceipt(m);
              return r &&
                addr(m.destination) === request.recipient &&
                r.recipient === request.recipient &&
                r.queryId === request.queryId &&
                r.mode === request.mode &&
                r.outputToken === request.outputToken &&
                BigInt(n.raw.lt) >= BigInt(execution.raw.lt)
                ? [{ r, node: n, recipient: receiptFor(n, i) }]
                : [];
            }),
          );
        meta.basketRaw = hub.reserveRoots.map((_, i) =>
          sum(receipts.map((v) => v.r.basketRaw[i])),
        );
        for (const r of receipts) {
          ns.push(r.node);
          if (r.recipient) ns.push(r.recipient);
        }
        const payouts = flows.flatMap((f) => {
          const p = w.receiverPayout(f.wire.forward);
          return p &&
            p.hub === hub.address &&
            p.controller === request.recipient &&
            p.receiver === hub.receiver &&
            p.payoutId === identity.payoutId &&
            p.wireId === f.wire.queryId &&
            p.amountRaw === f.wire.amountRaw &&
            f.source.account === hub.vaults[p.token] &&
            f.sourceAsset.master === hub.reserveRoots[p.token] &&
            f.recipientAsset.owner === hub.receiver &&
            f.recipientAsset.controller === input.owner
            ? [{ f, p }]
            : [];
        });
        let allCredited = true;
        const totals = zeros();
        for (const { f, p } of payouts) {
          usedFlows.add(f.id);
          ns.push(f.source, f.recipient);
          const notify = one(notifications(f, hub.receiver!));
          const ack =
            notify &&
            one(
              edge(
                notify.node,
                hub.address,
                w.receiverAck,
                (v) =>
                  v.payoutId === p.payoutId &&
                  v.wireId === p.wireId &&
                  v.routeEpoch === p.routeEpoch &&
                  v.token === p.token &&
                  v.amountRaw === p.amountRaw &&
                  v.receiverWallet === f.recipient.account &&
                  v.payoutHash === p.payoutHash,
              ),
            );
          if (notify && ack) {
            ns.push(notify.node, ack.node);
            totals[p.token] = (
              BigInt(totals[p.token]) + BigInt(f.wire.amountRaw)
            ).toString();
          } else allCredited = false;
          const m = f.recipient.event?.movements.find(
            (m) => m.id === `${f.id}:in`,
          );
          if (m && m.evidence.kind !== "native_message" && m.evidence.kind !== "transaction_fee" && m.evidence.kind !== "message_forward_fee") {
            const tokenEvidence: Omit<typeof m.evidence, "transactionStatus"> = m.evidence;
            m.purpose = "t3_payout";
            m.evidence = {
              ...tokenEvidence,
              kind: "t3_payout",
              getter: identity.getter,
            };
          }
        }
        meta.deliveredRaw = totals;
        proved =
          allCredited &&
          payouts.length > 0 &&
          sum(receipts.map((v) => v.r.amountRaw)) === request.amountRaw &&
          equal(totals, meta.basketRaw) &&
          request.recipient === input.owner &&
          complete(ns);
        // Withheld reserve fees are metadata, not a second debit from the user wallet. Exact historical healthy-state math must conserve the authenticated net payout basket.
        const state = await feeState(hub, execution);
        const fee = state
          ? w.redemptionFees(
              state.state,
              request.amountRaw,
              request.mode,
              request.outputToken,
            )
          : null;
        if (state && fee && equal(fee.net, meta.basketRaw)) {
          meta.feeBreakdown = "verified";
          meta.feeAmountsRaw = fee.fees;
          meta.feeEvidence = { ...state.evidence, kind: "t3_burn" };
        }
      }
      if (proved) {
        meta.stage = "redeemed";
        issue = "";
      } else if (!complete(ns)) issue = "related_account_history_incomplete";
      finish(walletNode, ns, "t3_redeem", meta, proved, issue || undefined);
    }
  }
  return { operations, usedFlows };
}

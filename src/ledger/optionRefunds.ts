import type { ProjectionInput, Node, Flow } from "./project";
import {
  optionBoundary,
  type OptionLifecycleMetadata,
  type OptionLifecycleOperation,
} from "./optionLifecycle";
import { readOptionFactoryConfig } from "./optionLifecycleState";
import { readOptionPositionState } from "./optionState";
import {
  optionClaimReceipt,
  optionIngressClaimIdentity,
  optionPositionClaimIdentity,
} from "./optionLifecycleWire";
import {
  optionNodeOk as ok,
  optionRef as ref,
  optionUnique as unique,
  proveOptionCash,
} from "./optionCash";
import { NOTIFY, tokenWire, bodyCell } from "./wire";
export async function decodeOptionRefunds(
  input: ProjectionInput,
  nodes: Node[],
  flows: Flow[],
  receiptFor: (n: Node, i: number) => Node | null,
  attach: (a: Node, b: Node) => void,
) {
  const operations: OptionLifecycleOperation[] = [],
    usedFlows = new Set<string>(),
    seen = new Set<string>();
  for (const n of nodes) {
    const factory = input.optionFactories?.get(n.account),
      q = factory?.qualification;
    if (!factory || !q || !factory.walletCode || !ok(n)) continue;
    const boundary = await optionBoundary(
      input,
      n,
      q.factoryCodeHash,
      readOptionFactoryConfig,
    );
    if (
      !boundary ||
      [boundary.before, boundary.after].some(
        (s) =>
          s.vault !== factory.vault ||
          s.collateralRoot !== factory.collateralRoot ||
          s.walletCode.hash().toString("hex") !== q.walletCodeHash,
      )
    )
      continue;
    for (const claim of boundary.after.claims.values()) {
      if (
        ![1, 3].includes(claim.kind) ||
        claim.status !== 2 ||
        claim.recipient !== input.owner ||
        claim.amountRaw === "0" ||
        boundary.after.activeBuyKey !== claim.claimId
      )
        continue;
      const businessKey = `${factory.address}:${claim.identityHash}`;
      if (seen.has(businessKey)) continue;
      let seriesId: string | undefined,
        positionId: string | undefined,
        queryId: string | undefined,
        payloadHash: string | undefined,
        originalRequestBodyHash: string | undefined;
      const group: Node[] = [n],
        fundingIds: string[] = [];
      if (claim.kind === 3) {
        for (const key of boundary.after.positions.keys()) {
          const s = (key >> 64n).toString(),
            p = (key & ((1n << 64n) - 1n)).toString();
          try {
            const position = readOptionPositionState(boundary.afterBoc, s, p);
            if (
              position?.owner === claim.owner &&
              position.refundOwner === claim.recipient &&
              position.excessRaw === claim.amountRaw &&
              optionPositionClaimIdentity(
                3,
                s,
                p,
                claim.owner,
                claim.recipient,
                claim.amountRaw,
              ) === claim.identityHash
            ) {
              seriesId = s;
              positionId = p;
              break;
            }
          } catch {
            /* Unknown position data cannot establish a refund identity. */
          }
        }
        if (!seriesId || !positionId) continue;
      } else {
        const originals = nodes.filter((o) => {
          const wire = tokenWire(o.raw.inMessage);
          return (
            o.account === factory.address &&
            ok(o) &&
            BigInt(o.raw.lt) <= BigInt(n.raw.lt) &&
            wire?.op === NOTIFY &&
            wire.owner === claim.owner &&
            wire.amountRaw === claim.amountRaw &&
            optionIngressClaimIdentity(
              claim.owner,
              wire.queryId,
              claim.amountRaw,
              wire.forward.hash().toString("hex"),
            ) === claim.identityHash
          );
        });
        if (originals.length !== 1) continue;
        const original = originals[0],
          wire = tokenWire(original.raw.inMessage)!;
        const funding = flows.filter(
          (f) =>
            f.sourceAsset.owner === claim.owner &&
            f.recipientAsset.owner === factory.address &&
            f.sourceAsset.master === factory.collateralRoot &&
            f.confirmed &&
            f.wire.queryId === wire.queryId &&
            f.wire.amountRaw === claim.amountRaw &&
            f.wire.forward.hash().equals(wire.forward.hash()) &&
            f.recipient.raw.outMessages.some(
              (_, i) => receiptFor(f.recipient, i)?.id === original.id,
            ),
        );
        if (funding.length !== 1) continue;
        queryId = wire.queryId;
        payloadHash = wire.forward.hash().toString("hex");
        originalRequestBodyHash = bodyCell(funding[0].source.raw.inMessage)
          ?.hash()
          .toString("hex");
        group.push(original, funding[0].source, funding[0].recipient);
        fundingIds.push(funding[0].id);
      }
      const cash = proveOptionCash(
        input,
        factory,
        n,
        claim.recipient,
        claim.wireId,
        claim.amountRaw,
        receiptFor,
      );
      if (!cash) continue;
      const terminal = await optionBoundary(
          input,
          cash.terminal,
          q.factoryCodeHash,
          readOptionFactoryConfig,
        ),
        before = terminal?.before.claims.get(claim.claimId);
      if (
        !terminal ||
        [terminal.before, terminal.after].some(
          (s) =>
            s.vault !== factory.vault ||
            s.collateralRoot !== factory.collateralRoot ||
            s.walletCode.hash().toString("hex") !== q.walletCodeHash ||
            s.shoutCodeHash !== q.shoutCodeHash ||
            s.outperformanceCodeHash !== q.outperformanceCodeHash,
        ) ||
        !before ||
        before.kind !== claim.kind ||
        before.status !== 3 ||
        before.identityHash !== claim.identityHash ||
        before.owner !== claim.owner ||
        before.recipient !== claim.recipient ||
        before.amountRaw !== claim.amountRaw ||
        before.wireId !== claim.wireId ||
        before.finalizeWireId !== claim.wireId ||
        terminal.before.activeBuyKey !== claim.claimId ||
        terminal.after.claims.has(claim.claimId) ||
        terminal.after.claimIndex.get(BigInt("0x" + claim.identityHash)) !== 0n
      )
        continue;
      const receipts = cash.terminal.raw.outMessages.flatMap((m, i) => {
        const r = optionClaimReceipt(m),
          delivered = receiptFor(cash.terminal, i);
        return r?.claimId === claim.claimId &&
          r.identityHash === claim.identityHash &&
          r.kind === claim.kind &&
          r.wireId === claim.wireId &&
          r.amountRaw === claim.amountRaw &&
          delivered &&
          ok(delivered) &&
          delivered.account === claim.recipient
          ? [delivered]
          : [];
      });
      if (receipts.length !== 1) continue;
      group.push(...cash.nodes, ...receipts);
      if (
        unique(group).some((o) => !input.chains.get(o.account)?.historyComplete)
      )
        continue;
      const flow = flows.find(
          (f) =>
            f.source.id === cash.source.id && f.recipient.id === cash.credit.id,
        ),
        anchor = cash.credit;
      const credit =
        flow && anchor.event?.movements.find((m) => m.id === `${flow.id}:in`);
      if (!flow || !credit || !anchor.event) continue;
      seen.add(businessKey);
      usedFlows.add(flow.id);
      fundingIds.forEach((id) => usedFlows.add(id));
      credit.purpose = "option_refund";
      credit.evidence = {
        ...credit.evidence,
        ...terminal.evidence,
        kind: "option_refund",
        transactions: unique(group).map(ref),
      };
      for (const member of unique(group)) attach(anchor, member);
      const meta: OptionLifecycleMetadata = {
        factory: factory.address,
        factoryCodeHash: q.factoryCodeHash,
        vault: factory.vault,
        vaultCodeHash: q.vaultCodeHash,
        root: factory.collateralRoot,
        seriesId,
        positionId,
        owner: claim.owner,
        recipient: claim.recipient,
        originalRequestBodyHash,
        outcome: "refunded",
        payout: {
          status: "completed",
          amountRaw: claim.amountRaw,
          wireId: claim.wireId,
          sourceWallet: cash.sourceWallet,
          destinationWallet: cash.destinationWallet,
          evidence: unique(group).map(ref),
        },
        protocolAccounting: { status: "not_required" },
        refund: {
          kind: claim.kind === 1 ? "ingress" : "excess",
          scope: "individual_claim",
          claimId: claim.claimId,
          identityHash: claim.identityHash,
          queryId,
          payloadHash,
          beforeClaim: before,
        },
        positionEvidence: { ...terminal.evidence, kind: "option_refund" },
        localNetworkFees: unique(group).map((member) => ({
          transaction: ref(member),
          amountRaw: member.raw.totalFeesRaw ?? null,
          includedInOwnerFeeMovements: Boolean(member.event),
        })),
      };
      operations.push({
        anchor,
        kind: "option_refund",
        confirmed: true,
        evidence: unique(group).map(ref),
        settlement: {
          status: "confirmed",
          protocol: "options",
          operation: "option_refund",
          ...(queryId ? { queryId } : {}),
          optionLifecycle: meta,
          evidence: unique(group).map(ref),
        },
      });
    }
  }
  return { operations, usedFlows: [...usedFlows] };
}

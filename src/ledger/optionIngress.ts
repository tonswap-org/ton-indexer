import type { RawMessage } from "../data/dataSource";
import { canonicalLedgerAddress } from "./normalize";
import { bodyCell, NOTIFY, tokenWire } from "./wire";
import { optionIngressClaimIdentity, optionIngressLogicalIdentity } from "./optionLifecycleWire";

/** The full canonical notification header, not its business query, binds a credit. */
export function optionPhysicalIngress(message: RawMessage | undefined, factoryWallet: string, factory: string) {
  try {
    const body = bodyCell(message), wire = tokenWire(message);
    if (!message || !body || message.bounced || !message.createdLt ||
        canonicalLedgerAddress(message.source!) !== factoryWallet ||
        canonicalLedgerAddress(message.destination!) !== factory || wire?.op !== NOTIFY || !wire.owner) return null;
    const notificationBodyHash = body.hash().toString("hex");
    return {
      physicalIdentity: optionIngressClaimIdentity(factoryWallet, message.createdLt, notificationBodyHash),
      logicalIdentity: optionIngressLogicalIdentity(wire.owner, wire.queryId, wire.amountRaw, wire.forward.hash().toString("hex")),
      notificationCreatedLt: message.createdLt,
      notificationBodyHash,
      sourceWallet: factoryWallet,
      wire,
    };
  } catch { return null; }
}

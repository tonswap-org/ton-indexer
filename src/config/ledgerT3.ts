import type { Network } from "../models";
import { canonicalLedgerAddress } from "../ledger/normalize";
export type LedgerT3RedemptionBinding = {
  network: Network;
  hub: string;
  root: string;
  hubCodeHash: string;
  rootCodeHash: string;
  walletCodeHash: string;
  receiverCodeHash: string;
  reserveRoutes: Array<{ root: string; vault: string; discovery: string }>;
};
/** The exact qualified release manifest T3Redemption sub-object. No observed-code enrollment. */
export function parseLedgerT3RedemptionBinding(
  raw: string | undefined,
  network: Network,
): LedgerT3RedemptionBinding | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const v = JSON.parse(raw),
    keys = [
      "network",
      "hub",
      "root",
      "hubCodeHash",
      "rootCodeHash",
      "walletCodeHash",
      "receiverCodeHash",
      "reserveRoutes",
    ];
  const object = (v: any, keys: string[]) =>
    v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.keys(v).length === keys.length &&
    keys.every((k) => Object.hasOwn(v, k));
  const addr = (v: any) => {
    try {
      return typeof v === "string" && canonicalLedgerAddress(v) === v;
    } catch {
      return false;
    }
  };
  if (
    !object(v, keys) ||
    v.network !== network ||
    ![v.hub, v.root].every(addr) ||
    v.hub === v.root ||
    ![
      "hubCodeHash",
      "rootCodeHash",
      "walletCodeHash",
      "receiverCodeHash",
    ].every((k) => typeof v[k] === "string" && /^[0-9a-f]{64}$/.test(v[k])) ||
    !Array.isArray(v.reserveRoutes) ||
    v.reserveRoutes.length !== 3 ||
    v.reserveRoutes.some(
      (r: any) =>
        !object(r, ["root", "vault", "discovery"]) ||
        ![r.root, r.vault, r.discovery].every(addr) ||
        r.discovery !== r.root,
    ) ||
    new Set(v.reserveRoutes.map((r: any) => r.root)).size !== 3 ||
    new Set(v.reserveRoutes.map((r: any) => r.vault)).size !== 3
  )
    throw Error(
      "LEDGER_T3_REDEMPTION_BINDING_JSON must be the exact qualified current-network T3Redemption binding, with canonical addresses, four Cell hashes and three distinct reserve routes.",
    );
  return v;
}

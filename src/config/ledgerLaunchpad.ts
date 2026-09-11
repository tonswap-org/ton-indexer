export type LedgerLaunchpadCodeHashes = {
  fixedCodeHash: string;
  bondingCodeHash: string;
  auctionCodeHash: string;
  walletCodeHash: string;
};

/** Deployment-qualified Cell hashes; current RPC code never defines the allowlist. */
export function parseLedgerLaunchpadCodeHashes(
  raw: string | undefined,
): LedgerLaunchpadCodeHashes | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("LEDGER_LAUNCHPAD_CODE_HASHES_JSON must be valid JSON.");
  }
  const keys = ["fixedCodeHash", "bondingCodeHash", "auctionCodeHash", "walletCodeHash"];
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => {
      const hash = (value as Record<string, unknown>)[key];
      return typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash);
    })
  ) throw new Error(
    "LEDGER_LAUNCHPAD_CODE_HASHES_JSON requires exactly fixedCodeHash, bondingCodeHash, auctionCodeHash and walletCodeHash as qualified lowercase 64-character Cell hashes.",
  );
  return value as LedgerLaunchpadCodeHashes;
}

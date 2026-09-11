export type LedgerOptionsCodeHashes = {
  factoryCodeHash: string;
  vaultCodeHash: string;
  shoutCodeHash: string;
  outperformanceCodeHash: string;
  walletCodeHash: string;
};
/** Qualified current-network artifacts, never hashes inferred from current RPC code. */
export function parseLedgerOptionsCodeHashes(
  raw: string | undefined,
): LedgerOptionsCodeHashes | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = JSON.parse(raw);
  const keys = [
    "factoryCodeHash",
    "vaultCodeHash",
    "shoutCodeHash",
    "outperformanceCodeHash",
    "walletCodeHash",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some(
      (k) => typeof value[k] !== "string" || !/^[0-9a-f]{64}$/.test(value[k]),
    )
  )
    throw new Error(
      "LEDGER_OPTIONS_CODE_HASHES_JSON requires exactly five qualified lowercase 64-character Cell hashes.",
    );
  return value;
}

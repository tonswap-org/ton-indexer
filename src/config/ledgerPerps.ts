/** One qualified code hash for the current network's canonical PerpsEngine registry role. */
export function parseLedgerPerpsCodeHash(
  raw: string | undefined,
): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  if (!/^[0-9a-f]{64}$/.test(raw))
    throw new Error(
      "LEDGER_PERPS_ENGINE_CODE_HASH must be exactly 64 lowercase hexadecimal characters.",
    );
  return raw;
}

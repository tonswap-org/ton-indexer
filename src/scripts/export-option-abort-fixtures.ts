// Canonical cross-service fixtures: decode archived cells and physical messages,
// never hand-label a committed deposit as orphan custody. Explicit output only.
import { writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { abortFixture } from "./ledger-option-abort-test";
import { bounceFixture } from "./ledger-option-buy-bounce-test";
import { projectOwnerLedger } from "../ledger/project";
import { owner, factory, vault, root, series, ownerWallet, factoryWallet, vaultWallet, premium, collateral, q } from "./ledger-option-lifecycle-test";
async function main() {
  const destination = process.argv[2];
  if (!destination) throw Error("An explicit fixture output directory is required");
  await mkdir(destination, { recursive: true });
  const cases: Array<[string, ReturnType<typeof abortFixture>]> = [
    ["factory", abortFixture(false)], ["partial", abortFixture(true, 1, false, true)],
    ["split", abortFixture(true)],
    ["committed-interleaved", abortFixture(true, 1, true, true, "committed", undefined, true)],
  ];
  for (const status of ["failed", "unobserved"] as const) {
    for (const [name, vaultPaid, factoryPaid] of [
      ["split", true, true], ["factory", false, true],
      ["vault", true, false], ["pending", false, false],
    ] as const) cases.push([`orphan-${status}-${name}`, abortFixture(true, 1, vaultPaid, factoryPaid, status)]);
    cases.push([`orphan-${status}-existing-bucket`, abortFixture(true, 1, true, true, status, { locked: 987654321n, premium: 321n })]);
    cases.push([`orphan-${status}-interleaved`, abortFixture(true, 1, true, true, status, undefined, true)]);
  }
  const manifest = [];
  for (const [name, f] of cases) {
    const events = (await projectOwnerLedger(f.input)).events;
    const e = events.find(e => e.settlement?.optionLifecycle?.refund?.kind === "aborted_buy");
    if (!e) throw Error(`No decoded abort: ${name}`);
    const data = JSON.stringify({ scope: {
      network: "testnet", owner, factory, vault, root, series, seriesId: "7", positionId: "3",
      ownerWallet, factoryWallet, vaultWallet, queryId: "1234", amountRaw: f.amount.toString(),
      premiumRaw: premium.toString(), protocolFeeRaw: "20", excessRaw: "17", collateralRaw: collateral.toString(),
      codeHashes: q, originalRequestBodyBoc: f.request.body, abortRequestBodyBoc: f.abortRequest.body,
    }, events }, null, 2) + "\n";
    const file = `option-abort-${name}.json`;
    await writeFile(join(destination, file), data);
    manifest.push({ file, sha256: createHash("sha256").update(data).digest("hex"), status: e.settlement!.status,
      commitStatus: e.settlement!.optionLifecycle!.refund!.unwind!.commit?.status ?? null,
      cashMovements: e.movements.filter(m => m.purpose === "option_refund").map(m => m.amountRaw),
    });
  }
  for (const kind of [1, 2] as const) for (const paid of [true, false]) {
    const f = bounceFixture(kind, paid), events = (await projectOwnerLedger(f.input)).events,
      e = events.find(e => e.settlement?.optionLifecycle?.refund?.unwind?.trigger.kind === "initial_series_buy_bounced");
    if (!e) throw Error(`No decoded initial bounce: ${kind}/${paid}`);
    const data = JSON.stringify({ scope: {
      network: "testnet", owner, factory, vault, root, series, seriesId: "7", positionId: "3",
      ownerWallet, factoryWallet, vaultWallet, queryId: "1234", amountRaw: f.amount.toString(),
      premiumRaw: premium.toString(), protocolFeeRaw: "20", excessRaw: "17", collateralRaw: collateral.toString(),
      codeHashes: q, originalRequestBodyBoc: f.request.body,
      originalAssignedBodyBoc: f.assigned.body, bounceBodyBoc: f.bounce.body,
    }, events }, null, 2) + "\n";
    const file = `option-buy-bounce-${kind === 1 ? "shout" : "outperformance"}-${paid ? "complete" : "pending"}.json`;
    await writeFile(join(destination, file), data);
    manifest.push({ file, sha256: createHash("sha256").update(data).digest("hex"), status: e.settlement!.status,
      commitStatus: null, cashMovements: e.movements.filter(m => m.purpose === "option_refund").map(m => m.amountRaw) });
  }
  await writeFile(join(destination, "option-abort-provenance.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify(manifest, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });

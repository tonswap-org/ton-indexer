import assert from "node:assert/strict";
import { beginCell, Cell } from "@ton/core";
import { PGlite } from "@electric-sql/pglite";
import type { TonDataSource } from "../data/dataSource";
import { PostgresLedgerStore, type LedgerSqlPool } from "../ledger/store";
import { LedgerService } from "../ledger/service";
import { createLogger } from "../utils/logger";
import { loadOpcodes } from "../utils/opcodes";
import type { fixture } from "./ledger-option-lifecycle-test";
import {
  A,
  owner,
  other,
  factory,
  vault,
  root,
  series,
  wallet,
  ownerWallet,
  factoryWallet,
  vaultWallet,
  factoryCode,
  vaultCode,
  shoutCode,
  spreadCode,
  walletCode,
  q,
  boc,
} from "./ledger-option-lifecycle-test";

export async function durableOptionAbort(
  f: Pick<ReturnType<typeof fixture>, "input" | "states">,
  pendingThroughLt: string,
  kind: 1 | 2,
) {
  const db = new PGlite();
  const pool: LedgerSqlPool = {
    query: async (sql, params) =>
      !params && sql.includes(";")
        ? { rows: (await db.exec(sql)).at(-1)?.rows ?? [] }
        : db.query(sql, params),
    connect: async () => pool,
    end: () => db.close(),
  };
  const store = new PostgresLedgerStore(pool);
  let paid = false;
  const history = (account: string) =>
    (f.input.chains.get(account)?.transactions ?? []).filter(
      (t) => paid || BigInt(t.lt) <= BigInt(pendingThroughLt),
    );
  const code = (account: string) =>
    account === factory
      ? factoryCode
      : account === vault
        ? vaultCode
        : account === series
          ? kind === 1 ? shoutCode : spreadCode
          : walletCode;
  const stateAtSeq = (account: string, seqno = 1000) => {
    const txs = history(account).filter((t) => BigInt(t.lt) <= BigInt(seqno)),
      latest = txs.at(-1),
      data = txs
        .slice()
        .reverse()
        .map((t) => f.states.get(`${account}:${t.lt}`)?.data)
        .find(Boolean);
    return {
      accountState: "active" as const,
      balance: "0",
      lastTxLt: latest?.lt,
      lastTxHash: latest?.hash,
      codeBoc: boc(code(account)),
      dataBoc: data && boc(data),
    };
  };
  const int = (v: number) => ({ type: "int" as const, value: BigInt(v) }),
    cell = (a: string) => ({
      type: "slice" as const,
      cell: beginCell().storeAddress(A(a)).endCell(),
    });
  const source: TonDataSource = {
    network: "testnet",
    getMasterchainInfo: async () => ({ seqno: 1000 }),
    getAccountState: async (a) => stateAtSeq(a),
    getAccountStateAtSeqno: async (a, s) => stateAtSeq(a, s),
    getTransactions: async (a, limit, lt) =>
      history(a)
        .filter((t) => BigInt(t.lt) <= BigInt(lt!))
        .slice()
        .reverse()
        .slice(0, limit),
    getJettonBalance: async (p, m) =>
      m === root && [owner, other, factory, vault].includes(p)
        ? { wallet: wallet(p), balance: "0" }
        : null,
    getJettonMetadata: async () => ({ decimals: 9 }),
    close: async () => {},
    runGetMethod: async (account, method) => {
      const asset = f.input.wallets.get(account);
      if (method === "get_wallet_data" && asset)
        return {
          exitCode: 0,
          stack: [
            int(0),
            cell(asset.owner!),
            cell(root),
            { type: "cell", cell: walletCode },
          ],
        };
      if (account === factory && method === "factory_config") {
        const stack: any[] = Array.from({ length: 13 }, () => int(0));
        stack[1] = cell(vault);
        stack[4] = { type: "cell", cell: shoutCode };
        stack[5] = { type: "cell", cell: spreadCode };
        stack[6] = cell(root);
        stack[7] = { type: "cell", cell: walletCode };
        return { exitCode: 0, stack };
      }
      if (account === factory && method === "series_info") {
        const stack: any[] = Array.from({ length: 18 }, () => int(0));
        stack[0] = int(-1);
        stack[2] = int(kind);
        stack[3] = cell(series);
        return { exitCode: 0, stack };
      }
      if (method === "position_info")
        throw Error("Latest getter cannot prove an aborted purchase");
      return null;
    },
  };
  const service = new LedgerService(
    "testnet",
    store,
    source,
    loadOpcodes(),
    createLogger("silent"),
    2,
    {
      jettonRoots: [root],
      t3Root: root,
      optionFactory: factory,
      optionVault: vault,
      optionCodeHashes: q,
    },
  );
  try {
    await store.initialize();
    await service.syncAccount(owner);
    const pending = await store.page("testnet", owner),
      p = pending.events.find(
        (e) => e.settlement?.optionLifecycle?.refund?.kind === "aborted_buy",
      );
    assert.equal(
      pending.coverage.historyComplete,
      true,
      JSON.stringify(pending.coverage),
    );
    assert.equal(p?.settlement?.status, "incomplete", JSON.stringify(pending));
    assert.equal(
      p.settlement.optionLifecycle?.refund?.unwind?.factoryReturn.status,
      "pending",
    );
    paid = true;
    await service.syncAccount(owner);
    const completed = await store.page("testnet", owner),
      e = completed.events.find(
        (e) => e.settlement?.optionLifecycle?.refund?.kind === "aborted_buy",
      );
    assert.equal(completed.coverage.historyComplete, true);
    assert.equal(e?.settlement?.status, "confirmed", JSON.stringify(completed));
    assert.equal(
      e.id,
      p.id,
      "pending refund upgrades the same original purchase event",
    );
    assert.notEqual(completed.coverage.generation, pending.coverage.generation);
    for (const account of [ownerWallet, factoryWallet, vaultWallet, series])
      assert(
        completed.coverage.relatedAccounts?.some(
          (a) => a.account === account && a.historyComplete,
        ),
      );
    const count = async () =>
      (
        await pool.query(
          "SELECT (SELECT count(*) FROM ledger_runs)::text AS runs,(SELECT count(*) FROM ledger_membership)::text AS members,(SELECT count(*) FROM ledger_projection_events)::text AS events",
        )
      ).rows;
    const before = await count();
    await service.syncAccount(owner);
    assert.deepEqual(
      await count(),
      before,
      "unchanged complete dependency heads reuse one published generation",
    );
    assert.deepEqual(
      (await store.page("testnet", owner)).events,
      completed.events,
    );
    await pool.query("DELETE FROM ledger_account_states");
    await service.syncAccount(owner);
    assert.deepEqual(
      (await store.page("testnet", owner)).events,
      completed.events,
      "cold archive rebuild preserves original allocation and actual refunds",
    );
  } finally {
    await service.stop();
    await pool.end();
  }
}

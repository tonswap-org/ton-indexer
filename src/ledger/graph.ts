import type { LedgerPerpsEngine } from "./perps";
import type { LedgerLaunchpadSale } from "./launchpadModels";
import type { LedgerLaunchpadCodeHashes } from "../config/ledgerLaunchpad";
import { readFixedSaleState } from "./launchpadState";
import { readBondingSaleState } from "./launchpadBondingState";
import { readAuctionSaleState } from "./launchpadAuctionState";
import { readPerpsState } from "./perpsState";
import { PERPS_ORACLE_PULL, perpsOracleMessage, perpsWalletAddress } from "./perpsWire";
import { type LedgerT3Hub } from "./t3";
import { receiverAddress, t3State, burnRequest, MINT_INTERNAL } from "./t3Wire";
import { optionBuyForward, type LedgerOptionFactory } from "./options";
import { optionExercise, optionVaultPayout } from "./optionLifecycleWire";
import { optionOwnerAbort } from "./optionAbortWire";
import { readOptionFactoryConfig } from "./optionLifecycleState";
import type { LedgerOptionsCodeHashes } from "../config/ledgerOptions";
import { Address, Cell, beginCell } from "@ton/core";
import type { TonDataSource } from "../data/dataSource";
import type { Network } from "../models";
import type { LedgerAsset, LedgerRelatedAccount } from "./types";
import type { LedgerChain, LedgerPool, ProjectionInput } from "./project";
import { PostgresLedgerStore } from "./store";
import { canonicalLedgerAddress, canonicalLedgerHash } from "./normalize";
import {
  INTERNAL,
  NOTIFY,
  REMOVE,
  COLLECT,
  COLLECT_TO,
  collectionRequest,
  withdrawalRequest,
  SETTLEMENT_INTERNAL,
  TRANSFER,
  opcode,
  businessOpcode,
  protocolForward,
  unresolvedLaunchpadForward,
  tokenWire,
} from "./wire";
import { findTransactionState, type LedgerStateSnapshot } from "./archive";
const addr = (value?: string) => {
  try {
    return value ? canonicalLedgerAddress(value) : null;
  } catch {
    return null;
  }
};
const stackAddress = (item: any) => {
  try {
    if (!item || !["cell", "slice", "builder"].includes(item.type)) return null;
    const s = item.cell.beginParse();
    const result = s.loadAddress().toRawString();
    return s.remainingBits || s.remainingRefs ? null : result;
  } catch {
    return null;
  }
};
export class LedgerGraphBuilder {
  constructor(
    private network: Network,
    private source: TonDataSource,
    private store: PostgresLedgerStore,
    private roots: string[],
    private registry: string | undefined,
    private resolveJetton: (wallet: string) => Promise<LedgerAsset | null>,
    private crawl: (account: string) => Promise<unknown>,
    private maxAccounts = 256,
    private optionFactory?: string,
    private t3Hub?: string,
    private t3Root?: string,
    private perpsEngine?: string,
    private perpsEngineCodeHash?: string,
    private optionVault?: string,
    private optionCodeHashes?: LedgerOptionsCodeHashes,
    private t3RedemptionBinding?: import("../config/ledgerT3").LedgerT3RedemptionBinding,
    private launchpadCodeHashes?: LedgerLaunchpadCodeHashes,
    private launchpadControllers: string[] = [],
  ) {}
  async build(owner: string, generation: string, ownerCheckedAt?: string) {
    const chains = new Map<string, LedgerChain>(),
      wallets = new Map<string, LedgerAsset>(),
      pools = new Map<string, LedgerPool>(),
      optionFactories = new Map<string, LedgerOptionFactory>(),
      launchpadSales = new Map<string, LedgerLaunchpadSale>(),
      perpsEngines = new Map<string, LedgerPerpsEngine>(),
      t3Hubs = new Map<string, LedgerT3Hub>(),
      issues = new Set<string>();
    const load = async (
      account: string,
      role: LedgerRelatedAccount["role"],
      knownGeneration?: string,
    ) => {
      if (chains.has(account)) {
        if (role === "owned_jetton_wallet") chains.get(account)!.role = role;
        return;
      }
      if (chains.size >= this.maxAccounts) {
        issues.add("related_account_limit_reached");
        return;
      }
      // Insert before awaiting, so cycles and repeated addresses cannot trigger recursion.
      const chain: LedgerChain = {
        account,
        generation: null,
        historyComplete: false,
        role,
        transactions: [],
      };
      chains.set(account, chain);
      try {
        const crawled = knownGeneration ? true : await this.crawl(account);
        const state = await this.store.account(this.network, account);
        chain.generation =
          knownGeneration ??
          state?.current_generation ??
          state?.latest_generation ??
          null;
        const run = chain.generation
          ? (
              await this.store.pool.query(
                "SELECT complete,head_observed_at,verified_through FROM ledger_runs WHERE generation=$1",
                [chain.generation],
              )
            ).rows[0]
          : null;
        // The owner's run is still open while its projection is built, but its physical chain was verified.
        chain.historyComplete =
          Boolean(knownGeneration || run?.complete) &&
          !state?.error_code &&
          (Boolean(knownGeneration) || (crawled === true && !state?.syncing));
        chain.checkedAt = knownGeneration
          ? (ownerCheckedAt ??
            (run?.head_observed_at
              ? new Date(run.head_observed_at).toISOString()
              : null))
          : state?.checked_at
            ? new Date(state.checked_at).toISOString()
            : null;
        if (!chain.historyComplete)
          issues.add("related_account_history_incomplete");
        if (chain.generation)
          chain.transactions = (
            await this.store.rawHistory(chain.generation)
          ).map((item) => item.raw);
      } catch {
        issues.add("related_account_history_incomplete");
      }
    };
    const wallet = async (
      value: string,
      role: LedgerRelatedAccount["role"],
    ) => {
      const canonical = addr(value);
      if (!canonical) return null;
      const identity = await this.resolveJetton(canonical);
      if (!identity) return null;
      wallets.set(canonical, identity);
      await load(
        canonical,
        identity.owner === owner ? "owned_jetton_wallet" : role,
      );
      return identity;
    };
    const ownerWallet = async (root: string) => {
      const balance = await this.source
        .getJettonBalance(owner, root)
        .catch(() => null);
      if (balance) {
        if (!(await wallet(balance.wallet, "owned_jetton_wallet")))
          issues.add("configured_wallet_discovery_unresolved");
        return;
      }
      // A canonical root can identify a wallet that has never been deployed.
      // Absence is certified only by an explicit uninitialized, history-free state.
      try {
        const result = await this.source.runGetMethod(
          root,
          "get_wallet_address",
          [
            {
              type: "slice",
              cell: beginCell().storeAddress(Address.parse(owner)).endCell(),
            },
          ],
        );
        const derived =
          result?.exitCode === 0 && result.stack.length === 1
            ? stackAddress(result.stack[0])
            : null;
        const state = derived
          ? await this.source.getAccountState(derived)
          : null;
        if (
          derived &&
          state?.accountState === "uninitialized" &&
          (!state.lastTxLt || state.lastTxLt === "0")
        ) {
          await load(derived, "owned_jetton_wallet");
          return;
        }
      } catch {
        /* Provider or identity failures remain explicit discovery gaps. */
      }
      issues.add("configured_wallet_discovery_unresolved");
    };
    await load(owner, "owner", generation);
    for (const root of new Set([
      ...this.roots,
      ...(this.t3Root ? [this.t3Root] : []),
    ]))
      await ownerWallet(root);
    const candidates = new Set<string>();
    const launchpadCandidates = new Set<string>();
    const knownLaunchpadControllers = new Set(
      this.launchpadControllers.map((value) => addr(value)).filter((value): value is string => Boolean(value)),
    );
    const optionIds = new Set<string>(),
      configuredOptionFactory = addr(this.optionFactory);
    for (const tx of chains.get(owner)!.transactions) {
      for (const msg of [tx.inMessage, ...tx.outMessages]) {
        if (!msg) continue;
        const op = businessOpcode(msg);
        if (op === 0x434c414d && addr(msg.source) === owner && msg.destination) {
          const target = addr(msg.destination);
          if (target) {
            launchpadCandidates.add(target);
            knownLaunchpadControllers.add(target);
          }
        }
        const exercise = optionExercise(msg) ?? optionOwnerAbort(msg);
        if (
          exercise &&
          addr(msg.destination) === configuredOptionFactory &&
          addr(msg.source) === owner
        )
          optionIds.add(exercise.seriesId);
        if (
          op === TRANSFER &&
          addr(msg.source) === owner &&
          msg.destination
        )
          await wallet(msg.destination, "owned_jetton_wallet");
        if (op === NOTIFY && addr(msg.destination) === owner && msg.source)
          await wallet(msg.source, "owned_jetton_wallet");
        if ([REMOVE, COLLECT, COLLECT_TO].includes(op!) && addr(msg.source) === owner && msg.destination)
          candidates.add(addr(msg.destination)!);
      }
    }
    const inspected = new Set<string>();
    const inspectOwned = async () => {
      for (const chain of [...chains.values()])
        if (
          chain.role === "owned_jetton_wallet" &&
          !inspected.has(chain.account)
        ) {
          inspected.add(chain.account);
          for (const tx of chain.transactions) {
            const request = tokenWire(tx.inMessage);
            const option = request ? optionBuyForward(request.forward) : null;
            if (
              option &&
              option.owner === owner &&
              request?.owner === configuredOptionFactory
            )
              optionIds.add(option.seriesId);
            if (
              request?.op === TRANSFER && request.owner &&
              unresolvedLaunchpadForward(request.forward)
            ) {
              launchpadCandidates.add(request.owner);
              knownLaunchpadControllers.add(request.owner);
            }
            if (
              request?.op === TRANSFER &&
              request.owner &&
              protocolForward(request.forward)
            )
              candidates.add(request.owner);
            for (const msg of [tx.inMessage, ...tx.outMessages]) {
              if (!msg) continue;
              const wire = tokenWire(msg);
              if (!wire || ![INTERNAL, SETTLEMENT_INTERNAL].includes(wire.op))
                continue;
              const counterpart =
                addr(msg.source) === chain.account
                  ? addr(msg.destination)
                  : addr(msg.source);
              if (
                counterpart &&
                counterpart !== wallets.get(chain.account)?.master
              )
                await wallet(counterpart, "counterparty");
            }
          }
        }
    };
    await inspectOwned();
    // Empty-payload refunds are discovered from the independently resolved source
    // wallet owner. Only deployment-qualified model code enables its decoder.
    if (this.launchpadCodeHashes) {
      for (const identity of wallets.values())
        if (identity.owner && identity.owner !== owner)
          launchpadCandidates.add(identity.owner);
    }
    if (launchpadCandidates.size > this.maxAccounts)
      issues.add("launchpad_discovery_limit_reached");
    for (const sale of [...launchpadCandidates].slice(0, this.maxAccounts)) {
      if (knownLaunchpadControllers.has(sale)) await load(sale, "counterparty");
      if (!this.launchpadCodeHashes) continue;
      try {
        const current = await this.source.getAccountState(sale);
        const saleCodeHash = current?.codeBoc ? Cell.fromBase64(current.codeBoc).hash().toString("hex") : null;
        const models = (["fixed", "bonding", "auction"] as const).filter(model =>
          saleCodeHash === this.launchpadCodeHashes![`${model}CodeHash`]);
        if (!current?.dataBoc || models.length !== 1) {
          if (knownLaunchpadControllers.has(sale)) issues.add("launchpad_code_unqualified");
          continue;
        }
        knownLaunchpadControllers.add(sale);
        await load(sale, "counterparty");
        const model = models[0]!;
        const state = model === "fixed" ? readFixedSaleState(current.dataBoc)
          : model === "bonding" ? readBondingSaleState(current.dataBoc) : readAuctionSaleState(current.dataBoc);
        const routing = state.paymentRouting;
        if (!routing.tokenRoot || !routing.wallet || !routing.walletCodeBoc ||
          routing.walletCodeHash !== this.launchpadCodeHashes.walletCodeHash)
          throw new Error("Unqualified Launchpad payment routing");
        const paymentWalletCode = Cell.fromBase64(routing.walletCodeBoc);
        if (perpsWalletAddress(paymentWalletCode, routing.tokenRoot, sale) !== routing.wallet)
          throw new Error("Launchpad payment wallet derivation mismatch");
        const identity = await wallet(routing.wallet, "counterparty");
        if (identity?.owner !== sale || identity.master !== routing.tokenRoot)
          throw new Error("Launchpad payment wallet identity mismatch");
        await ownerWallet(routing.tokenRoot);
        launchpadSales.set(sale, {
          model,
          address: sale, factory: state.registry.factory,
          paymentRoot: routing.tokenRoot, paymentWallet: routing.wallet,
          paymentWalletCode, saleCodeHash: saleCodeHash!,
        });
      } catch {
        if (knownLaunchpadControllers.has(sale)) issues.add("launchpad_identity_unresolved");
      }
    }
    await inspectOwned();
    if (configuredOptionFactory && this.optionCodeHashes) {
      await load(configuredOptionFactory, "counterparty");
      if (this.optionVault)
        await load(canonicalLedgerAddress(this.optionVault), "counterparty");
      for (const tx of chains.get(configuredOptionFactory)?.transactions ??
        []) {
        for (const message of [tx.inMessage, ...tx.outMessages]) {
          const exercise = optionExercise(message),
            payout = optionVaultPayout(message);
          if (
            exercise &&
            addr(message?.source) === owner
          )
            optionIds.add(exercise.seriesId);
          if (payout?.recipient === owner) optionIds.add(payout.seriesId);
          const abort = optionOwnerAbort(message);
          if (abort && addr(message?.source) === owner)
            optionIds.add(abort.seriesId);
        }
      }
      // Latest positions are discovery hints only; retirement/refund attribution uses archive boundaries.
      try {
        const state = await this.source.getAccountState(
          configuredOptionFactory,
        );
        if (state.dataBoc)
          for (const [key, value] of readOptionFactoryConfig(state.dataBoc)
            .positions) {
            if (value.beginParse().loadAddress().toRawString() === owner)
              optionIds.add((key >> 64n).toString());
          }
      } catch {
        /* Exact individual messages still identify lifecycle series. */
      }
    }
    for (const candidate of candidates) {
      const pool = await this.loadPool(candidate).catch(() => null);
      if (!pool) {
        issues.add("protocol_pool_identity_unresolved");
        continue;
      }
      pools.set(candidate, pool);
      await load(candidate, "pool");
      for (const root of [pool.tokenT, pool.tokenX]) {
        const balance = await this.source
          .getJettonBalance(candidate, root)
          .catch(() => null);
        if (balance) await wallet(balance.wallet, "counterparty");
        else issues.add("pool_wallet_identity_unresolved");
        await ownerWallet(root);
        // A requested recipient identifies a discovery target, never ownership
        // or proof of payout. Historical code and message receipts qualify it.
        const recipients = new Set((chains.get(candidate)?.transactions ?? []).flatMap(tx => {
          if (addr(tx.inMessage?.source) !== owner) return [];
          const request = withdrawalRequest(tx.inMessage) ?? collectionRequest(tx.inMessage);
          return request && request.recipient !== owner ? [request.recipient] : [];
        }));
        for (const recipient of recipients) {
          // A zero payout does not deploy a recipient wallet. Follow actual
          // positive dispatches for this root; historical settlement proof still
          // decides whether a requested collection executed and fully paid.
          const dispatched = (chains.get(candidate)?.transactions ?? []).some(tx => tx.success && tx.outMessages.some(message => {
            if (message.bounced || addr(message.source) !== candidate || addr(message.destination) !== addr(balance?.wallet)) return false;
            const transfer = tokenWire(message);
            return transfer?.op === TRANSFER && transfer.owner === recipient && BigInt(transfer.amountRaw) > 0n;
          }));
          if (!dispatched) continue;
          const delivered = await this.source.getJettonBalance(recipient, root).catch(() => null);
          const identity = delivered ? await wallet(delivered.wallet, "counterparty") : null;
          if (!identity || identity.owner !== recipient || identity.master !== root) issues.add("dlmm_recipient_wallet_unresolved");
        }
      }
    }
    await inspectOwned();
    if (configuredOptionFactory && (optionIds.size || this.optionCodeHashes)) {
      try {
        const config = await this.source.runGetMethod(
          configuredOptionFactory,
          "factory_config",
        );
        const collateralRoot =
          config?.exitCode === 0 && config.stack.length === 13
            ? stackAddress(config.stack[6])
            : null;
        if (!collateralRoot || !config)
          throw new Error("Option factory identity");
        const factoryState = await this.source.getAccountState(
          configuredOptionFactory,
        );
        if (factoryState.accountState !== "active" || !factoryState.codeBoc)
          throw Error("Option factory code unavailable");
        const factory: LedgerOptionFactory = {
          address: configuredOptionFactory,
          collateralRoot,
          series: new Map(),
          codeHash: Cell.fromBase64(factoryState.codeBoc)
            .hash()
            .toString("hex"),
        };
        const q = this.optionCodeHashes,
          vaultAddress = stackAddress(config.stack[1]),
          walletCode = config.stack[7];
        if (q) {
          if (
            factory.codeHash !== q.factoryCodeHash ||
            collateralRoot !== addr(this.t3Root) ||
            vaultAddress !== addr(this.optionVault) ||
            !vaultAddress ||
            walletCode?.type !== "cell" ||
            walletCode.cell.hash().toString("hex") !== q.walletCodeHash ||
            config.stack[4]?.type !== "cell" ||
            config.stack[4].cell.hash().toString("hex") !== q.shoutCodeHash ||
            config.stack[5]?.type !== "cell" ||
            config.stack[5].cell.hash().toString("hex") !==
              q.outperformanceCodeHash
          )
            throw Error("Qualified option code/config mismatch");
          const vaultState = await this.source.getAccountState(vaultAddress);
          if (
            vaultState.accountState !== "active" ||
            !vaultState.codeBoc ||
            Cell.fromBase64(vaultState.codeBoc).hash().toString("hex") !==
              q.vaultCodeHash
          )
            throw Error("Qualified option vault mismatch");
          factory.qualification = q;
          factory.vault = vaultAddress;
          factory.walletCode = walletCode.cell;
          await load(vaultAddress, "counterparty");
          const parties = new Set([factory.address, vaultAddress, owner]);
          for (const tx of chains.get(factory.address)?.transactions ?? [])
            for (const message of tx.outMessages) {
              const payout = optionVaultPayout(message);
              if (payout && optionIds.has(payout.seriesId))
                parties.add(payout.recipient);
            }
          for (const party of parties) {
            const balance = await this.source
              .getJettonBalance(party, collateralRoot)
              .catch(() => null);
            if (!balance) {
              issues.add("option_custody_wallet_identity_unresolved");
              continue;
            }
            const identity = await wallet(
              balance.wallet,
              party === owner ? "owned_jetton_wallet" : "counterparty",
            );
            const state = await this.source.getAccountState(balance.wallet);
            if (
              !identity ||
              identity.master !== collateralRoot ||
              identity.owner !== party ||
              !state.codeBoc ||
              Cell.fromBase64(state.codeBoc).hash().toString("hex") !==
                q.walletCodeHash
            ) {
              issues.add("option_custody_wallet_identity_unresolved");
              continue;
            }
            if (party === factory.address)
              factory.factoryWallet = canonicalLedgerAddress(balance.wallet);
            if (party === vaultAddress)
              factory.vaultWallet = canonicalLedgerAddress(balance.wallet);
          }
        } else issues.add("option_qualified_code_unavailable");
        await load(configuredOptionFactory, "counterparty");
        for (const seriesId of optionIds) {
          const info = await this.source.runGetMethod(
            configuredOptionFactory,
            "series_info",
            [{ type: "int", value: BigInt(seriesId) }],
          );
          if (
            !info ||
            info.exitCode !== 0 ||
            info.stack.length !== 18 ||
            info.stack[0].type !== "int" ||
            info.stack[0].value === 0n ||
            info.stack[2].type !== "int"
          )
            continue;
          const kind = Number(info.stack[2].value),
            seriesAddress = stackAddress(info.stack[3]),
            expected = config.stack[kind === 1 ? 4 : 5];
          if (
            !seriesAddress ||
            (kind !== 1 && kind !== 2) ||
            !expected ||
            expected.type !== "cell"
          )
            continue;
          const state = await this.source.getAccountState(seriesAddress);
          if (
            state.accountState !== "active" ||
            !state.codeBoc ||
            !Cell.fromBase64(state.codeBoc).hash().equals(expected.cell.hash())
          )
            continue;
          factory.series.set(seriesId, { address: seriesAddress, kind });
          await load(seriesAddress, "counterparty");
        }
        optionFactories.set(configuredOptionFactory, factory);
      } catch {
        issues.add("option_factory_identity_unresolved");
      }
    }
    const t3Address = addr(this.t3Hub),
      t3Root = addr(this.t3Root);
    if (t3Address && t3Root) {
      // Detect owned transaction evidence before optional state discovery. A
      // receiver lookup failure must not silently hide an already delivered mint.
      let relevant = [...chains.values()].some(
        (chain) => (chain.role === "owner" || chain.role === "owned_jetton_wallet") &&
          chain.transactions.some((tx) => [tx.inMessage, ...tx.outMessages].some(
            (message) => burnRequest(message) || opcode(message) === MINT_INTERNAL ||
              tokenWire(message)?.owner === t3Address ||
              addr(message?.destination) === t3Address,
          )),
      );
      try {
        const routes = await this.source.runGetMethod(
            t3Address,
            "vault_routes",
          ),
          vaultResult = await this.source.runGetMethod(
            t3Address,
            "vault_addresses",
          );
        if (
          routes?.exitCode !== 0 ||
          routes.stack.length !== 17 ||
          routes.stack[1].type !== "cell" ||
          vaultResult?.exitCode !== 0 ||
          vaultResult.stack.length !== 3
        )
          throw Error("T3 routes");
        const reserveRoots = [2, 7, 12].map((i) =>
            stackAddress(routes.stack[i]),
          ),
          vaults = vaultResult.stack.map(stackAddress);
        if (
          reserveRoots.some((r) => !r) ||
          vaults.some((r) => !r) ||
          new Set(reserveRoots).size !== 3
        )
          throw Error("T3 roots");
        const receiver = receiverAddress(
            routes.stack[1].cell,
            t3Address,
            owner,
          ),
          receiverState = await this.source.getAccountState(receiver).catch(() => null);
        relevant ||= receiverState?.accountState === "active";
        if (relevant) {
          const hubState = await this.source.getAccountState(t3Address),
            emitter = await this.source.runGetMethod(t3Root, "root_emitter");
          if (
            hubState.accountState !== "active" ||
            !hubState.codeBoc ||
            !hubState.dataBoc ||
            t3State(hubState.dataBoc).root !== t3Root ||
            emitter?.exitCode !== 0 ||
            emitter.stack.length !== 1 ||
            stackAddress(emitter.stack[0]) !== t3Address
          )
            throw Error("T3 hub/root identity");
          const hub: LedgerT3Hub = {
            address: t3Address,
            root: t3Root,
            codeHash: Cell.fromBase64(hubState.codeBoc).hash().toString("hex"),
            reserveRoots: reserveRoots as string[],
            vaults: vaults as string[],
            redemptions: new Map(),
          };
          const binding=this.t3RedemptionBinding;
          if(binding){
            const rootState=await this.source.getAccountState(t3Root);
            if(binding.network!==this.network||binding.hub!==t3Address||binding.root!==t3Root||binding.hubCodeHash!==hub.codeHash||!rootState.codeBoc||Cell.fromBase64(rootState.codeBoc).hash().toString('hex')!==binding.rootCodeHash||routes.stack[1].cell.hash().toString('hex')!==binding.receiverCodeHash||binding.reserveRoutes.some((r,i)=>r.root!==hub.reserveRoots[i]||r.vault!==hub.vaults[i]||r.discovery!==r.root))issues.add('t3_recovery_binding_mismatch');
            else hub.redemptionBinding=binding;
          }
          await load(t3Address, "counterparty");
          await load(t3Root, "counterparty");
          for (let i = 0; i < 3; i++) {
            const a = await wallet(hub.vaults[i], "counterparty");
            if (a?.owner !== t3Address || a.master !== hub.reserveRoots[i])
              throw Error("T3 vault identity");
            await ownerWallet(hub.reserveRoots[i]);
          }
          if (!receiverState) issues.add("t3_receiver_state_unavailable");
          if (receiverState?.accountState === "active") {
            const identity = await this.source.runGetMethod(
              receiver,
              "receiver_identity",
            );
            if (
              !receiverState.codeBoc ||
              !Cell.fromBase64(receiverState.codeBoc)
                .hash()
                .equals(routes.stack[1].cell.hash()) ||
              identity?.exitCode !== 0 ||
              identity.stack.length !== 3 ||
              identity.stack[0].type !== "int" ||
              identity.stack[0].value !== 1n ||
              stackAddress(identity.stack[1]) !== t3Address ||
              stackAddress(identity.stack[2]) !== owner
            )
              throw Error("T3 receiver identity");
            hub.receiver = receiver;
            await load(receiver, "controlled_contract");
            for (const root of hub.reserveRoots) {
              const b = await this.source
                .getJettonBalance(receiver, root)
                .catch(() => null);
              if (b) {
                const a = await wallet(b.wallet, "owned_jetton_wallet");
                if (a?.owner !== receiver || a.master !== root)
                  throw Error("T3 receiver wallet identity");
                wallets.set(a.wallet!, {
                  ...a,
                  controller: owner,
                  custody: "t3_receiver",
                });
              } else {
                const derived = await this.source.runGetMethod(
                  root,
                  "get_wallet_address",
                  [
                    {
                      type: "slice",
                      cell: beginCell()
                        .storeAddress(Address.parse(receiver))
                        .endCell(),
                    },
                  ],
                );
                const address =
                  derived?.exitCode === 0 && derived.stack.length === 1
                    ? stackAddress(derived.stack[0])
                    : null;
                const state = address
                  ? await this.source.getAccountState(address)
                  : null;
                if (
                  !address ||
                  state?.accountState !== "uninitialized" ||
                  (state.lastTxLt && state.lastTxLt !== "0")
                )
                  issues.add("t3_receiver_wallet_discovery_unresolved");
                else await load(address, "owned_jetton_wallet");
              }
            }
          }
          for (const c of chains.values())
            if (
              wallets.get(c.account)?.owner === owner &&
              wallets.get(c.account)?.master === t3Root
            )
              for (const tx of c.transactions) {
                const r = burnRequest(tx.inMessage);
                if (
                  !r ||
                  r.response !== t3Address ||
                  hub.redemptions.has(r.queryId)
                )
                  continue;
                const observedAt = new Date().toISOString(),
                  result = await this.source.runGetMethod(
                    t3Address,
                    "redemption_identity",
                    [
                      {
                        type: "slice",
                        cell: beginCell()
                          .storeAddress(Address.parse(owner))
                          .endCell(),
                      },
                      { type: "int", value: BigInt(r.queryId) },
                    ],
                  );
                if (
                  result?.exitCode !== 0 ||
                  result.stack.length !== 4 ||
                  result.stack.some((v) => v.type !== "int")
                )
                  continue;
                const values = result.stack.map((v) =>
                  v.type === "int" ? v.value : 0n,
                );
                if (
                  values[0] === 0n ||
                  values[1] <= 0n ||
                  values[1] >= 1n << 64n ||
                  values[3] <= 0n ||
                  values[3] >= 1n << 64n ||
                  ![0n, 1n].includes(values[2])
                )
                  continue;
                hub.redemptions.set(r.queryId, {
                  payoutId: values[1].toString(),
                  consumed: values[2] === 1n,
                  wireId: values[3].toString(),
                  getter: {
                    account: t3Address,
                    method: "redemption_identity",
                    args: [owner, r.queryId],
                    result: values.map((v) => v.toString()),
                    observedAt,
                  },
                });
              }
          t3Hubs.set(t3Address, hub);
          await inspectOwned();
        }
      } catch {
        if (relevant) issues.add("t3_hub_identity_or_custody_unresolved");
      }
    }
    const stateAt: ProjectionInput["stateAt"] = async (account, lt, hash) => {
      const canonicalHash = canonicalLedgerHash(hash);
      const existing = (
        await this.store.pool.query(
          "SELECT snapshot FROM ledger_account_states WHERE network=$1 AND account=$2 AND lt=$3 AND hash=$4",
          [this.network, account, lt, canonicalHash],
        )
      ).rows[0];
      if (existing) return existing.snapshot as LedgerStateSnapshot;
      const snapshot = await findTransactionState(this.source, account, {
        lt,
        hash: canonicalHash,
      });
      if (snapshot)
        await this.store.pool.query(
          `INSERT INTO ledger_account_states(network,account,lt,hash,snapshot) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
          [this.network, account, lt, canonicalHash, JSON.stringify(snapshot)],
        );
      return snapshot;
    };
    if (this.perpsEngine) {
      const engineAddress = addr(this.perpsEngine);
      if (!engineAddress || !this.t3Root || !this.perpsEngineCodeHash) {
        issues.add("perps_engine_code_binding_unconfigured");
      } else {
        try {
          await load(engineAddress, "counterparty");
          const current = await this.source.getAccountState(engineAddress);
          if (
            !current.codeBoc ||
            !current.dataBoc ||
            Cell.fromBase64(current.codeBoc).hash().toString("hex") !==
              this.perpsEngineCodeHash
          )
            throw Error("code");
          const state = readPerpsState(current.dataBoc, this.perpsEngineCodeHash);
          if (state.root !== addr(this.t3Root)) throw Error("root");
          const ownerAddress = perpsWalletAddress(
            state.walletCode,
            state.root,
            owner,
          );
          const engineWallet = perpsWalletAddress(
            state.walletCode,
            state.root,
            engineAddress,
          );
          for (const [address, expectedOwner] of [
            [ownerAddress, owner],
            [engineWallet, engineAddress],
          ]) {
            const identity = await wallet(
              address,
              expectedOwner === owner ? "owned_jetton_wallet" : "counterparty",
            );
            const account = await this.source.getAccountState(address);
            if (
              identity?.master !== state.root ||
              identity.owner !== expectedOwner ||
              !account.codeBoc ||
              Cell.fromBase64(account.codeBoc).hash().toString("hex") !==
                state.walletCode.hash().toString("hex")
            )
              throw Error("wallet");
          }
          perpsEngines.set(engineAddress, {
            address: engineAddress,
            root: state.root,
            codeHash: this.perpsEngineCodeHash,
            walletCodeHash: state.walletCode.hash().toString("hex"),
            ownerWallet: ownerAddress,
            engineWallet,
          });
          // Oracle callbacks execute OPEN/CLOS after the original transaction.
          // Retain the actual pool chain, including a failed PRPQ delivery, so
          // the projector can prove the original request-to-callback edge.
          const oraclePools = new Set<string>();
          for (const transaction of chains.get(engineAddress)?.transactions ?? []) {
            for (const message of transaction.outMessages) {
              const request = perpsOracleMessage(message), destination = addr(message.destination);
              if (request?.opcode === PERPS_ORACLE_PULL && addr(message.source) === engineAddress && destination)
                oraclePools.add(destination);
            }
          }
          for (const pool of oraclePools) await load(pool, 'counterparty');
        } catch {
          issues.add("perps_engine_or_custody_identity_unverified");
        }
      }
    }
    const checkedTimes = [...chains.values()]
      .map((chain) => chain.checkedAt)
      .filter((value): value is string => Boolean(value))
      .sort();
    return {
      chains,
      wallets,
      pools,
      optionFactories,
      launchpadSales,
      launchpadControllers: [...knownLaunchpadControllers],
      optionControllers: [
        configuredOptionFactory,
        addr(this.optionVault),
      ].filter((s): s is string => Boolean(s)),
      t3Hubs,
      perpsEngines,
      stateAt,
      issues: [...issues],
      checkedAt: checkedTimes[0] ?? null,
    };
  }
  private async loadPool(address: string): Promise<LedgerPool | null> {
    if (!this.registry) return null;
    const state = await this.source.runGetMethod(address, "pool_state");
    if (!state || state.exitCode !== 0 || state.stack.length !== 13)
      return null;
    const tokenT = stackAddress(state.stack[0]),
      tokenX = stackAddress(state.stack[1]);
    if (!tokenT || !tokenX || tokenT === tokenX) return null;
    const registered = await this.source.runGetMethod(
      this.registry,
      "pool_for",
      [
        {
          type: "slice",
          cell: beginCell().storeAddress(Address.parse(tokenT)).endCell(),
        },
        {
          type: "slice",
          cell: beginCell().storeAddress(Address.parse(tokenX)).endCell(),
        },
      ],
    );
    if (
      !registered ||
      registered.exitCode !== 0 ||
      registered.stack.length !== 6 ||
      registered.stack[0].type !== "int" ||
      registered.stack[0].value === 0n ||
      stackAddress(registered.stack[1]) !== address
    )
      return null;
    const account = await this.source.getAccountState(address);
    if (account.accountState !== "active" || !account.codeBoc) return null;
    return {
      address,
      tokenT,
      tokenX,
      codeHash: Cell.fromBase64(account.codeBoc).hash().toString("hex"),
    };
  }
}

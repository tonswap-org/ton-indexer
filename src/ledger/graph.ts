import { activeOrderAccount, orderShard } from '../orders/evidence';
import { decodeOptionFactory, decodeOptionVault, decodeOptionManager, optionChildAddress } from './currentOptionsState';
import { archiveBindingKey } from './publication';
import type { OwnerCycle, RefreshDependency } from './cycle';
import type { WalletIdentityStore } from './identities';
import type { DlmmMarketBinding } from "./marketTypes";
import { readDlmmRouterState } from "./dlmmRouterState";
import { readDlmmMarketState } from "./dlmmState";
import { ROUTED_SWAP_INTENT, ROUTER_POOL_EXECUTE, ROUTER_POOL_COMPLETED, ROUTER_POOL_COMPLETION_ACK } from "./dlmmRoutedWire";
import type { LedgerPerpsEngine } from "./perps";
import type { LedgerLaunchpadSale } from "./launchpadModels";
import type { LedgerLaunchpadCodeHashes } from "./bindings";
import { readFixedSaleState } from "./launchpadState";
import { readBondingSaleState } from "./launchpadBondingState";
import { readAuctionSaleState } from "./launchpadAuctionState";
import { readPerpsState } from "./perpsState";
import { PERPS_ORACLE_PULL, perpsOracleMessage, perpsWalletAddress, discoverPerpsPeers } from "./perpsWire";
import { type LedgerT3Hub } from "./t3";
import { readCurrentT3Hub } from "./currentT3State";
import { t3Delivery } from "./currentT3Wire";
import { optionBuyForward, type LedgerOptionFactory } from "./options";
import { optionExercise, optionVaultPayout } from "./optionLifecycleWire";
import { optionOwnerAbort } from "./optionAbortWire";
import { readOptionFactoryConfig } from "./optionLifecycleState";
import type { LedgerOptionsCodeHashes } from "./bindings";
import { Address, Cell, beginCell } from "@ton/core";
import type { ChainSource } from "../data/dataSource";
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
    private source: ChainSource,
    private store: PostgresLedgerStore,
    private roots: string[],
    private registry: string | undefined,
    private identities: WalletIdentityStore,
    private refresh: RefreshDependency,
    private maxAccounts = 256,
    private optionFactory?: string,
    private t3Hub?: string,
    private t3Root?: string,
    private perpsEngine?: string,
    private perpsEngineCodeHash?: string,
    private optionVault?: string,
    private optionCodeHashes?: LedgerOptionsCodeHashes,
    private t3RedemptionBinding?: import("./bindings").LedgerT3RedemptionBinding,
    private launchpadCodeHashes?: LedgerLaunchpadCodeHashes,
    private launchpadControllers: string[] = [],
    private configuredMarketBindings: DlmmMarketBinding[] = [],
    private currentOptionsBinding?: import("./currentOptionsProof").NativeOptionProofBinding,
  ) {}
  async build(owner: string, generation: string, cycle: OwnerCycle) {
    const chains = new Map<string, LedgerChain>(),
      wallets = new Map<string, LedgerAsset>(),
      pools = new Map<string, LedgerPool>(),
      optionFactories = new Map<string, LedgerOptionFactory>(),
      launchpadSales = new Map<string, LedgerLaunchpadSale>(),
      perpsEngines = new Map<string, LedgerPerpsEngine>(),
      t3Hubs = new Map<string, LedgerT3Hub>(),
      issues = new Set<string>();
    const options = { at: cycle.boundary, signal: cycle.signal };
    const source = {
      getAccountState: (account: string) => this.source.getAccountState(account, options),
      runGetMethod: (account: string, method: string, args: Parameters<ChainSource['runGetMethod']>[2] = []) =>
        this.source.runGetMethod(account, method, args, options),
    };
    const bindings: Record<string, boolean> = {}, pendingAccounts = new Set<string>();
    const loading = new Map<string, Promise<void>>();
    let buildFailure: unknown;
    let active = 0;
    const waiters: Array<() => void> = [];
    const limited = async <T>(work: () => Promise<T>): Promise<T> => {
      if (active >= 4) await new Promise<void>(resolve => waiters.push(resolve));
      else active++;
      try { return await work(); }
      finally { const next = waiters.shift(); if (next) next(); else active--; }
    };
    const load = async (account: string, role: LedgerRelatedAccount["role"], knownGeneration?: string) => {
      if (chains.has(account)) {
        if (role === "owned_jetton_wallet") chains.get(account)!.role = role;
        await loading.get(account); return;
      }
      if (chains.size >= this.maxAccounts) { issues.add("related_account_limit_reached"); pendingAccounts.add(account); return; }
      const chain: LedgerChain = { account, generation: null, historyComplete: false, atBoundary: false, role, transactions: [] };
      chains.set(account, chain);
      const work = limited(async () => {
        if (knownGeneration) {
          const run = (await this.store.pool.query(
            "SELECT source_complete,complete,head_lt::text,head_hash,head_observed_at FROM ledger_runs WHERE generation=$1",
            [knownGeneration])).rows[0];
          chain.generation = knownGeneration;
          chain.historyComplete = run?.source_complete === true || run?.complete === true;
          chain.atBoundary = chain.historyComplete;
          chain.headLt = run?.head_lt ?? null; chain.headHash = run?.head_hash ?? null;
          chain.checkedAt = run?.head_observed_at ? new Date(run.head_observed_at).toISOString() : null;
        } else {
          const refreshed = await this.refresh(account, cycle);
          chain.generation = refreshed.generation; chain.historyComplete = refreshed.complete;
          chain.atBoundary = refreshed.atBoundary; chain.headLt = refreshed.head?.lt ?? null; chain.headHash = refreshed.head?.hash ?? null;
          chain.checkedAt = refreshed.atBoundary ? new Date().toISOString() : null;
        }
        if (!chain.atBoundary) { pendingAccounts.add(account); issues.add("related_account_refresh_pending"); }
        if (!chain.historyComplete) issues.add("related_account_history_incomplete");
        // Refresh failure is separate from the durable chain. A storage failure
        // aborts this build; it can never masquerade as an empty physical chain.
        if (chain.generation) chain.transactions = (await this.store.rawHistory(chain.generation)).map(item => item.raw);
      });
      loading.set(account, work);
      try { await work; }
      catch (error) { buildFailure ??= error; throw error; }
    };
    const wallet = async (
      value: string,
      role: LedgerRelatedAccount["role"],
    ) => {
      const canonical = addr(value);
      if (!canonical) return null;
      const identity = await this.identities.resolve(canonical, cycle);
      if (!identity) return null;
      wallets.set(canonical, identity);
      await load(
        canonical,
        identity.owner === owner ? "owned_jetton_wallet" : role,
      );
      return identity;
    };
    const discoverWallet = async (root: string, party: string, role: LedgerRelatedAccount["role"], issue: string) => {
      const key = `wallet:${party}:${root}`;
      bindings[key] = false;
      const result = await this.identities.reader.wallet(root, party, options);
      if (result.status === 'not_deployed') { bindings[key] = true; await load(result.wallet, role); return result; }
      if (result.status === 'ok') {
        if (!await wallet(result.wallet, role)) issues.add(issue);
        else bindings[key] = true;
        return result;
      }
      issues.add(issue);
      // Stored qualification remains usable evidence through getter outages.
      const prior = await this.identities.known(party, root, cycle);
      if (prior?.wallet) { bindings[key] = true; wallets.set(prior.wallet, prior); await load(prior.wallet, role); }
      return result;
    };
    const ownerWallet = (root: string) => discoverWallet(root, owner, 'owned_jetton_wallet', 'configured_wallet_discovery_unresolved');
    await load(owner, "owner", generation);
    await Promise.all([...new Set([...this.roots, ...(this.t3Root ? [this.t3Root] : [])])].sort().map(ownerWallet));
    const marketBindings = new Map(this.configuredMarketBindings
      .filter(binding => binding.network === this.network)
      .map(binding => [binding.pool, binding]));
    const routedBindings = new Map<string, DlmmMarketBinding>();
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
            if (request?.op === TRANSFER && request.owner &&
                request.forward.bits.length >= 32 &&
                request.forward.beginParse().preloadUint(32) === ROUTED_SWAP_INTENT) {
              const routes = [...marketBindings.values()].filter(binding =>
                binding.router === request.owner && Boolean(binding.routerCodeHash));
              if (!routes.length) issues.add("dlmm_router_binding_unresolved");
              for (const binding of routes) {
                routedBindings.set(binding.pool, binding);
                candidates.add(binding.pool);
              }
            }
            if (
              request?.op === TRANSFER &&
              request.owner &&
              protocolForward(request.forward)
            )
              candidates.add(request.owner);
            for (const msg of [tx.inMessage, ...tx.outMessages]) {
              if (!msg) continue;
              const wire = tokenWire(msg), privateDelivery=t3Delivery(msg);
              if ((!wire || ![INTERNAL, SETTLEMENT_INTERNAL].includes(wire.op)) && !(privateDelivery&&this.t3RedemptionBinding&&wallets.get(chain.account)?.master===this.t3RedemptionBinding.hub))
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
      bindings[`launchpad:${sale}`] = false;
      if (knownLaunchpadControllers.has(sale)) await load(sale, "counterparty");
      if (!this.launchpadCodeHashes) continue;
      try {
        const current = await source.getAccountState(sale);
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
        bindings[`launchpad:${sale}`] = true;
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
    const references = (target: string | null) => Boolean(target && [...chains.values()].some(chain =>
      (chain.role === 'owner' || chain.role === 'owned_jetton_wallet') && chain.transactions.some(tx =>
        [tx.inMessage, ...tx.outMessages].some(message => addr(message?.source) === target || addr(message?.destination) === target ||
          tokenWire(message)?.owner === target))));
    const optionsRelevant = references(configuredOptionFactory) || references(addr(this.optionVault)) || optionIds.size > 0;
    if (configuredOptionFactory && this.optionCodeHashes && optionsRelevant) {
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
        const state = await source.getAccountState(
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
      bindings[`pool:${candidate}`] = false;
      const binding = routedBindings.get(candidate);
      // A configured deployment supplies discovery identity; historical code,
      // custody, and settlement boundaries still decide qualification.
      const pool = binding ? { address: binding.pool, tokenT: binding.tokenT,
        tokenX: binding.tokenX, codeHash: binding.poolCodeHash }
        : await this.loadPool(candidate, cycle).catch(() => null);
      if (!pool) {
        issues.add("protocol_pool_identity_unresolved");
        continue;
      }
      pools.set(candidate, pool);
      bindings[`pool:${candidate}`] = true;
      await load(candidate, "pool");
      for (const root of [pool.tokenT, pool.tokenX]) {
        const balance = await discoverWallet(root, candidate, "counterparty", "pool_wallet_identity_unresolved");
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
            if (message.bounced || addr(message.source) !== candidate || addr(message.destination) !== addr(balance.wallet ?? undefined)) return false;
            const transfer = tokenWire(message);
            return transfer?.op === TRANSFER && transfer.owner === recipient && BigInt(transfer.amountRaw) > 0n;
          }));
          if (!dispatched) continue;
          const delivered = await discoverWallet(root, recipient, "counterparty", "dlmm_recipient_wallet_unresolved");
          const identity = delivered.status === 'ok' ? wallets.get(delivered.wallet) : null;
          if (!identity || identity.owner !== recipient || identity.master !== root) issues.add("dlmm_recipient_wallet_unresolved");
        }
      }
    }
    await inspectOwned();
    if (configuredOptionFactory && optionsRelevant) {
      bindings[`options:${configuredOptionFactory}`] = false;
      try {
        const config = await source.runGetMethod(
          configuredOptionFactory,
          "factory_config",
        );
        const collateralRoot =
          config?.exitCode === 0 && config.stack.length === 13
            ? stackAddress(config.stack[6])
            : null;
        if (!collateralRoot || !config)
          throw new Error("Option factory identity");
        const factoryState = await source.getAccountState(
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
          const vaultState = await source.getAccountState(vaultAddress);
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
            const balance = await discoverWallet(collateralRoot, party, party === owner ? "owned_jetton_wallet" : "counterparty", "option_custody_wallet_identity_unresolved");
            if (balance.status !== 'ok') {
              issues.add("option_custody_wallet_identity_unresolved");
              continue;
            }
            const identity = await wallet(
              balance.wallet,
              party === owner ? "owned_jetton_wallet" : "counterparty",
            );
            const state = await source.getAccountState(balance.wallet);
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
          const info = await source.runGetMethod(
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
          const state = await source.getAccountState(seriesAddress);
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
        bindings[`options:${configuredOptionFactory}`] = !issues.has("option_custody_wallet_identity_unresolved");
      } catch {
        issues.add("option_factory_identity_unresolved");
      }
    }
    const t3Address=addr(this.t3Hub), t3Binding=this.t3RedemptionBinding;
    if(t3Address){
      bindings[`t3:${t3Address}`]=false;
      try {
        if(!t3Binding||t3Binding.hub!==t3Address||t3Binding.root!==t3Address||t3Binding.network!==this.network)throw Error('T3 release binding unavailable');
        const state=await source.getAccountState(t3Address);
        if(state.accountState!=='active'||!state.codeBoc||!state.dataBoc||Cell.fromBase64(state.codeBoc).hash().toString('hex')!==t3Binding.hubCodeHash)throw Error('T3 hub code mismatch');
        const hubState=readCurrentT3Hub(state.dataBoc);
        if(hubState.configHash!==t3Binding.configHash||hubState.walletCodeHash!==t3Binding.walletCodeHash||hubState.proofCodeHash!==t3Binding.proofCodeHash||hubState.governance!==t3Binding.governance)throw Error('T3 immutable config mismatch');
        await load(t3Address,'counterparty');
        await ownerWallet(t3Address);
        for(const route of t3Binding.reserveRoutes){
          const slot=hubState.slots.get(route.slot),policy=hubState.policies.get(route.slot);
          if(!slot||!policy||slot.master!==route.root||(slot.wallet!==route.vault&&!(route.slot===2&&slot.wallet===null))||policy.scale!==route.scale||policy.codeHash!==route.walletCodeHash)throw Error('T3 reserve binding mismatch');
          if(route.slot===2&&slot.wallet===null)continue;
          const asset=await wallet(route.vault,'counterparty');
          if(asset?.owner!==t3Address||asset.master!==route.root)throw Error('T3 reserve wallet identity');
          await ownerWallet(route.root);
        }
        t3Hubs.set(t3Address,{address:t3Address,root:t3Address,codeHash:t3Binding.hubCodeHash,redemptionBinding:t3Binding,reserveRoots:t3Binding.reserveRoutes.map(r=>r.root),vaults:t3Binding.reserveRoutes.map(r=>r.vault)});
        bindings[`t3:${t3Address}`]=true;
        await inspectOwned();
      }catch{issues.add('t3_hub_identity_or_reserve_unresolved');}
    }
    const archiveFailures = new Set<string>();
    const stateAt: ProjectionInput["stateAt"] = async (account, lt, hash) => {
      const canonicalHash = canonicalLedgerHash(hash);
      const key = archiveBindingKey(account, lt, canonicalHash);
      bindings[key] = false;
      try {
        const existing = (await this.store.pool.query(
          "SELECT snapshot FROM ledger_account_states WHERE network=$1 AND account=$2 AND lt=$3 AND hash=$4",
          [this.network, account, lt, canonicalHash])).rows[0];
        const snapshot = existing && existing.snapshot.seqno <= cycle.boundary.seqno
          ? existing.snapshot as LedgerStateSnapshot
          : await findTransactionState(this.source, account, { lt, hash: canonicalHash }, cycle.boundary.seqno, { signal: cycle.signal });
        if (snapshot && !existing) await this.store.pool.query(
          `INSERT INTO ledger_account_states(network,account,lt,hash,snapshot) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,
          [this.network, account, lt, canonicalHash, JSON.stringify(snapshot)]);
        if (!snapshot) archiveFailures.add(key);
        // A decoder may already have caught one failed lookup. A later success
        // in this cycle cannot erase that lost input and permit degradation.
        bindings[key] = Boolean(snapshot) && !archiveFailures.has(key);
        return snapshot;
      } catch (error) {
        archiveFailures.add(key); bindings[key] = false;
        throw error;
      }
    };
    if (this.perpsEngine && references(addr(this.perpsEngine))) {
      bindings[`perps:${this.perpsEngine}`] = false;
      const engineAddress = addr(this.perpsEngine);
      if (!engineAddress || !this.t3Root || !this.perpsEngineCodeHash) {
        issues.add("perps_engine_code_binding_unconfigured");
      } else {
        try {
          await load(engineAddress, "counterparty");
          const current = await source.getAccountState(engineAddress);
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
            const account = await source.getAccountState(address);
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
              if (request?.opcode === PERPS_ORACLE_PULL && request.owner === owner && addr(message.source) === engineAddress && destination)
                oraclePools.add(destination);
            }
          }
          await Promise.all([...oraclePools].sort().map(pool => load(pool, 'counterparty')));
          let discovered: ReturnType<typeof discoverPerpsPeers> | undefined;
          try { discovered = discoverPerpsPeers(chains.get(engineAddress)?.transactions ?? [], engineAddress, engineWallet); }
          catch { issues.add('perps_range_protocol_account_limit'); }
          if (discovered) {
            await Promise.all([...discovered.peers].sort().map(peer => load(peer, 'counterparty')));
            await Promise.all([...discovered.custodyOwners].sort().map(async party => {
              await discoverWallet(state.root, party, 'counterparty', 'perps_engine_or_custody_identity_unverified');
            }));
          }
          bindings[`perps:${this.perpsEngine}`] = !issues.has('perps_engine_or_custody_identity_unverified');
        } catch {
          issues.add("perps_engine_or_custody_identity_unverified");
        }
      }
    }
    // Routed payments settle across the Router, pool, and physical wallets.
    // Discover these endpoints from exact configured historical contract states,
    // never from a live getter that could select another Router or code version.
    for (const binding of routedBindings.values()) {
      const router = binding.router!;
      await load(router, "counterparty");
      const needed = new Set<string>();
      for (const [account, expectedCode, relevantOps] of [
        [router, binding.routerCodeHash!, [NOTIFY, 0x4a535543, 0x4a53464b, ROUTER_POOL_COMPLETED]],
        [binding.pool, binding.poolCodeHash, [ROUTER_POOL_EXECUTE, 0x4a535543, 0x4a53464b, ROUTER_POOL_COMPLETION_ACK]],
      ] as const) {
        for (const tx of chains.get(account)?.transactions ?? []) {
          if (!(relevantOps as readonly number[]).includes(opcode(tx.inMessage) ?? -1)) continue;
          const notice = tokenWire(tx.inMessage);
          if (notice?.op === NOTIFY) {
            if (notice.owner) needed.add(notice.owner);
            if (notice.senderWallet) needed.add(notice.senderWallet);
          }
          try {
            const archive = await stateAt(account, tx.lt, tx.hash);
            if (!archive?.state.codeBoc || !archive.state.dataBoc ||
                Cell.fromBase64(archive.state.codeBoc).hash().toString("hex") !== expectedCode)
              throw Error("code");
            const state = account === router ? readDlmmRouterState(archive.state.dataBoc)
              : readDlmmMarketState(archive.state.dataBoc);
            if (state.walletCodeHash !== binding.walletCodeHash) throw Error("wallet_code");
            for (const root of [binding.tokenT, binding.tokenX])
              needed.add(perpsWalletAddress(state.walletCode, root, account));
            for (const record of state.settlements.values()) {
              if (account === router && ![7, 8, 12, 15].includes(record.kind)) continue;
              needed.add(record.sourceWallet);
              needed.add(record.destinationWallet);
              if (record.destinationOwner) needed.add(record.destinationOwner);
            }
          } catch { issues.add("dlmm_routed_archive_unavailable"); }
        }
      }
      for (const account of [...needed].sort()) {
        await load(account, account === owner ? "owner" : "counterparty");
        await wallet(account, "counterparty");
      }
    }
    let currentOptionsBinding: import('./currentOptionsProof').NativeOptionProofBinding | undefined;
    if (this.currentOptionsBinding) {
      const b = this.currentOptionsBinding, o = b.options, key = `current-options:${o.factory.toRawString()}`;
      bindings[key] = false;
      try {
        const active = async (address: string, pin: string) => {
          const state = await source.getAccountState(address);
          if (!state.shardAccountBoc) throw Error('Current Options account evidence unavailable');
          return activeOrderAccount(orderShard(state.shardAccountBoc, address).shard, pin);
        };
        const f = decodeOptionFactory((await active(o.factory.toRawString(), o.factoryHash)).data);
        const v = decodeOptionVault((await active(o.vault.toRawString(), o.vaultHash)).data);
        const manager = decodeOptionManager((await active(o.manager.toRawString(), o.managerHash)).data);
        if (!manager.governance.equals(o.governance) || !manager.factory.equals(o.factory)) throw Error('Current Options manager identity mismatch');
        if (!f.governance.equals(o.governance) || !f.vault.equals(o.vault) || !f.manager?.equals(o.manager)
          || f.shoutCode.hash().toString('hex') !== o.shoutHash || f.outperfCode.hash().toString('hex') !== o.outperfHash
          || !v.governance.equals(o.governance) || !v.factory?.equals(o.factory) || !v.feeSink.equals(o.feeSink)
          || !v.treasury.equals(o.treasury) || v.slots.size !== 1 || !v.slots.get(0)?.master.equals(o.t3Root)) throw Error('Current Options peer identity mismatch');
        await load(o.factory.toRawString(), 'counterparty'); await load(o.vault.toRawString(), 'counterparty');
        const vaultWallet = await discoverWallet(o.t3Root.toRawString(), o.vault.toRawString(), 'counterparty', 'option_current_wallet_identity_unresolved');
        if (!vaultWallet || !v.slots.get(0)?.wallet?.equals(Address.parse(vaultWallet.wallet!))) throw Error('Current Options vault wallet mismatch');
        await ownerWallet(o.t3Root.toRawString());
        const ids = new Set<bigint>();
        for (const [id, series] of f.series) if (series.writer.toRawString() === owner || [...series.positions.values()].some(p => p.buyer.toRawString() === owner)) ids.add(id);
        for (const intent of v.book.intents.values()) if (intent.owner.toRawString() === owner) ids.add(intent.seriesId);
        // Original owner commands also retain closed/purged series relevance.
        for (const chain of chains.values()) if (chain.account === owner || wallets.get(chain.account)?.owner === owner) for (const tx of chain.transactions) {
          for (const message of [tx.inMessage, ...tx.outMessages]) {
            try {
              const forward = tokenWire(message)?.forward, cell = forward && forward.bits.length >= 32 ? forward : message?.body ? Cell.fromBase64(message.body) : null;
              if (!cell || cell.bits.length < 32) continue; const s = cell.beginParse(), op = s.loadUint(32);
              if ([0x4f564259,0x4f564644,0x4f535757,0x4f464558].includes(op)) { s.loadUintBig(64); ids.add(s.loadUintBig(64)); }
              else if (op === 0x46455843) ids.add(s.loadUintBig(64));
            } catch { /* Only exact current messages select discovery work. */ }
          }
        }
        for (const id of ids) {
          const series = f.series.get(id);
          if (!series || ![1,2].includes(series.kind) || !optionChildAddress(o.factory,id,series.kind===1?f.shoutCode:f.outperfCode).equals(series.child)) throw Error('Current Options child identity unavailable');
          await load(series.child.toRawString(), 'counterparty');
        }
        currentOptionsBinding = b; bindings[key] = true;
      } catch { issues.add('option_current_discovery_unavailable'); }
    }
    // Product discovery catches transport/qualification failures locally. A
    // failed durable history read must still abort the whole projection.
    if (buildFailure) throw buildFailure;
    const checkedTimes = [...chains.values()]
      .map((chain) => chain.checkedAt)
      .filter((value): value is string => Boolean(value))
      .sort();
    return {
      chains: new Map([...chains].sort(([a], [b]) => a.localeCompare(b))),
      wallets: new Map([...wallets].sort(([a], [b]) => a.localeCompare(b))),
      pools,
      marketBindings,
      optionFactories,
      currentOptionsBinding,
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
      boundary: cycle.boundary,
      pendingAccounts: [...pendingAccounts].sort(),
      bindings,
    };
  }
  private async loadPool(address: string, cycle: OwnerCycle): Promise<LedgerPool | null> {
    const options = { at: cycle.boundary, signal: cycle.signal };
    const source = {
      getAccountState: (account: string) => this.source.getAccountState(account, options),
      runGetMethod: (account: string, method: string, args: Parameters<ChainSource['runGetMethod']>[2] = []) =>
        this.source.runGetMethod(account, method, args, options),
    };
    if (!this.registry) return null;
    const state = await source.runGetMethod(address, "pool_state");
    if (!state || state.exitCode !== 0 || state.stack.length !== 13)
      return null;
    const tokenT = stackAddress(state.stack[0]),
      tokenX = stackAddress(state.stack[1]);
    if (!tokenT || !tokenX || tokenT === tokenX) return null;
    const registered = await source.runGetMethod(
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
    const account = await source.getAccountState(address);
    if (account.accountState !== "active" || !account.codeBoc) return null;
    return {
      address,
      tokenT,
      tokenX,
      codeHash: Cell.fromBase64(account.codeBoc).hash().toString("hex"),
    };
  }
}

import { Cell, Dictionary, type Slice } from "@ton/core";
const end = (s: Slice) => {
  if (s.remainingBits || s.remainingRefs)
    throw Error("Unsupported option lifecycle state");
};
const hex = (s: Slice) => s.loadUintBig(256).toString(16).padStart(64, "0");
const maybe = (s: Slice) => s.loadMaybeAddress()?.toRawString() ?? null;
const inline = {
  serialize: (c: Cell, b: any) => b.storeSlice(c.beginParse()),
  parse: (s: Slice) => {
    const c = s.asCell();
    s.skip(s.remainingBits);
    while (s.remainingRefs) s.loadRef();
    return c;
  },
};
export type OptionOutboundClaim = {
  claimId: string;
  identityHash: string;
  kind: number;
  amountRaw: string;
  wireId: string;
  finalizeWireId: string;
  status: number;
  fundedValueRaw: string;
  owner: string;
  recipient: string;
};
export type OptionFactorySeries = {
  stateHash: string;
  templateId: number;
  kind: number;
  expiry: string;
  maxNotionalRaw: string;
  premiumBps: number;
  collateralMultiplierBps: number;
  strikeBps: number;
  openNotionalRaw: string;
  collateralLockedRaw: string;
  status: number;
  settlementTimestamp: string;
  nextTokenId: string;
  correlationScaleBps: number;
  correlationBps: number;
  correlationDispersionBps: number;
  correlationTimestamp: string;
  correlationConfigHash: string;
  optionAddress: string | null;
  underlyingPool: string | null;
  quotePool: string | null;
  activationWireId: string;
  activationRequestHash: string;
  configHash: string;
};
/** Exact SeriesPersisted order from options/factory.tolk. */
function readFactorySeries(data: Cell): OptionFactorySeries {
  const s = data.beginParse(),
    templateId = s.loadUint(32),
    kind = s.loadUint(16),
    expiry = s.loadIntBig(64).toString(),
    maxNotionalRaw = s.loadCoins().toString(),
    premiumBps = s.loadUint(32),
    collateralMultiplierBps = s.loadUint(32),
    strikeBps = s.loadUint(32),
    openNotionalRaw = s.loadCoins().toString(),
    collateralLockedRaw = s.loadCoins().toString(),
    status = s.loadUint(8),
    settlementTimestamp = s.loadIntBig(64).toString(),
    nextTokenId = s.loadUintBig(64).toString(),
    correlationScaleBps = s.loadUint(32),
    correlationBps = s.loadInt(32),
    correlationDispersionBps = s.loadUint(32),
    correlationTimestamp = s.loadIntBig(64).toString(),
    correlationConfig = s.loadRef(),
    addresses = s.loadRef().beginParse(),
    activation = s.loadRef().beginParse();
  end(s);
  const correlation = correlationConfig.beginParse();
  for (let i = 0; i < 5; i++) correlation.loadUint(32);
  end(correlation);
  const optionAddress = maybe(addresses),
    underlyingPool = maybe(addresses),
    quotePool = maybe(addresses);
  end(addresses);
  const activationWireId = activation.loadUintBig(64).toString(),
    activationRequestHash = hex(activation),
    configHash = hex(activation);
  end(activation);
  return {
    stateHash: data.hash().toString("hex"),
    templateId,
    kind,
    expiry,
    maxNotionalRaw,
    premiumBps,
    collateralMultiplierBps,
    strikeBps,
    openNotionalRaw,
    collateralLockedRaw,
    status,
    settlementTimestamp,
    nextTokenId,
    correlationScaleBps,
    correlationBps,
    correlationDispersionBps,
    correlationTimestamp,
    correlationConfigHash: correlationConfig.hash().toString("hex"),
    optionAddress,
    underlyingPool,
    quotePool,
    activationWireId,
    activationRequestHash,
    configHash,
  };
}
function completeOptionDictionary(cell: Cell): Slice {
  // Dictionary.load omits exotic/pruned branches. Absence must come from a
  // complete archived dictionary, especially when proving a cleared buy wire.
  const pending = [cell], seen = new Set<Cell>();
  while (pending.length) {
    const next = pending.pop()!;
    if (seen.has(next)) continue;
    if (next.isExotic) throw Error("Incomplete option dictionary");
    seen.add(next);
    pending.push(...next.refs);
  }
  return cell.beginParse();
}
/** Only the current canonical factory serializer is recognized. */
export function readOptionFactoryConfig(boc: string) {
  const data = Cell.fromBase64(boc),
    root = data.beginParse();
  if (root.remainingBits || root.remainingRefs !== 3)
    throw Error("Factory storage");
  const registry = root.loadRef().beginParse();
  const maps = root.loadRef().beginParse();
  maps.loadRef();
  maps.loadRef();
  const seriesSlice = completeOptionDictionary(maps.loadRef());
  end(maps);
  const seriesEntries = seriesSlice.loadDict(Dictionary.Keys.BigUint(64), inline);
  end(seriesSlice);
  const series = new Map<string, OptionFactorySeries>();
  for (const [key, cell] of seriesEntries)
    series.set(key.toString(), readFactorySeries(cell));
  const positionSlice = completeOptionDictionary(root.loadRef()),
    positions = positionSlice.loadDict(Dictionary.Keys.BigUint(128), inline);
  end(positionSlice);
  end(root);
  registry.loadRef();
  const c = registry.loadRef().beginParse();
  registry.loadRef();
  const oracleBundle = registry.loadRef().beginParse();
  end(registry);
  oracleBundle.loadRef();
  oracleBundle.loadRef();
  oracleBundle.loadRef();
  const seriesAux = oracleBundle.loadRef().beginParse();
  end(oracleBundle);
  seriesAux.loadRef();
  seriesAux.loadRef();
  const buyIndex = completeOptionDictionary(seriesAux.loadRef());
  end(seriesAux);
  const seriesBuyIndex = buyIndex.loadDict(
    Dictionary.Keys.BigUint(64),
    Dictionary.Values.BigUint(128),
  );
  end(buyIndex);
  const manager = maybe(c),
    vault = maybe(c),
    guard = c.loadRef().beginParse(),
    codes = c.loadRef().beginParse(),
    collateral = c.loadRef().beginParse(),
    fee = c.loadRef().beginParse();
  end(c);
  const guardian = maybe(guard),
    oracle = maybe(guard);
  end(guard);
  const shoutCodeHash = codes.loadRef().hash().toString("hex"),
    outperformanceCodeHash = codes.loadRef().hash().toString("hex");
  end(codes);
  const collateralRoot = maybe(collateral),
    walletCode = collateral.loadRef();
  end(collateral);
  const feeRouter = maybe(fee),
    t3Root = maybe(fee),
    t3WalletCode = fee.loadRef(),
    bundle = fee.loadRef().beginParse();
  fee.loadRef();
  const protocolFeeBps = fee.loadUint(16),
    settlementMode = fee.loadUint(8),
    nextBuyWireId = fee.loadUintBig(64).toString(),
    activeBuyKey = fee.loadUintBig(128).toString();
  fee.loadCoins();
  fee.loadUintBig(64);
  end(fee);
  const cs = bundle.loadRef().beginParse(),
    ix = bundle.loadRef().beginParse();
  end(bundle);
  const entries = cs.loadDict(
    Dictionary.Keys.BigUint(64),
    Dictionary.Values.Cell(),
  );
  end(cs);
  const claimIndex = ix.loadDict(
    Dictionary.Keys.BigUint(256),
    Dictionary.Values.BigUint(64),
  );
  end(ix);
  const claims = new Map<string, OptionOutboundClaim>();
  for (const [key, cell] of entries) {
    const s = cell.beginParse(),
      claimId = s.loadUintBig(64).toString(),
      identityHash = hex(s),
      kind = s.loadUint(8),
      amountRaw = s.loadCoins().toString(),
      wireId = s.loadUintBig(64).toString(),
      finalizeWireId = s.loadUintBig(64).toString(),
      status = s.loadUint(8),
      fundedValueRaw = s.loadCoins().toString(),
      actors = s.loadRef().beginParse();
    end(s);
    const owner = actors.loadAddress().toRawString(),
      recipient = actors.loadAddress().toRawString();
    end(actors);
    if (key.toString() !== claimId)
      throw Error("Claim ID differs from dictionary key");
    claims.set(claimId, {
      claimId,
      identityHash,
      kind,
      amountRaw,
      wireId,
      finalizeWireId,
      status,
      fundedValueRaw,
      owner,
      recipient,
    });
  }
  return {
    dataHash: data.hash().toString("hex"),
    manager,
    vault,
    guardian,
    oracle,
    shoutCodeHash,
    outperformanceCodeHash,
    collateralRoot,
    walletCode,
    feeRouter,
    t3Root,
    t3WalletCode,
    protocolFeeBps,
    settlementMode,
    nextBuyWireId,
    activeBuyKey,
    claims,
    claimIndex,
    positions,
    series,
    seriesBuyIndex,
  };
}
export type OptionVaultEntry = {
  kind: number;
  requestId: string;
  seriesId: string;
  status: number;
  amountRaw: string;
  wireId: string;
  lastAttemptTs: string;
  finalizeReservedRaw: string;
  lockedDeltaRaw: string;
  premiumDeltaRaw: string;
  accountingApplied: number;
  riskClaimId: string;
  riskStatus: number;
  riskLastAttemptTs: string;
  recipient: string | null;
  destinationWallet: string | null;
  requestHash: string;
  riskRequestHash: string;
  riskDeliveredRaw: string;
  metadataBoc: string;
};
export function readOptionVaultState(boc: string) {
  const data = Cell.fromBase64(boc),
    s = data.beginParse();
  s.loadRef();
  const config = s.loadRef().beginParse();
  const bucketCell = s.loadRef();
  const journal = s.loadRef().beginParse();
  const trackedBalanceRaw = s.loadCoins().toString(),
    reservedTokensRaw = s.loadCoins().toString(),
    totalLockedRaw = s.loadCoins().toString(),
    totalPremiumRaw = s.loadCoins().toString();
  end(s);
  const managerSlice = config.loadRef().beginParse(),
    guardianSlice = config.loadRef().beginParse(),
    treasury = config.loadRef().beginParse(),
    wallet = config.loadRef().beginParse();
  end(config);
  const manager = maybe(managerSlice),
    guardian = maybe(guardianSlice);
  end(managerSlice);
  end(guardianSlice);
  const treasuryOwner = maybe(treasury),
    riskVault = maybe(treasury),
    riskBucketId = treasury.loadUint(16),
    settlementMode = treasury.loadUint(8);
  end(treasury);
  const treasuryWallet = maybe(wallet),
    collateralWallet = maybe(wallet),
    collateralRoot = maybe(wallet),
    walletCode = wallet.loadRef();
  end(wallet);
  const values = journal.loadDict(
    Dictionary.Keys.BigUint(256),
    Dictionary.Values.Cell(),
  );
  journal.loadDict(Dictionary.Keys.BigUint(64), Dictionary.Values.BigUint(256));
  const depositReceipts = journal.loadDict(
    Dictionary.Keys.BigUint(128),
    Dictionary.Values.BigUint(256),
  );
  const activeKey = hex(journal),
    pendingFinalizeKey = hex(journal),
    finalizeAttemptKey = hex(journal),
    nextWireId = journal.loadUintBig(64).toString();
  journal.loadUintBig(64);
  journal.loadUintBig(64);
  end(journal);
  const entries = new Map<string, OptionVaultEntry>();
  for (const [key, cell] of values) {
    const e = cell.beginParse(),
      kind = e.loadUint(8),
      requestId = e.loadUintBig(64).toString(),
      seriesId = e.loadUintBig(64).toString(),
      status = e.loadUint(8),
      amountRaw = e.loadCoins().toString(),
      wireId = e.loadUintBig(64).toString(),
      lastAttemptTs = e.loadIntBig(64).toString(),
      finalizeReservedRaw = e.loadCoins().toString(),
      lockedDeltaRaw = e.loadCoins().toString(),
      premiumDeltaRaw = e.loadCoins().toString(),
      accountingApplied = e.loadUint(8),
      riskClaimId = e.loadUintBig(64).toString(),
      riskStatus = e.loadUint(8),
      riskLastAttemptTs = e.loadIntBig(64).toString(),
      route = e.loadRef().beginParse(),
      hashes = e.loadRef().beginParse();
    end(e);
    const recipient = maybe(route),
      destinationWallet = maybe(route);
    end(route);
    const requestHash = hex(hashes),
      riskRequestHash = hex(hashes),
      riskDeliveredRaw = hashes.loadCoins().toString(),
      metadataBoc = hashes.loadRef().toBoc().toString("base64");
    end(hashes);
    entries.set(key.toString(16).padStart(64, "0"), {
      kind,
      requestId,
      seriesId,
      status,
      amountRaw,
      wireId,
      lastAttemptTs,
      finalizeReservedRaw,
      lockedDeltaRaw,
      premiumDeltaRaw,
      accountingApplied,
      riskClaimId,
      riskStatus,
      riskLastAttemptTs,
      recipient,
      destinationWallet,
      requestHash,
      riskRequestHash,
      riskDeliveredRaw,
      metadataBoc,
    });
  }
  return {
    dataHash: data.hash().toString("hex"),
    manager,
    guardian,
    treasuryOwner,
    treasuryWallet,
    collateralWallet,
    collateralRoot,
    walletCode,
    riskVault,
    riskBucketId,
    settlementMode,
    trackedBalanceRaw,
    reservedTokensRaw,
    totalLockedRaw,
    totalPremiumRaw,
    activeKey,
    pendingFinalizeKey,
    finalizeAttemptKey,
    nextWireId,
    depositReceipts,
    bucketCell,
    entries,
  };
}
export function readOptionVaultBucket(cell: Cell, seriesId: string) {
  const s = cell.beginParse(),
    values = s.loadDict(Dictionary.Keys.BigUint(64), Dictionary.Values.Cell());
  end(s);
  const cellValue = values.get(BigInt(seriesId));
  if (!cellValue) return null;
  const v = cellValue.beginParse(),
    lockedRaw = v.loadCoins().toString(),
    premiumRaw = v.loadCoins().toString(),
    reservedLockedRaw = v.loadCoins().toString(),
    reservedPremiumRaw = v.loadCoins().toString(),
    liabilityActionId = v.loadUintBig(64).toString(),
    liabilityStatus = v.loadUint(8),
    liabilityLastDispatchTs = v.loadIntBig(64).toString(),
    liability = v.loadRef().beginParse();
  end(v);
  const liabilityRequestHash = hex(liability),
    liabilityTargetNotionalRaw = liability.loadCoins().toString(),
    liabilityTargetImRaw = liability.loadCoins().toString(),
    liabilityTargetCmRaw = liability.loadCoins().toString();
  end(liability);
  return {
    lockedRaw,
    premiumRaw,
    reservedLockedRaw,
    reservedPremiumRaw,
    liabilityActionId,
    liabilityStatus,
    liabilityLastDispatchTs,
    liabilityRequestHash,
    liabilityTargetNotionalRaw,
    liabilityTargetImRaw,
    liabilityTargetCmRaw,
  };
}
export function readOptionProductState(
  boc: string,
  kind: 1 | 2,
  positionId: string,
) {
  const data = Cell.fromBase64(boc),
    s = data.beginParse();
  if (s.loadUint(16) !== (kind === 1 ? 0x5348 : 0x4f50))
    throw Error("Unsupported option product version");
  s.loadRef();
  const config = s.loadRef().beginParse(),
    positions = completeOptionDictionary(s.loadRef()),
    bundle = s.loadRef().beginParse();
  end(s);
  const admins = config.loadRef().beginParse(),
    routing = config.loadRef().beginParse();
  const manager = maybe(admins),
    guardian = maybe(admins);
  end(admins);
  const oracle = maybe(routing),
    vault = maybe(routing);
  end(routing);
  // Consume the exact current configuration layout; only the qualified product evaluates prices.
  if (kind === 1) {
    maybe(config);
    config.loadIntBig(64);
    config.loadIntBig(64);
    config.loadIntBig(64);
    config.loadUint(32);
    config.loadUint(32);
    const maximum = config.loadRef().beginParse();
    maximum.loadCoins();
    end(maximum);
    config.loadIntBig(64);
    config.loadIntBig(64);
    const strike = config.loadRef().beginParse();
    strike.loadUint(32);
    strike.loadUint(32);
    strike.loadIntBig(128);
    strike.loadIntBig(128);
    strike.loadUint(8);
    end(strike);
  } else {
    const pools = config.loadRef().beginParse();
    maybe(pools);
    maybe(pools);
    end(pools);
    config.loadIntBig(64);
    config.loadUint(32);
    config.loadUint(32);
    config.loadUint(32);
    config.loadCoins();
    config.loadIntBig(64);
    config.loadIntBig(64);
    config.loadUint(8);
  }
  end(config);
  const runtime = bundle.loadRef().beginParse();
  bundle.loadRef();
  end(bundle);
  runtime.loadIntBig(64);
  runtime.loadBoolean();
  runtime.loadCoins();
  const seriesId = runtime.loadUintBig(64).toString();
  runtime.loadUintBig(64);
  runtime.loadUintBig(256);
  runtime.loadUintBig(256);
  end(runtime);
  const dict = positions.loadDict(Dictionary.Keys.BigUint(64), inline);
  end(positions);
  const cell = dict.get(BigInt(positionId));
  if (!cell)
    return {
      dataHash: data.hash().toString("hex"),
      manager,
      guardian,
      oracle,
      vault,
      seriesId,
      position: null,
    };
  const p = cell.beginParse(),
    owner = p.loadAddress().toRawString(),
    tokenId = p.loadUintBig(64).toString(),
    notionalRaw = p.loadCoins().toString(),
    premiumRaw = p.loadCoins().toString();
  let collateralRaw: string,
    payoutRaw: string | undefined,
    shoutFloorRaw: string | undefined,
    lastShoutTs: string | undefined,
    exercised: boolean,
    settled: boolean;
  if (kind === 1) {
    shoutFloorRaw = p.loadCoins().toString();
    lastShoutTs = p.loadIntBig(64).toString();
    exercised = p.loadBoolean();
    settled = p.loadBoolean();
    collateralRaw = p.loadCoins().toString();
  } else {
    collateralRaw = p.loadCoins().toString();
    payoutRaw = p.loadCoins().toString();
    settled = p.loadBoolean();
    exercised = p.loadBoolean();
  }
  const active = p.loadBoolean(),
    buyWireId = p.loadUintBig(64).toString();
  end(p);
  if (tokenId !== positionId)
    throw Error("Option product token differs from dictionary key");
  return {
    dataHash: data.hash().toString("hex"),
    manager,
    guardian,
    oracle,
    vault,
    seriesId,
    position: {
      owner,
      tokenId,
      notionalRaw,
      premiumRaw,
      collateralRaw,
      payoutRaw,
      shoutFloorRaw,
      lastShoutTs,
      exercised,
      settled,
      active,
      buyWireId,
    },
  };
}

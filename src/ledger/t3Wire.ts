import { Address, Cell, Dictionary, beginCell, contractAddress } from '@ton/core';
import type { RawMessage } from '../data/dataSource';
import { bodyCell, BURN, BURN_NOTIFY } from './wire';
export const T3_MINT = 0x4d494e54,
  T3_MINT_RECEIPT = 0x4d524354,
  T3_REDEEM = 0x5245444d,
  T3_REDEEM_RECEIPT = 0x52524354,
  MINT_START = 0x4a4d5354,
  MINT_INTERNAL = 0x4a4d4953,
  MINT_ACCEPTED = 0x4a4d4143,
  MINT_SUCCEEDED = 0x4a4d5355,
  MINT_FINALIZE = 0x4a4d464e,
  MINT_FINALIZED = 0x4a4d4641,
  BURN_ACCEPTED = 0x4a424143,
  RECEIVER_PAYOUT = 0x54335059,
  RECEIVER_CREDITED = 0x54334352,
  DEPOSIT_NOTE = 0x54444550;
export const T3_OPS = new Set([
  T3_MINT,
  T3_MINT_RECEIPT,
  T3_REDEEM,
  T3_REDEEM_RECEIPT,
  MINT_START,
  MINT_INTERNAL,
  MINT_ACCEPTED,
  MINT_SUCCEEDED,
  MINT_FINALIZE,
  MINT_FINALIZED,
  BURN_ACCEPTED,
  0x4a425355,
  0x4a42464e,
  0x4a424246,
  0x4a425250,
  0x4a4d4246,
  0x4d525459,
  0x54335052,
  0x54335044,
  RECEIVER_CREDITED,
  0x54335252,
  0x54334453,
  0x54335744,
  0x56505259,
]);
const end = (s: ReturnType<Cell['beginParse']>) => {
  if (s.remainingBits || s.remainingRefs) throw Error('Trailing T3 wire');
};
const parse = <T>(
  m: RawMessage | undefined,
  op: number,
  read: (s: ReturnType<Cell['beginParse']>) => T,
): T | null => {
  try {
    const c = bodyCell(m);
    if (!c) return null;
    const s = c.beginParse();
    if (s.loadUint(32) !== op) return null;
    const v = read(s);
    end(s);
    return v;
  } catch {
    return null;
  }
};
const u64 = (s: ReturnType<Cell['beginParse']>) => s.loadUintBig(64).toString();
const coins = (s: ReturnType<Cell['beginParse']>) => s.loadCoins().toString();
const address = (s: ReturnType<Cell['beginParse']>) =>
  s.loadAddress().toRawString();
const hash = (s: ReturnType<Cell['beginParse']>) =>
  s.loadUintBig(256).toString(16).padStart(64, '0');
export const basket = (s: ReturnType<Cell['beginParse']>) => [
  coins(s),
  coins(s),
  coins(s),
];
export function referralAddress(c: Cell): string | null {
  const s = c.beginParse(), referrer = s.loadMaybeAddress()?.toRawString() ?? null;
  end(s);
  return referrer;
}

export function readT3ReferralState(c: Cell) {
  const s = c.beginParse();
  const moduleKey = s.loadUint(32), reservedNative = coins(s), nextFundingWire = u64(s),
    activeMint = u64(s), activeFunding = u64(s), config = s.loadRef(), outbox = s.loadRef();
  // Completed user mints remain replayable after a referral reserve mint uses
  // the active mint slot. The inline HashmapE is part of the first-release ABI.
  const completedMints = s.loadDict(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
  end(s);
  for (const [key, value] of completedMints) {
    const journal = value.beginParse(), status = journal.loadUint(8), businessQuery = journal.loadUintBig(64),
      rootQuery = journal.loadUintBig(64), amount = journal.loadCoins(), recipient = journal.loadAddress(),
      destination = journal.loadAddress(), requestHash = journal.loadUintBig(256), receipt = journal.loadRef().beginParse();
    end(journal);
    const expectedKey = BigInt(`0x${beginCell().storeUint(0x54334d52, 32).storeAddress(destination).storeUint(businessQuery, 64).endCell().hash().toString('hex')}`);
    if (key !== expectedKey || status !== 4 || rootQuery === 0n || amount === 0n || requestHash === 0n ||
      receipt.loadUint(32) !== T3_MINT_RECEIPT || receipt.loadUintBig(64) !== businessQuery ||
      !receipt.loadAddress().equals(recipient) || receipt.loadCoins() !== amount) throw Error('T3 archived mint identity');
    basket(receipt); receipt.loadMaybeRef(); end(receipt);
  }
  let registry: string | null = null, feeRouter: string | null = null, t3Root: string | null = null;
  if (moduleKey > 0) {
    const cfg = config.beginParse();
    registry = address(cfg); feeRouter = address(cfg); t3Root = address(cfg);
    cfg.loadRef(); end(cfg);
  } else if (config.bits.length || config.refs.length) throw Error('Unconfigured T3 referral config');
  const box = outbox.beginParse();
  const nonce = u64(box), cursor = u64(box);
  // Both persistent dictionaries are mandatory even when empty.
  box.loadMaybeRef(); box.loadMaybeRef(); end(box);
  if (BigInt(cursor) > BigInt(nonce) || BigInt(activeMint) > BigInt(nonce) || BigInt(activeFunding) > BigInt(nonce))
    throw Error('T3 referral journal identity');
  return { moduleKey, reservedNative, nextFundingWire, activeMint, activeFunding, registry, feeRouter, t3Root };
}

export function readT3AutomationReferral(c: Cell) {
  const b = c.beginParse();
  // Current AutomationControlBounce: target, opcode:uint32, jobId:uint32,
  // value:coins, timestamp:int64. No reporter tuple precedes the three refs.
  b.loadMaybeAddress(); b.skip(64); coins(b); b.skip(64);
  b.loadRef(); b.loadRef();
  const referral = readT3ReferralState(b.loadRef());
  end(b);
  return referral;
}

export function depositNote(c: Cell) {
  try {
    const s = c.beginParse();
    if (s.loadUint(32) !== DEPOSIT_NOTE || s.loadUint(8) !== 1) return null;
    const flags = s.loadUint(8), slippage = s.loadUint(16),
      recipient = s.loadMaybeAddress()?.toRawString() ?? null,
      referrer = referralAddress(s.loadRef());
    end(s);
    return { flags, slippage, recipient, referrer };
  } catch {
    return null;
  }
}
export const mintRequest = (m?: RawMessage) =>
  parse(m, T3_MINT, (s) => {
    const queryId = u64(s),
      recipient = address(s),
      slippage = s.loadUint(16),
      basketRaw = basket(s);
    s.loadMaybeRef();
    const referrer = referralAddress(s.loadRef());
    return { queryId, recipient, slippage, basketRaw, referrer };
  });
export const mintReceipt = (m?: RawMessage) =>
  parse(m, T3_MINT_RECEIPT, (s) => {
    const queryId = u64(s),
      recipient = address(s),
      amountRaw = coins(s),
      basketRaw = basket(s);
    s.loadMaybeRef();
    return { queryId, recipient, amountRaw, basketRaw };
  });
export const redeemReceipt = (m?: RawMessage) =>
  parse(m, T3_REDEEM_RECEIPT, (s) => {
    const queryId = u64(s),
      recipient = address(s),
      amountRaw = coins(s),
      basketRaw = basket(s),
      mode = s.loadUint(8),
      outputToken = s.loadUint(8);
    s.loadMaybeRef();
    return { queryId, recipient, amountRaw, basketRaw, mode, outputToken };
  });
export const redeemRequest = (m?: RawMessage) =>
  parse(m, T3_REDEEM, (s) => {
    const queryId = u64(s),
      owner = address(s),
      recipient = address(s),
      slippage = s.loadUint(16),
      amountRaw = coins(s),
      mode = s.loadUint(8),
      outputToken = s.loadUint(8);
    s.loadMaybeRef();
    const referrer = referralAddress(s.loadRef());
    if (mode > 1 || outputToken > 2 || slippage > 10000)
      throw Error('Redeem constraints');
    return {
      queryId,
      owner,
      recipient,
      slippage,
      amountRaw,
      mode,
      outputToken,
      referrer,
    };
  });
export const mintStart = (m?: RawMessage) =>
  parse(m, MINT_START, (s) => ({
    queryId: u64(s),
    amountRaw: coins(s),
    recipient: address(s),
    response: address(s),
    forwardTonRaw: coins(s),
    forward: s.loadRef(),
  }));
export const mintInternal = (m?: RawMessage) =>
  parse(m, MINT_INTERNAL, (s) => {
    const wireId = u64(s),
      queryId = u64(s),
      amountRaw = coins(s),
      requestHash = hash(s),
      c = s.loadRef().beginParse(),
      caller = address(c),
      recipient = address(c),
      forwardTonRaw = coins(c);
    end(c);
    return {
      wireId,
      queryId,
      amountRaw,
      requestHash,
      caller,
      recipient,
      forwardTonRaw,
      forward: s.loadRef(),
    };
  });
export const mintAck = (m: RawMessage | undefined, op: number) =>
  parse(m, op, (s) => ({
    wireId: u64(s),
    queryId: u64(s),
    amountRaw: coins(s),
    recipient: op === MINT_SUCCEEDED ? address(s) : null,
    requestHash: hash(s),
  }));
export const mintFinalize = (m: RawMessage | undefined, op = MINT_FINALIZE) =>
  parse(m, op, (s) => ({
    queryId: u64(s),
    amountRaw: coins(s),
    recipient: address(s),
    requestHash: hash(s),
  }));
export function mintRequestHash(
  root: string,
  wallet: string,
  v: NonNullable<ReturnType<typeof mintInternal>>,
) {
  return beginCell()
    .storeUint(MINT_START, 32)
    .storeAddress(Address.parse(root))
    .storeUint(BigInt(v.wireId), 64)
    .storeUint(BigInt(v.queryId), 64)
    .storeCoins(BigInt(v.amountRaw))
    .storeCoins(BigInt(v.forwardTonRaw))
    .storeRef(
      beginCell()
        .storeAddress(Address.parse(v.caller))
        .storeAddress(Address.parse(v.recipient))
        .endCell(),
    )
    .storeRef(
      beginCell()
        .storeAddress(Address.parse(wallet))
        .storeAddress(Address.parse(v.caller))
        .storeUint(BigInt('0x' + v.forward.hash().toString('hex')), 256)
        .endCell(),
    )
    .endCell()
    .hash()
    .toString('hex');
}
export function burnPayload(c: Cell) {
  try {
    const s = c.beginParse();
    if (s.loadUint(32) !== 0x54335242) return null;
    const recipient = address(s),
      slippage = s.loadUint(16),
      mode = s.loadUint(8),
      outputToken = s.loadUint(8),
      referrer = s.loadMaybeAddress()?.toRawString() ?? null;
    end(s);
    if (slippage > 10000 || mode > 1 || outputToken > 2) return null;
    return { recipient, slippage, mode, outputToken, referrer };
  } catch {
    return null;
  }
}
export const burnRequest = (m?: RawMessage) =>
  parse(m, BURN, (s) => {
    const queryId = u64(s),
      amountRaw = coins(s),
      response = address(s),
      payload = s.loadRef(),
      intent = burnPayload(payload);
    if (!intent) throw Error('Burn intent');
    return { queryId, amountRaw, response, payload, ...intent };
  });
export const burnNotify = (m?: RawMessage) =>
  parse(m, BURN_NOTIFY, (s) => ({
    queryId: u64(s),
    amountRaw: coins(s),
    owner: address(s),
    response: address(s),
    payload: s.loadRef(),
  }));
export function burnProof(c: Cell) {
  try {
    const s = c.beginParse();
    if (s.loadUint(32) !== 0x54335250) return null;
    const queryId = u64(s),
      payload = s.loadRef(),
      intent = burnPayload(payload);
    end(s);
    return intent ? { queryId, payload, ...intent } : null;
  } catch {
    return null;
  }
}
export const burnAck = (m?: RawMessage) =>
  parse(m, BURN_ACCEPTED, (s) => ({
    queryId: u64(s),
    amountRaw: coins(s),
    requestHash: hash(s),
  }));
export const burnIntentHash = (owner: string, queryId: string) =>
  beginCell()
    .storeUint(0x54335249, 32)
    .storeAddress(Address.parse(owner))
    .storeUint(BigInt(queryId), 64)
    .endCell()
    .hash()
    .toString('hex');
export function burnRequestHash(
  root: string,
  wallet: string,
  owner: string,
  v: NonNullable<ReturnType<typeof burnRequest>>,
) {
  return beginCell()
    .storeUint(0x54335242, 32)
    .storeAddress(Address.parse(root))
    .storeAddress(Address.parse(wallet))
    .storeUint(BigInt(v.queryId), 64)
    .storeCoins(BigInt(v.amountRaw))
    .storeUint(BigInt('0x' + v.payload.hash().toString('hex')), 256)
    .storeRef(
      beginCell()
        .storeAddress(Address.parse(owner))
        .storeAddress(Address.parse(v.response))
        .endCell(),
    )
    .endCell()
    .hash()
    .toString('hex');
}
export function receiverPayout(c: Cell) {
  try {
    const s = c.beginParse();
    if (s.loadUint(32) !== RECEIVER_PAYOUT) return null;
    const payoutId = u64(s),
      wireId = u64(s),
      routeEpoch = s.loadUint(32),
      token = s.loadUint(8),
      amountRaw = coins(s),
      p = s.loadRef().beginParse(),
      hub = address(p),
      controller = address(p),
      receiver = address(p);
    end(s);
    end(p);
    if (token > 2 || amountRaw === '0') return null;
    return {
      payoutId,
      wireId,
      routeEpoch,
      token,
      amountRaw,
      hub,
      controller,
      receiver,
      payoutHash: c.hash().toString('hex'),
    };
  } catch {
    return null;
  }
}
export const receiverAck = (m?: RawMessage) =>
  parse(m, RECEIVER_CREDITED, (s) => ({
    payoutId: u64(s),
    wireId: u64(s),
    routeEpoch: s.loadUint(32),
    token: s.loadUint(8),
    amountRaw: coins(s),
    receiverWallet: address(s),
    payoutHash: hash(s),
  }));
export function receiverAddress(code: Cell, hub: string, owner: string) {
  const data = beginCell()
    .storeUint(1, 8)
    .storeAddress(Address.parse(hub))
    .storeAddress(Address.parse(owner))
    .storeRef(beginCell().storeUint(0, 64).storeBit(false).endCell())
    .storeRef(beginCell().storeUint(0, 8).endCell())
    .endCell();
  return contractAddress(0, { code, data }).toRawString();
}
/** The first-release tagged storage layout. Rates are read from the immediate pre-transaction state, never a current getter. */
export function t3State(dataBoc: string) {
  const wrapper = Cell.fromBase64(dataBoc),
    w = wrapper.beginParse();
  if (w.loadUint(32) !== 0x54335354 || w.remainingBits || w.remainingRefs !== 1)
    throw Error('T3 storage tag');
  const payload = w.loadRef(),
    s = payload.beginParse();
  const amp = s.loadInt(24),
    feeBps = s.loadUint(16),
    totalSupply = coins(s),
    balances = basket(s),
    fees = s.loadRef();
  s.loadRef();
  s.skip(208);
  const runtime = s.loadRef(),
    governance = address(s),
    root = address(s);
  s.loadUint(8);
  const referral = readT3AutomationReferral(s.loadRef());
  if (referral.t3Root !== null && referral.t3Root !== root) throw Error('T3 referral root mismatch');
  end(s);
  const r = runtime.beginParse();
  if (r.remainingBits || r.remainingRefs !== 4) throw Error('T3 peg runtime layout');
  r.loadRef(); // Activation acknowledgement journal.
  r.loadRef(); // Authenticated relative-peg observations.
  const peg = r.loadRef().beginParse();
  r.loadRef();
  end(r);
  const level = peg.loadUint(8);
  peg.loadUint(16);
  const outageMask = peg.loadUint(8),
    frozenMask = peg.loadUint(8);
  peg.skip(128);
  coins(peg);
  basket(peg);
  coins(peg);
  peg.skip(32);
  const mintFeeBps = peg.loadUint(16),
    redeemFeeBps = peg.loadUint(16);
  peg.loadUint(16);
  const haircuts = [peg.loadUint(16), peg.loadUint(16), peg.loadUint(16)];
  end(peg);
  return {
    amp,
    feeBps,
    totalSupply,
    balances,
    fees,
    governance,
    root,
    level,
    outageMask,
    frozenMask,
    mintFeeBps,
    redeemFeeBps,
    haircuts,
    referral,
    dataHash: wrapper.hash().toString('hex'),
  };
}
/** Source-equivalent integer math for healthy redemption fee attribution only.
 * No quote is used as delivery evidence. The resulting net basket must equal all authenticated receipts. */
export function redemptionFees(
  state: ReturnType<typeof t3State>,
  amountRaw: string,
  mode: number,
  target: number,
) {
  if (
    state.level >= 3 ||
    state.outageMask ||
    state.frozenMask ||
    state.amp <= 0 ||
    state.redeemFeeBps > 10000 ||
    state.haircuts.some((v) => v > 10000)
  )
    return null;
  const balances = state.balances.map(BigInt),
    supply = BigInt(state.totalSupply),
    amount = BigInt(amountRaw),
    ann = BigInt(state.amp) * 3n;
  if (amount <= 0n || amount > supply) return null;
  const abs = (v: bigint) => (v < 0n ? -v : v);
  let d = balances.reduce((a, b) => a + b, 0n);
  if (d > 0n) {
    const sum = d;
    let converged = false;
    for (let i = 0; i < 96; i++) {
      let p = d;
      for (const b of balances) p = b === 0n ? 0n : (p * d) / (b * 3n);
      const den = (ann - 1n) * d + 4n * p;
      if (den === 0n) {
        converged = true;
        break;
      }
      const next = ((ann * sum + p * 3n) * d) / den;
      if (abs(next - d) <= 1n) {
        d = next;
        converged = true;
        break;
      }
      d = next;
    }
    if (!converged) return null;
  }
  const remaining = supply - amount,
    d1 = (d * remaining) / supply;
  let gross: bigint[];
  if (mode === 1 && balances[target] > 0n && d > 0n) {
    let y = 0n;
    if (d1 > 0n) {
      let c = d1,
        sum = 0n;
      for (let i = 0; i < 3; i++)
        if (i !== target) {
          const b = balances[i];
          if (b > 0n) {
            sum += b;
            c = (c * d1) / (b * 3n);
          } else c = 0n;
        }
      c = (c * d1) / (ann * 3n);
      const b = sum + d1 / ann;
      y = d1;
      let converged = false;
      for (let i = 0; i < 96; i++) {
        const den = 2n * y + b - d1;
        if (den === 0n) {
          converged = true;
          break;
        }
        const next = (y * y + c) / den;
        if (abs(next - y) <= 1n) {
          y = next;
          converged = true;
          break;
        }
        y = next;
      }
      if (!converged) return null;
    }
    gross = balances.map((b, i) => (i === target ? b - y : 0n));
  } else
    gross = balances.map(
      (b) =>
        b -
        (remaining === 0n
          ? 0n
          : d === 0n
            ? (b * remaining) / supply
            : (b * d1) / d),
    );
  const preFee = gross.map((v, i) =>
      mode === 1 && i !== target
        ? v
        : (v * BigInt(10000 - state.haircuts[i])) / 10000n,
    ),
    net = preFee.map((v) => (v * BigInt(10000 - state.redeemFeeBps)) / 10000n);
  if ([...gross, ...net].some((v) => v < 0n)) return null;
  return {
    net: net.map(String),
    fees: preFee.map((v, i) => (v - net[i]).toString()),
  };
}

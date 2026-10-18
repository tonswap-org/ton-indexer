import { Address, Cell, type Slice } from '@ton/core';
import type { RuntimeReleaseManifest, RuntimeRole } from '../config/runtimeManifest';
import type { LedgerEvidenceRef } from './types';
import type { Node, ProjectionInput } from './project';
import { chainCoversTransaction } from './project';
import { canonicalLedgerHash } from './normalize';
import { currentT3OriginalBoundary } from './currentT3Proof';
import { currentT3ActiveState, verifySpotMessageLink, type CurrentT3Transaction } from './currentDlmmPhysical';
import type { RawMessage } from '../data/dataSource';
import { decodeSwapEvent } from './currentDlmmState';

type Fields = Record<string, string | number | boolean | null>;
export type CurrentProtocolRole = RuntimeRole | 'DlmmPool';
export type CurrentProtocolObservation = {
  schema: 'tonswap-contract-observation-v1';
  role: CurrentProtocolRole;
  source: 'external-log' | 'successful-call';
  name: string;
  opcode: string;
  fields: Fields;
  bodyHash: string;
  codeHash: string;
  transaction: LedgerEvidenceRef;
  /** Original causal chain to the owned account. These observations create no cash movements. */
  evidence: LedgerEvidenceRef[];
};

const HOLDERS = new Set<CurrentProtocolRole>([
  'Governance', 'Treasury', 'BuybackExecutor', 'FeeRouter', 'SwapCoordinator',
  'EmissionsSplitter', 'RiskVault', 'PerpsEngine', 'OptionVault', 'MerkleClaim',
  'Remint', 'TestnetFaucet', 'CoverVault', 'DlmmPool',
]);
const SINGLETONS = new Set<CurrentProtocolRole>([...HOLDERS, 'GenesisDistributor', 'GasVault', 'ReferralRegistry']);
export function currentProtocolPins(release: RuntimeReleaseManifest) {
  const pins = new Map<string, { role: CurrentProtocolRole; codeHash: string }>();
  for (const [role, pin] of Object.entries(release.contracts)) {
    if (!pin || !SINGLETONS.has(role as RuntimeRole)) continue;
    if (pins.has(pin.address)) return new Map<string, { role: CurrentProtocolRole; codeHash: string }>();
    pins.set(pin.address, { role: role as RuntimeRole, codeHash: pin.codeHash });
  }
  for (const market of release.spotMarkets) {
    if (pins.has(market.pool)) return new Map<string, { role: CurrentProtocolRole; codeHash: string }>();
    pins.set(market.pool, { role: 'DlmmPool', codeHash: release.templates.DlmmPool });
  }
  return pins;
}
const address = (s: Slice) => s.loadAddress().toRawString();
const uint = (s: Slice, bits: number) => s.loadUintBig(bits).toString();
const coins = (s: Slice) => s.loadCoins().toString();
const digest = (s: Slice) => s.loadUintBig(256).toString(16).padStart(64, '0');
const OBSERVATION_OPS = new Set([
  0x47484556, 0x47504556, 0x47564556, 0x474c4556, 0x474e4556,
  0x4d434556, 0x524d4556, 0x54504556, 0x52544533, 0x42424556,
  0x4a4f5743, 0x4a415243, 0x4756544b, 0x4652464c, 0x52524c4b, 0x434c4d4a,
  0x53574533,
]);

/** Exact current wire facts. A dispatch, event amount or successful claim call
 * never establishes target execution, token delivery or additional spendable cash. */
export function decodeCurrentProtocolBody(role: CurrentProtocolRole, body: Cell, source: CurrentProtocolObservation['source']) {
  if (body.isExotic || body.bits.length < 32) return null;
  try {
    const s = body.beginParse(), op = s.loadUint(32);
    let name: string, fields: Fields;
    if (source === 'external-log') {
      if (role === 'DlmmPool' && op === 0x53574533) {
        const e = decodeSwapEvent(body); if (!e) return null;
        return { name: 'pool-swap', opcode: '0x53574533', fields: { queryId: e.queryId.toString(), origin: e.origin.toRawString(),
          inSide: e.inSide, status: e.status, reason: e.reason, amountInRaw: e.amountIn.toString(), amountOutRaw: e.amountOut.toString(),
          grossFeeT3Raw: e.grossFeeT3.toString(), protocolFeeT3Raw: e.protocolFeeT3.toString(), activeBin: e.activeBin, binsLoaded: e.binsLoaded } as Fields };
      } else if (role === 'Governance' && op === 0x47484556) {
        name = 'governance-handoff';
        fields = { policyRoot: digest(s), policyCount: s.loadUint(16), master: address(s),
          genesisTotalRaw: uint(s, 120), supplyBaseRaw: uint(s, 120), gated: s.loadBit() };
      } else if (role === 'Governance' && op === 0x47504556) {
        name = 'governance-proposal';
        fields = { kind: s.loadUint(8), id: s.loadUint(32), class: s.loadUint(2), proposer: address(s),
          eta: s.loadUint(32), actionsHash: digest(s) };
      } else if (role === 'Governance' && op === 0x47564556) {
        name = 'governance-vote';
        fields = { id: s.loadUint(32), voter: address(s), support: s.loadUint(2),
          quorumPrincipalRaw: coins(s), voteWeightRaw: uint(s, 122) };
      } else if (role === 'Governance' && op === 0x474c4556) {
        name = 'governance-lock';
        fields = { kind: s.loadUint(8), owner: address(s), amountRaw: coins(s), commitUntil: s.loadUint(32), bucket: s.loadUint(32) };
      } else if (role === 'GenesisDistributor' && op === 0x474e4556) {
        name = 'genesis-dispatch';
        fields = { master: address(s), merkleClaim: address(s), remint: address(s), totalRaw: uint(s, 120) };
      } else if (role === 'MerkleClaim' && op === 0x4d434556) {
        name = 'merkle-claim';
        fields = { kind: s.loadUint(8), index: s.loadUint(32), recipient: address(s), amountRaw: uint(s, 120) };
      } else if (role === 'Remint' && op === 0x524d4556) {
        name = 'remint-accounting';
        fields = { kind: s.loadUint(8), day: s.loadUint(32), amountRaw: coins(s), rateBps: s.loadUint(16) };
      } else if (role === 'Treasury' && op === 0x54504556) {
        name = 'treasury-dispatch';
        fields = { kind: s.loadUint(8), slot: s.loadUint(8), amountRaw: coins(s), recipient: address(s) };
      } else if (role === 'SwapCoordinator' && op === 0x52544533) {
        name = 'route-continuation';
        fields = { queryId: uint(s, 64), status: s.loadUint(8), reason: s.loadUint(8), amountRaw: coins(s),
          pool: s.loadMaybeAddress()?.toRawString() ?? null, beneficiary: address(s) };
      } else if (role === 'BuybackExecutor' && op === 0x42424556) {
        name = 'buyback-dispatch';
        fields = { queryId: uint(s, 64), amountRaw: coins(s), minOutRaw: coins(s), referencePriceE9: uint(s, 128) };
      } else if (HOLDERS.has(role) && op === 0x4a4f5743) {
        name = 'owed-accounting';
        fields = { slot: s.loadUint(8), owner: address(s), amountRaw: coins(s), reason: s.loadUint(8) };
      } else if (HOLDERS.has(role) && op === 0x4a415243) {
        name = 'owed-archived';
        fields = { slot: s.loadUint(8), id: uint(s, 64), owner: address(s), amountRaw: coins(s) };
      } else return null;
    } else if (role === 'GasVault' && op === 0x4756544b) {
      name = 'gas-tick-call'; fields = { queryId: uint(s, 64), jobId: s.loadUint(32) };
    } else if (role === 'FeeRouter' && op === 0x4652464c) {
      name = 'fee-flush-call'; fields = { queryId: uint(s, 64) };
    } else if (role === 'ReferralRegistry' && op === 0x52524c4b) {
      name = 'referral-link'; fields = { queryId: uint(s, 64), sponsor: address(s) };
    } else if (HOLDERS.has(role) && op === 0x434c4d4a) {
      name = 'owed-claim-call'; fields = { queryId: uint(s, 64), slot: s.loadUint(8), owner: address(s) };
    } else return null;
    s.endParse();
    return { name, opcode: `0x${op.toString(16).padStart(8, '0')}`, fields };
  } catch { return null; }
}

const ref = (n: Node): LedgerEvidenceRef => ({ account: n.account, lt: n.raw.lt,
  hash: canonicalLedgerHash(n.raw.hash), utime: n.raw.utime });
const rawAddress = (value?: string) => {
  try { return value ? Address.parse(value).toRawString() : null; } catch { return null; }
};

/** Candidate selection only. Shared-contract history is never an owner root;
 * every admitted observation still verifies each full original message below. */
export function ownerConnectedProtocolNodes(nodes: readonly Node[], ownedAccounts?: ReadonlySet<string>): Set<Node> {
  const messageKey = (m: RawMessage | undefined) => {
    const source = rawAddress(m?.source), destination = rawAddress(m?.destination);
    return source && destination && m?.createdLt && /^[1-9][0-9]*$/.test(m.createdLt)
      ? `${source}:${destination}:${m.createdLt}` : null;
  };
  const incoming = new Map<string, Node[]>();
  for (const n of nodes) { const k = messageKey(n.raw.inMessage); if (k) incoming.set(k, [...(incoming.get(k) ?? []), n]); }
  const connected = new Set(nodes.filter(n => ownedAccounts ? ownedAccounts.has(n.account) : n.event)), queue = [...connected];
  for (let index = 0; index < queue.length; index++) for (const message of queue[index].raw.outMessages) {
    const k = messageKey(message);
    for (const n of k ? incoming.get(k) ?? [] : []) if (!connected.has(n)) { connected.add(n); queue.push(n); }
  }
  return connected;
}

/** Only release-pinned singleton code can produce these observations. Missing
 * originals or causal links omit a fact; they never turn an unresolved payment
 * into a confirmed one. The existing financial projection remains authoritative. */
export async function projectCurrentProtocolObservations(
  input: ProjectionInput & { currentProtocolRelease?: RuntimeReleaseManifest }, nodes: readonly Node[],
): Promise<Map<string, CurrentProtocolObservation[]>> {
  const result = new Map<string, CurrentProtocolObservation[]>(), release = input.currentProtocolRelease;
  if (!release || release.network !== `ton:${input.network}`) return result;
  const connected = ownerConnectedProtocolNodes(nodes);
  const pins = currentProtocolPins(release);
  let boundaries = 0, count = 0;
  const originals = new Map<Node, Promise<CurrentT3Transaction | null>>();
  const original = (n: Node) => {
    let pending = originals.get(n);
    if (!pending) {
      pending = (async () => {
        if (++boundaries > 64 || !n.raw.rawBoc || !n.raw.prevTransactionLt || !n.raw.prevTransactionHash
          || !chainCoversTransaction(input.chains.get(n.account), n.raw)) return null;
        try {
          const before = await input.stateAt(n.account, n.raw.prevTransactionLt, n.raw.prevTransactionHash),
            after = await input.stateAt(n.account, n.raw.lt, n.raw.hash);
          if (!before || !after) return null;
          return { account: n.account, ...currentT3OriginalBoundary(n, before, after) };
        } catch { return null; }
      })();
      originals.set(n, pending);
    }
    return pending;
  };
  const ownedAncestor = async (n: Node, t: CurrentT3Transaction) => {
    const evidence: LedgerEvidenceRef[] = [ref(n)];
    for (let depth = 0; depth < 16; depth++) {
      if (n.event) return { anchor: n, evidence };
      const incoming = t.tx.inMessage;
      if (incoming?.info.type !== 'internal') return null;
      const sender = incoming.info.src.toRawString(), createdLt = incoming.info.createdLt.toString();
      // Candidate summaries only bound the search. Full committed messages decide linkage below.
      const parents: { node: Node; tx: CurrentT3Transaction }[] = [];
      for (const p of nodes.filter(p => p.account === sender && BigInt(p.raw.lt) < t.tx.lt
        && p.raw.outMessages.some(m => rawAddress(m.destination) === n.account && m.createdLt === createdLt))) {
        const tx = await original(p);
        if (tx && verifySpotMessageLink(tx, t)) parents.push({ node: p, tx });
      }
      if (parents.length !== 1) return null;
      n = parents[0].node; t = parents[0].tx; evidence.push(ref(n));
    }
    return null;
  };
  for (const n of nodes) {
    const pin = pins.get(n.account);
    // Summaries select candidates only; original authenticated cells determine every fact.
    if (!connected.has(n) || !pin || !n.raw.success || ![n.raw.inMessage, ...n.raw.outMessages]
      .some(m => m?.op !== undefined && OBSERVATION_OPS.has(m.op))) continue;
    const t = await original(n);
    if (!t?.succeeded) continue;
    try {
      // Require original active code on both sides; StateInit and upgrade guesses are unsupported.
      currentT3ActiveState(t.before, pin.codeHash); currentT3ActiveState(t.after, pin.codeHash);
      const entries: { source: CurrentProtocolObservation['source']; body: Cell }[] = [];
      if (t.tx.inMessage?.info.type === 'internal' && !t.tx.inMessage.info.bounced)
        entries.push({ source: 'successful-call', body: t.tx.inMessage.body });
      for (const m of t.tx.outMessages.values()) if (m.info.type === 'external-out')
        entries.push({ source: 'external-log', body: m.body });
      const decoded = entries.flatMap(entry => {
        const body = decodeCurrentProtocolBody(pin.role, entry.body, entry.source);
        return body ? [{ ...body, source: entry.source, bodyHash: entry.body.hash().toString('hex') }] : [];
      });
      if (!decoded.length || decoded.length > 64 || count + decoded.length > 256) continue;
      const owner = await ownedAncestor(n, t);
      if (!owner) continue;
      const observations = decoded.map(d => ({ schema: 'tonswap-contract-observation-v1' as const, role: pin.role,
        ...d, codeHash: pin.codeHash, transaction: ref(n), evidence: owner.evidence }));
      count += observations.length;
      result.set(owner.anchor.id, [...(result.get(owner.anchor.id) ?? []), ...observations]);
    } catch { /* Missing current authority remains unavailable. */ }
  }
  return result;
}

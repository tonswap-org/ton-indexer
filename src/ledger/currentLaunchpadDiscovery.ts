import type { ShardAccount } from '@ton/core';
import { activeOrderAccount } from '../orders/evidence';
import { decodeLaunchFactory, decodeLaunchLp, decodeLaunchSale, decodeLaunchVesting, launchChildAddress } from './currentLaunchpadState';
import { launchpadChildState, need, raw, type CurrentLaunchpadBinding } from './currentLaunchpadProof';

/** Empty-forward project-token supplies have no product opcode. Probe their
 * recipients against exact current code and canonical child derivation before
 * admitting discovery dependencies; an ordinary token recipient is not a child. */
export async function discoverCurrentLaunchpadSupplies(candidates: readonly string[], binding: CurrentLaunchpadBinding,
  read: (account: string) => Promise<ShardAccount>, limit: number) {
  need(candidates.length <= limit);
  const children: string[] = [];
  for (const account of new Set(candidates)) {
    try {
      const child = launchpadChildState(account, await read(account), binding);
      if (child.config && (child.identity.role === 0 || child.identity.role === 2)) children.push(account);
    } catch { /* An optional generic transfer recipient is not product authority. */ }
  }
  return children;
}

/** Current discovery determines bounded dependencies only. Business acceptance
 * and physical cash still require original transaction boundaries. */
export async function discoverCurrentLaunchpad(owner: string, candidates: readonly string[], binding: CurrentLaunchpadBinding,
  read: (account: string) => Promise<ShardAccount>, limit: number) {
  need(candidates.length <= limit);
  const m = binding.manifest, factory = m.contracts.SaleFactory!;
  const f = decodeLaunchFactory(activeOrderAccount(await read(factory.address), factory.codeHash).data);
  const pins = [m.templates.SaleFixed, m.templates.SaleBonding, m.templates.SaleAuction, m.templates.LpVault, m.templates.VestingVault];
  need(raw(f.governance) === m.contracts.Governance!.address && raw(f.t3Master) === m.contracts.T3Hub!.address
    && raw(f.feeSink) === m.contracts.FeeRouter!.address && raw(f.dlmmFactory) === m.contracts.DlmmPoolFactory!.address
    && f.codes.size === 5 && pins.every((pin, i) => f.codes.get(i)?.code.hash().toString('hex') === pin));
  const accounts = new Set<string>([factory.address, m.contracts.T3Hub!.address]);
  const children = new Set<string>(), walletOwners = new Map<string, { root: string; owner: string }>();
  const queue = [...new Set(candidates)];
  while (queue.length) {
    const account = queue.shift()!; if (children.has(account)) continue;
    need(children.size < limit);
    const c = launchpadChildState(account, await read(account), binding); need(c.config);
    const id = c.identity, sale = raw(launchChildAddress({ ...id, role: 0 }, f.codes.get(id.kind)!.code))!;
    const lp = raw(launchChildAddress({ ...id, role: 1 }, f.codes.get(3)!.code))!;
    const vest = raw(launchChildAddress({ ...id, role: 2 }, f.codes.get(4)!.code))!;
    const peers = new Set<string>([sale, lp]), beneficiaries = new Set<string>([owner, account, raw(id.creator)!, raw(f.feeSink)!]);
    if (id.role === 0) {
      const s = decodeLaunchSale(c); need(raw(s.lpVault) === lp && (!s.vestingVault || raw(s.vestingVault) === vest));
      beneficiaries.add(raw(s.terms.lpRecipient)!); if (s.vestingVault) { peers.add(vest); beneficiaries.add(raw(s.terms.vesting?.beneficiary)!); }
    } else if (id.role === 1) {
      const s = decodeLaunchLp(c); need(raw(s.sale) === sale && raw(s.dlmmFactory) === m.contracts.DlmmPoolFactory!.address);
      beneficiaries.add(raw(s.lpRecipient)!); if (s.pool) { accounts.add(raw(s.pool)!); accounts.add(raw(s.dlmmFactory)!); beneficiaries.add(raw(s.pool)!); }
    } else { const s = decodeLaunchVesting(c); need(raw(s.sale) === sale); beneficiaries.add(raw(s.terms.beneficiary)!); }
    children.add(account); accounts.add(account);
    for (const peer of peers) if (!children.has(peer)) queue.push(peer);
    for (const slot of c.slots.values()) {
      const root = raw(slot.master)!; accounts.add(root); if (slot.wallet) accounts.add(raw(slot.wallet)!);
      for (const recipient of beneficiaries) { need(recipient); walletOwners.set(`${root}:${recipient}`, { root, owner: recipient }); }
    }
    need(accounts.size <= limit && walletOwners.size <= limit);
  }
  return { accounts: [...accounts], children: [...children], walletOwners: [...walletOwners.values()] };
}

/** Public notification destinations for the current first-release app.
 * Tests bind these paths to its route manifest; the deployed service stands alone. */
export const NOTIFICATION_DESTINATIONS = Object.freeze({
  wallet: '/wallet',
  swap: '/swap',
  governance: '/earn/vote',
  settings: '/settings/notifications',
});

export function walletNotificationLink(txId: string): string {
  if (!txId || txId.length > 256 || /[^A-Za-z0-9_:+/=-]/.test(txId))
    throw new Error('notification_transaction_identity_invalid');
  return `${NOTIFICATION_DESTINATIONS.wallet}?tx=${encodeURIComponent(txId)}`;
}

export function governanceNotificationLink(proposalId: string): string {
  if (!/^[1-9]\d{0,19}$/.test(proposalId) || /\s/.test(proposalId) || BigInt(proposalId) >= (1n << 64n))
    throw new Error('notification_proposal_identity_invalid');
  return `${NOTIFICATION_DESTINATIONS.governance}?proposal=${encodeURIComponent(proposalId)}`;
}

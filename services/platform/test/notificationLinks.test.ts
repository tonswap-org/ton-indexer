import { describe, expect, it } from 'vitest';
import { governanceNotificationLink, walletNotificationLink } from '../src/notificationLinks.js';

describe('first-release notification navigation contract', () => {
  it('retains an opaque transaction identity exactly once through URL encoding', () => {
    const txId = '9007199254740993:aB+/==';
    const url = new URL(walletNotificationLink(txId), 'https://app.example.test');
    expect(url.pathname).toBe('/wallet'); expect(url.searchParams.get('tx')).toBe(txId);
    expect([...url.searchParams.keys()]).toEqual(['tx']);
  });
  it.each(['', 'a'.repeat(257), 'tx&proposal=2', 'https://other.test', '\ntransaction', 'transaction\n'])('rejects an unusable transaction link identity', txId => {
    expect(() => walletNotificationLink(txId)).toThrow('notification_transaction_identity_invalid');
  });
  it.each(['1', '18446744073709551615'])('links proposal %s to the voting screen without numeric precision loss', id => {
    const url = new URL(governanceNotificationLink(id), 'https://app.example.test');
    expect(url.pathname).toBe('/earn/vote'); expect(url.searchParams.get('proposal')).toBe(id);
  });
  it.each(['0', '01', '-1', '1&tx=other', '18446744073709551616', '9'.repeat(21), '1\n'])('rejects an invalid proposal identity', id => {
    expect(() => governanceNotificationLink(id)).toThrow('notification_proposal_identity_invalid');
  });
});

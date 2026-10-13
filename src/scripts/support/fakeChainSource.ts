import type { ChainSource } from '../../data/dataSource';

export function fakeChainSource(overrides: Partial<ChainSource> = {}): ChainSource {
  const unexpected = (name: string): never => { throw new Error(`unexpected chain read: ${name}`); };
  return {
    network: 'testnet', head: async () => unexpected('head'), read: async () => unexpected('read'),
    getAccountState: async () => unexpected('getAccountState'), runGetMethod: async () => unexpected('runGetMethod'),
    getAccountStateAtSeqno: async () => unexpected('getAccountStateAtSeqno'),
    getAccountStateAtTransaction: async () => unexpected('getAccountStateAtTransaction'),
    getTransactions: async () => unexpected('getTransactions'), sendMessage: async () => unexpected('sendMessage'),
    health: () => unexpected('health'), close: async () => unexpected('close'), ...overrides,
  };
}

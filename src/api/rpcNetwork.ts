import type { Network } from '../config';

// Public-network zero states from https://ton-blockchain.github.io/global.config.json
// and https://ton-blockchain.github.io/testnet-global.config.json.
// An endpoint's URL is not its identity.
export const PUBLIC_RPC_ZERO_STATES = {
  mainnet: {
    workchain: -1,
    root_hash: 'F6OpKZKqvqeFp6CQmFomXNMfMj2EnaUSOXN+Mh+wVWk=',
    file_hash: 'XplPz01CXAps5qeSWUtxcyBfdAo5zVb1N979KLSKD24='
  },
  testnet: {
    workchain: -1,
    root_hash: 'gj+B8wb/AmlPk1z1AhVI484rhrUpgSr2oSFIh56VoSg=',
    file_hash: 'Z+IKwYS54DmmJmesw/nAD5DzWadnOCMzee+kdgSYDOg='
  }
} as const;

export const matchesPublicRpcNetwork = (
  masterchainInfo: unknown,
  network: Exclude<Network, 'localnet'>
): boolean => {
  if (!masterchainInfo || typeof masterchainInfo !== 'object' || Array.isArray(masterchainInfo)) return false;
  const init = (masterchainInfo as { init?: unknown }).init;
  if (!init || typeof init !== 'object' || Array.isArray(init)) return false;
  const actual = init as Record<string, unknown>;
  const expected = PUBLIC_RPC_ZERO_STATES[network];
  return actual.workchain === expected.workchain &&
    actual.root_hash === expected.root_hash && actual.file_hash === expected.file_hash;
};

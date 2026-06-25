const MAINNET_PLACEHOLDER_PREFIX = 'REPLACE_WITH_MAINNET_';

export const REQUIRED_MAINNET_REGISTRY_KEYS = [
  'ClmmRouter',
  'ClmmPoolFactory',
  'FeeRouter',
  'Treasury',
  'ReferralRegistry',
  'T3Root',
  'TSRoot',
  'UsdtRoot',
  'UsdcRoot',
  'KusdRoot',
  'DlmmRegistry',
  'DlmmPoolFactory'
] as const;

export const isLikelyTonAddress = (value: string) =>
  /^([A-Za-z0-9_-]{48}|-?\d+:[0-9a-fA-F]{64})$/.test(value.trim());

export const validateMainnetRegistry = (registry: Record<string, string>) => {
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const key of REQUIRED_MAINNET_REGISTRY_KEYS) {
    const value = registry[key];
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || trimmed.startsWith(MAINNET_PLACEHOLDER_PREFIX)) {
      missing.push(key);
      continue;
    }
    if (!isLikelyTonAddress(trimmed)) {
      invalid.push(key);
    }
  }
  if (!missing.length && !invalid.length) return;
  const parts: string[] = [];
  if (missing.length) parts.push(`missing/placeholder keys: ${missing.join(', ')}`);
  if (invalid.length) parts.push(`invalid address format keys: ${invalid.join(', ')}`);
  throw new Error(`Mainnet registry validation failed: ${parts.join(' | ')}`);
};

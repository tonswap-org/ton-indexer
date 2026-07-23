import { Address } from '@ton/core';

export const MAINNET_PLACEHOLDER_PREFIX = 'REPLACE_WITH_MAINNET_';

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

type MainnetRegistryIssueReason = 'missing_or_placeholder' | 'invalid_address' | 'testnet_only_address';

export type MainnetRegistryIssue = {
  key: string;
  reason: MainnetRegistryIssueReason;
};

const parseMainnetAddress = (value: string): MainnetRegistryIssueReason | null => {
  try {
    if (Address.isRaw(value)) {
      Address.parseRaw(value);
      return null;
    }
    const friendly = Address.parseFriendly(value);
    if (friendly.isTestOnly) return 'testnet_only_address';
    return null;
  } catch {
    return 'invalid_address';
  }
};

export const collectMainnetRegistryIssues = (registry: Record<string, string>): MainnetRegistryIssue[] => {
  const issues: MainnetRegistryIssue[] = [];
  for (const key of REQUIRED_MAINNET_REGISTRY_KEYS) {
    const value = registry[key];
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || trimmed.startsWith(MAINNET_PLACEHOLDER_PREFIX)) {
      issues.push({ key, reason: 'missing_or_placeholder' });
      continue;
    }
    const addressIssue = parseMainnetAddress(trimmed);
    if (addressIssue) {
      issues.push({ key, reason: addressIssue });
    }
  }
  return issues;
};

export const validateMainnetRegistry = (registry: Record<string, string>) => {
  const issues = collectMainnetRegistryIssues(registry);
  if (!issues.length) return;

  const missing = issues.filter((issue) => issue.reason === 'missing_or_placeholder').map((issue) => issue.key);
  const invalid = issues.filter((issue) => issue.reason === 'invalid_address').map((issue) => issue.key);
  const testnetOnly = issues.filter((issue) => issue.reason === 'testnet_only_address').map((issue) => issue.key);
  const parts: string[] = [];
  if (missing.length) parts.push(`missing/placeholder keys: ${missing.join(', ')}`);
  if (invalid.length) parts.push(`invalid address keys: ${invalid.join(', ')}`);
  if (testnetOnly.length) parts.push(`testnet-only address keys: ${testnetOnly.join(', ')}`);
  throw new Error(`Mainnet registry validation failed: ${parts.join(' | ')}`);
};

import { Address } from '@ton/core';

export const isValidAddress = (value: string): boolean => {
  try {
    Address.parse(value);
    return true;
  } catch {
    return false;
  }
};

export const parsePositiveInt = (value?: string) => {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

export const isValidHashBase64 = (value: string): boolean => {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return false;
  if (/[+/]/.test(value) && /[-_]/.test(value)) return false;
  const standardInput = value.replace(/-/g, '+').replace(/_/g, '/');
  const unpadded = standardInput.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return false;
  const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, '=');
  const decoded = Buffer.from(padded, 'base64');
  const canonical = decoded.toString('base64');
  return (
    decoded.length === 32 &&
    (standardInput === canonical || standardInput === canonical.replace(/=+$/, ''))
  );
};

export const isValidLt = (value: string): boolean => {
  return /^\d+$/.test(value);
};

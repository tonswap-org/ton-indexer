import { Address } from 'ton-core';

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

const normalizeBase64 = (input: string) => {
  let value = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = value.length % 4;
  if (pad === 2) value += '==';
  if (pad === 3) value += '=';
  if (pad === 1) return null;
  return value;
};

export const isValidHashBase64 = (value: string): boolean => {
  const normalized = normalizeBase64(value);
  if (!normalized) return false;
  try {
    const buf = Buffer.from(normalized, 'base64');
    return buf.length === 32;
  } catch {
    return false;
  }
};

export const isValidLt = (value: string): boolean => {
  return /^\d+$/.test(value);
};

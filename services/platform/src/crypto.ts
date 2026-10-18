import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
export const token = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function constantEquals(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function encrypt(value: unknown, key: Buffer): string {
  const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64');
}
export function decrypt<T>(value: string, key: Buffer): T {
  const packed = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12));
  cipher.setAuthTag(packed.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(packed.subarray(28)), cipher.final()]).toString()) as T;
}

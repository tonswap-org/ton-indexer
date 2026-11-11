import { createHash } from 'node:crypto';
import { Address, Cell, contractAddress, loadStateInit, type Slice, type StateInit } from '@ton/core';
import { signVerify } from '@ton/crypto';
import { WalletContractV1R1, WalletContractV1R2, WalletContractV1R3, WalletContractV2R1, WalletContractV2R2,
  WalletContractV3R1, WalletContractV3R2, WalletContractV4, WalletContractV5R1 } from '@ton/ton';
import { ApiError } from './errors.js';
export interface TonProofInput {
  address: string; publicKey: string; walletStateInit: string;
  proof: { timestamp: number; domain: { lengthBytes: number; value: string }; signature: string; payload: string };
}
const sha256 = (value: Buffer) => createHash('sha256').update(value).digest();
const v1 = (slice: Slice) => { slice.skip(32); return slice.loadBuffer(32); };
const v3 = (slice: Slice) => { slice.skip(64); return slice.loadBuffer(32); };
const v5 = (slice: Slice) => { slice.skip(65); return slice.loadBuffer(32); };
const zero = { publicKey: Buffer.alloc(32), workchain: 0 };
const wallets = [
  ...[WalletContractV1R1, WalletContractV1R2, WalletContractV1R3, WalletContractV2R1, WalletContractV2R2]
    .map(contract => ({ code: contract.create(zero).init.code, load: v1 })),
  ...[WalletContractV3R1, WalletContractV3R2, WalletContractV4].map(contract => ({ code: contract.create(zero).init.code, load: v3 })),
  { code: WalletContractV5R1.create(zero).init.code, load: v5 },
];
export function extractPublicKey(state: StateInit): Buffer | null {
  if (!state.code || !state.data) return null;
  const wallet = wallets.find(wallet => wallet.code.equals(state.code!));
  try { return wallet?.load(state.data.beginParse()) ?? null; } catch { return null; }
}
/** Byte layout follows docs.ton.org/applications/ton-connect/how-to/ton-proof. */
export function proofDigest(address: Address, proof: TonProofInput['proof']): Buffer {
  const wc = Buffer.alloc(4); wc.writeInt32BE(address.workChain);
  const length = Buffer.alloc(4); length.writeUInt32LE(proof.domain.lengthBytes);
  const timestamp = Buffer.alloc(8); timestamp.writeBigUInt64LE(BigInt(proof.timestamp));
  const message = Buffer.concat([Buffer.from('ton-proof-item-v2/'), wc, address.hash, length,
    Buffer.from(proof.domain.value, 'utf8'), timestamp, Buffer.from(proof.payload, 'utf8')]);
  return sha256(Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from('ton-connect'), sha256(message)]));
}
export async function verifyTonProof(input: TonProofInput, expected: {
  domain: string; payload: string; nowSeconds: number;
  resolvePublicKey?: (address: string) => Promise<Buffer | null>;
}): Promise<{ address: string; publicKey: string }> {
  const reject = (reason: string): never => { throw new ApiError(401, 'invalid_proof', reason); };
  if (input.proof.domain.value !== expected.domain || input.proof.domain.lengthBytes !== Buffer.byteLength(expected.domain, 'utf8')) reject('Proof domain mismatch.');
  if (input.proof.payload !== expected.payload) reject('Proof challenge mismatch.');
  const age = expected.nowSeconds - input.proof.timestamp;
  if (!Number.isSafeInteger(input.proof.timestamp) || age < -30 || age > 300) reject('Proof timestamp is outside the accepted window.');
  try {
    const address = Address.parse(input.address);
    const state = loadStateInit(Cell.fromBase64(input.walletStateInit).beginParse());
    if (!contractAddress(address.workChain, state).equals(address)) reject('Wallet state does not derive the claimed address.');
    const publicKey = extractPublicKey(state) ?? await expected.resolvePublicKey?.(address.toRawString());
    if (!publicKey || publicKey.length !== 32 || !/^[a-fA-F0-9]{64}$/.test(input.publicKey) || !publicKey.equals(Buffer.from(input.publicKey, 'hex'))) reject('Wallet public key could not be verified.');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.proof.signature)) reject('Invalid signature encoding.');
    const signature = Buffer.from(input.proof.signature, 'base64');
    if (signature.length !== 64 || !signVerify(proofDigest(address, input.proof), signature, publicKey!)) reject('Invalid wallet signature.');
    return { address: address.toRawString(), publicKey: publicKey!.toString('hex') };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return reject('Wallet proof could not be decoded or verified.');
  }
}

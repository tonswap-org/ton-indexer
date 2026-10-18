import { describe, it, expect } from 'vitest';
import { beginCell, storeStateInit } from '@ton/core';
import { WalletContractV5R1 } from '@ton/ton';
import { sign } from '@ton/crypto';
import { extractPublicKey, proofDigest, verifyTonProof } from '../src/tonProof.js';
import { address, keys, proof, secondAddress } from './helpers.js';

const expected = { domain: 'app.example.test', payload: 'tonswap-platform:testnet:random_challenge_value', nowSeconds: Math.floor(Date.now() / 1000) };
describe('TON ownership proof', () => {
  it('verifies V4 state-init address, extracted public key, and signature', async () => {
    expect(await verifyTonProof(proof(expected.payload), expected)).toEqual({ address, publicKey: keys.publicKey.toString('hex') });
  });
  it('supports the V5 data layout including its signature flag', async () => {
    const wallet = WalletContractV5R1.create({ workchain: 0, publicKey: keys.publicKey });
    expect(extractPublicKey(wallet.init)?.equals(keys.publicKey)).toBe(true);
    const input = proof(expected.payload, { address: wallet.address.toRawString(), walletStateInit: beginCell().store(storeStateInit(wallet.init)).endCell().toBoc().toString('base64') });
    input.proof.signature = sign(proofDigest(wallet.address, input.proof), keys.secretKey).toString('base64');
    await expect(verifyTonProof(input, expected)).resolves.toMatchObject({ address: wallet.address.toRawString() });
  });
  it.each(['address', 'publicKey', 'walletStateInit', 'domain', 'domainLength', 'timestamp', 'future', 'payload', 'signature'])(
    'rejects tampered %s', async field => {
      const input = proof(expected.payload);
      if (field === 'address') input.address = secondAddress;
      if (field === 'publicKey') input.publicKey = 'ff'.repeat(32);
      if (field === 'walletStateInit') input.walletStateInit = beginCell().endCell().toBoc().toString('base64');
      if (field === 'domain') input.proof.domain.value = 'evil.example.test';
      if (field === 'domainLength') input.proof.domain.lengthBytes++;
      if (field === 'timestamp') input.proof.timestamp -= 301;
      if (field === 'future') input.proof.timestamp += 40;
      if (field === 'payload') input.proof.payload += 'different';
      if (field === 'signature') input.proof.signature = Buffer.alloc(64).toString('base64');
      await expect(verifyTonProof(input, expected)).rejects.toMatchObject({ code: 'invalid_proof' });
    });
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Address, beginCell, Cell, convertToMerkleProof, Dictionary, storeShardAccount } from '@ton/core';
import { readLaunchpadProjectToken } from '../runtime/launchpadEvidenceState';
import { runtimeAddress, runtimeManifestFixture } from './fixtures/runtimeManifest';
import { fakeChainSource } from './support/fakeChainSource';
import { fixtureHead } from './support/chainFixture';

async function main() {
  const manifest = runtimeManifestFixture(), root = runtimeAddress(999), head = fixtureHead(500, Math.floor(Date.now() / 1000));
  const master = beginCell().storeUint(1, 8).endCell(), wallet = beginCell().storeUint(2, 8).endCell();
  manifest.templates.JettonV21Minter = master.hash().toString('hex'); manifest.templates.JettonV21Wallet = wallet.hash().toString('hex');
  let code = master, walletCode = wallet, text: string | null = '6', offchain = false, wrongAddress = false, absent = false;
  const source = fakeChainSource({ getAccountState: async (address, options) => {
    assert.equal(address, root); assert.deepEqual(options?.at, head);
    return { accountState: 'active', balance: '100', anchor: { shardBlock: { ...head, workchain: 0 }, genUtime: head.utime },
      shardAccountBoc: absent ? undefined : beginCell().store(storeShardAccount({ lastTransactionLt: 1n, lastTransactionHash: 1n,
        account: { addr: Address.parse(wrongAddress ? runtimeAddress(998) : root), storageStats: { used: { cells: 1n, bits: 1n }, storageExtra: null, lastPaid: head.utime },
          storage: { lastTransLt: 1n, balance: { coins: 100n }, state: { type: 'active', state: { code, data: Cell.EMPTY, splitDepth: 8 } } } } })).endCell().toBoc().toString('base64') };
  }, runGetMethod: async (address, method, args, options) => {
    assert.equal(address, root); assert.equal(method, 'get_jetton_data'); assert.deepEqual(options?.at, head);
    const fields = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    if (text !== null) fields.set(BigInt('0x' + createHash('sha256').update('decimals').digest('hex')), beginCell().storeUint(0, 8).storeStringTail(text).endCell());
    const content = offchain ? beginCell().storeUint(1, 8).storeStringTail('https://example.invalid/metadata').endCell() : beginCell().storeUint(0, 8).storeDict(fields).endCell();
    return { exitCode: 0, stack: [{ type: 'int', value: 0n }, { type: 'int', value: -1n }, { type: 'null' }, { type: 'cell', cell: content }, { type: 'cell', cell: walletCode }] };
  } });
  const read = () => readLaunchpadProjectToken(manifest, source, root, head);
  assert.deepEqual(await read(), { root, masterCodeHash: master.hash().toString('hex'), walletCodeHash: wallet.hash().toString('hex'), decimals: 6 });
  for (const value of [null, '', '06', '19', '256', 'six', '6\0', '6 ']) { text = value; await assert.rejects(read); } text = '6';
  offchain = true; await assert.rejects(read); offchain = false;
  absent = true; await assert.rejects(read); absent = false; wrongAddress = true; await assert.rejects(read); wrongAddress = false;
  code = wallet; await assert.rejects(read); code = master; walletCode = master; await assert.rejects(read); walletCode = wallet;
  code = convertToMerkleProof(master); manifest.templates.JettonV21Minter = code.hash().toString('hex'); await assert.rejects(read);
  code = new Cell({ exotic: true, bits: beginCell().storeUint(2, 8).storeBuffer(master.hash()).endCell().bits });
  manifest.templates.JettonV21Minter = code.hash().toString('hex'); assert.equal((await read()).decimals, 6, 'exact installed library identity is valid');
  manifest.vendor.stablecoin.minter.codeHash = code.hash().toString('hex'); manifest.vendor.stablecoin.wallet.codeHash = wallet.hash().toString('hex');
  manifest.templates.JettonV21Minter = 'f'.repeat(64); assert.equal((await read()).decimals, 6, 'separate installed vendor family is valid');
  manifest.vendor.stablecoin.wallet.codeHash = master.hash().toString('hex'); await assert.rejects(read);
  manifest.tokens.push({ symbol: 'PROJECT', root, decimals: 9, masterCodeHash: code.hash().toString('hex'), walletCodeHash: wallet.hash().toString('hex') });
  await assert.rejects(read); text = '9'; assert.equal((await read()).decimals, 9);
  const abort = new AbortController(); abort.abort(); await assert.rejects(readLaunchpadProjectToken(manifest, source, root, head, abort.signal));
  console.log('Current project master/wallet pins, original account, exact library code, explicit bounded on-chain precision and refusals passed. Synthetic reader vectors only.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

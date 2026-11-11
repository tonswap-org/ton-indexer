import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Cell, loadShardIdent } from '@ton/core';
import { readAccountAnchor, blockHeaderTime } from '../data/accountAnchor';
import type { ChainHead } from '../data/dataSource';
import { proofBlock, merkleProof, multiProof } from './support/fakeLiteEngine';

async function main() {
  const mc = proofBlock(100, 1_700_000_100, -1), shard = proofBlock(80, 1_700_000_099);
  const head: ChainHead = { workchain: -1, shard: mc.id.shard, seqno: mc.id.seqno,
    rootHashHex: mc.id.rootHash.toString('hex'), fileHashHex: mc.id.fileHash.toString('hex'), utime: 1_700_000_100 };
  const proof = { block: mc.id, shardBlock: shard.id, proof: shard.proof };
  const forbidden = async (): Promise<never> => { throw new Error('Header fallback was unnecessary'); };
  const anchor = await readAccountAnchor(proof, head, forbidden, `0:${'a'.repeat(64)}`);
  assert.equal(anchor.genUtime, 1_700_000_099);
  assert.equal(anchor.shardBlock.rootHashHex, shard.id.rootHash.toString('hex'));
  await assert.rejects(readAccountAnchor({ ...proof, proof: proofBlock(81, 1_700_000_099).proof }, head, forbidden));
  await assert.rejects(readAccountAnchor({ ...proof, block: proofBlock(99, 1_700_000_099, -1).id }, head, forbidden));
  await assert.rejects(readAccountAnchor({ ...proof, proof: multiProof(merkleProof(shard.cell), merkleProof(mc.state)) }, head, forbidden));
  await assert.rejects(readAccountAnchor(proof, { ...head, utime: 1_700_000_098 }, forbidden));
  await assert.rejects(readAccountAnchor(proof, head, forbidden, `-1:${'a'.repeat(64)}`));
  const masterAnchor = await readAccountAnchor({ block: mc.id, shardBlock: mc.id, proof: mc.proof }, head, forbidden, `-1:${'a'.repeat(64)}`);
  assert.equal(masterAnchor.genUtime, head.utime);
  assert.equal(masterAnchor.shardBlock.rootHashHex, head.rootHashHex);

  // Preserve the original recorded native block and its provenance. The header
  // Merkle proof is derived from its full retained bytes, not a synthetic time.
  const directory = join(__dirname, 'fixtures/perps-intermediate-state');
  const bytes = readFileSync(join(directory, 'shard-block.boc'));
  const provenance = JSON.parse(readFileSync(join(directory, 'provenance.json'), 'utf8'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.files['shard-block.boc']);
  const recorded = Cell.fromBoc(bytes)[0], info = recorded.refs[0].beginParse();
  info.skip(32 + 32 + 8 + 8);
  const seqno = info.loadUint(32); info.loadUint(32);
  const identity = loadShardIdent(info), utime = info.loadUint(32);
  const id = { workchain: identity.workchainId, shard: BigInt.asIntN(64, identity.shardPrefix | (1n << BigInt(63 - identity.shardPrefixBits))).toString(),
    seqno, rootHash: recorded.hash(), fileHash: createHash('sha256').update(bytes).digest() };
  assert.equal(blockHeaderTime(recorded, id), utime);
  let headers = 0;
  const recordedAnchor = await readAccountAnchor({ block: mc.id, shardBlock: id, proof: Buffer.alloc(0) }, { ...head, utime }, async block => {
    headers++; assert.deepEqual(block, id); return { id, headerProof: merkleProof(recorded).toBoc() };
  });
  assert.equal(recordedAnchor.genUtime, utime);
  assert.equal(headers, 1);
  await assert.rejects(readAccountAnchor({ block: mc.id, shardBlock: id, proof: Buffer.alloc(0) }, { ...head, utime }, async () => ({ id: shard.id, headerProof: shard.headerProof })));
  console.log('Account anchors: committed shard state, recorded block-header fallback, masterchain accounts and mismatched proofs passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

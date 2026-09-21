import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Address, beginCell, Cell } from '@ton/core';
import { decodeOriginalTransaction } from '../data/transactionEvidence';
import type { RawMessage } from '../data/dataSource';
import { decodeNativeFundingBody, decodeNativeFundingBounce, NATIVE_FUNDING, NATIVE_REFUND } from '../ledger/nativeFunding';
import { bodyCell, businessBodyCell, businessOpcode, nativeFundingRefund, messageKey, tokenWire, SETTLEMENT_INTERNAL } from '../ledger/wire';
import { perpsControl } from '../ledger/perpsWire';
import { matchPhysicalJettonFlow } from '../ledger/jettonFlow';
import { normalizeLedgerEvent } from '../ledger/normalize';
import type { LedgerAsset } from '../ledger/types';
import { loadOpcodes } from '../utils/opcodes';

const directory = join(__dirname, 'fixtures/native-funding-wallet-current');
const provenance = JSON.parse(readFileSync(join(directory, 'provenance.json'), 'utf8'));
function fixture(name: string) {
  const bytes = readFileSync(join(directory, name));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.fixtures.find((f: any) => f.file === name).sha256);
  const capture = JSON.parse(bytes.toString());
  assert.equal(Cell.fromBase64(capture.code.wallet).hash().toString('hex'), capture.code.walletHash);
  const nodes = capture.transactions.map((row: any) => {
    const raw = decodeOriginalTransaction(Cell.fromBase64(row.boc), Address.parse(row.address));
    assert.equal(raw.lt, row.lt); assert.equal(Buffer.from(raw.hash, 'base64').toString('hex'), row.hash);
    return { account: row.address as string, raw };
  });
  return { capture, nodes: nodes as { account: string; raw: ReturnType<typeof decodeOriginalTransaction> }[] };
}
const transfer = fixture('transfer.json'), bounce = fixture('bounce.json');
const opcodes = loadOpcodes();
const source = transfer.nodes.find(n => n.account === transfer.capture.source.address && tokenWire(n.raw.inMessage)?.op === 0x0f8a7ea5)!;
const index = source.raw.outMessages.findIndex(m => tokenWire(m)?.op === SETTLEMENT_INTERNAL);
const output = source.raw.outMessages[index];
const recipient = transfer.nodes.find(n => n.account === transfer.capture.recipient.address)!;
const envelope = bodyCell(output)!;
const decoded = decodeNativeFundingBody(envelope);
const wrap = (body: Cell, correlation = 99n, kind = 0, module = 0) => beginCell().storeUint(NATIVE_FUNDING, 32)
  .storeUint(correlation, 64).storeUint(kind, 8).storeUint(module, 32)
  .storeAddress(Address.parse(decoded.funding!.refundTo)).storeRef(body).endCell();
const message = (body: Cell): RawMessage => ({ ...output, body: body.toBoc().toString('base64') });
const checks: string[] = [];
async function check(name: string, run: () => void | Promise<void>) { await run(); checks.push(name); console.log('PASS', name); }
async function main() {
  await check('original compiled wallet graph preserves full outer identity and strict inner token semantics', () => {
    assert.equal(output.op, NATIVE_FUNDING); assert.equal(output.extraFlagsRaw, '3');
    assert.equal(decoded.funding?.correlationId, '11');
    assert.equal(decoded.businessBody.beginParse().preloadUint(32), SETTLEMENT_INTERNAL);
    assert.equal(businessOpcode(output), SETTLEMENT_INTERNAL);
    assert(bodyCell(output)!.equals(envelope)); assert(businessBodyCell(output)!.equals(decoded.businessBody));
    assert.equal(messageKey(output), messageKey(recipient.raw.inMessage));
    const changed = message(wrap(decoded.businessBody));
    assert.notEqual(messageKey(output), messageKey(changed));
    const canonical = (m: RawMessage) => { const wire = tokenWire(m)!;
      return { ...wire, forward: wire.forward.hash().toString('hex'), custom: wire.custom?.hash().toString('hex') }; };
    assert.deepEqual(canonical(output), canonical(changed));
    assert.equal(bodyCell({ ...output, op: SETTLEMENT_INTERNAL }), null);
  });
  await check('typed cash returns and wallet control tuples decode without inventing values or granting authority', () => {
    const refund = transfer.nodes.flatMap(n => n.raw.outMessages).find(m => m.op === NATIVE_REFUND)!;
    assert.deepEqual(nativeFundingRefund(refund), { correlationId: '11', refundKind: 0, moduleId: 0 });
    assert(BigInt(refund.value!) > 0n);
    const changed = { ...refund, body: beginCell().storeSlice(bodyCell(refund)!.beginParse()).storeCoins(100n).endCell().toBoc().toString('base64') };
    assert.equal(nativeFundingRefund(changed), null, 'Refund has no claimed-value field.');
    const accepted = transfer.nodes.flatMap(n => n.raw.outMessages).find(m => businessOpcode(m) === 0x4a534143)!;
    assert.deepEqual(perpsControl(accepted, 0x4a534143), { queryId: '1', amountRaw: '10', destination: recipient.account });
  });
  await check('physical token flow requires exact original funded edge, endpoints, full request and successful receipt', () => {
    const request = tokenWire(source.raw.inMessage)!, wire = tokenWire(output)!;
    const asset = (wallet: string, owner: string): LedgerAsset => ({ kind: 'jetton', id: 'localnet:test-fixture-root', master: 'fixture-root', wallet, owner });
    const wallets = new Map([[source.account, asset(source.account, wire.owner!)], [recipient.account, asset(recipient.account, request.owner!)]]);
    const matched = matchPhysicalJettonFlow(source, index, wallets, recipient);
    assert.equal(matched.kind, 'matched');
    if (matched.kind === 'matched') { assert.equal(matched.wire.amountRaw, '10'); assert.equal(matched.typed, true); }
    const forged = { ...recipient, raw: { ...recipient.raw, inMessage: message(wrap(decoded.businessBody)) } };
    assert.equal(matchPhysicalJettonFlow(source, index, wallets, forged).kind, 'unresolved');
    assert.equal(matchPhysicalJettonFlow(source, index, wallets, { ...recipient, raw: { ...recipient.raw, status: 'failed', success: false } }).kind, 'unresolved');
  });
  await check('native ledger exactly conserves actual wallet balances for success and real rich-bounce graphs', async () => {
    let flags = 0n;
    for (const { capture, nodes } of [transfer, bounce]) {
      for (const endpoint of [capture.source, capture.recipient]) {
        let delta = 0n;
        for (const node of nodes.filter(n => n.account === endpoint.address)) {
          const event = await normalizeLedgerEvent('localnet', node.account, node.raw, opcodes);
          delta += event.movements.filter(m => m.asset.kind === 'native').reduce((sum, m) => sum + (m.direction === 'in' ? 1n : -1n) * BigInt(m.amountRaw), 0n);
          assert(event.movements.filter(m => m.asset.kind === 'native').every(m => m.evidence.transactionStatus === node.raw.status));
          for (const output of node.raw.outMessages) flags += BigInt(output.extraFlagsRaw ?? '0');
        }
        assert.equal(delta, BigInt(endpoint.afterBalance) - BigInt(endpoint.beforeBalance));
      }
    }
    assert(flags > 0n, 'Actual flags are present; counting them as money breaks the equality.');
  });
  await check('actual full rich bounce retains original funded body including its referenced business payload', () => {
    const bounced = bounce.nodes.flatMap(n => [n.raw.inMessage, ...n.raw.outMessages]).find(m => m?.bounced)!;
    const result = decodeNativeFundingBounce(bodyCell(bounced)!);
    assert.equal(result.funding!.correlationId, '11');
    assert.equal(result.businessBody.beginParse().preloadUint(32), SETTLEMENT_INTERNAL);
    assert(result.businessBody.refs.length > 0);
    const original = bounce.nodes.flatMap(n => n.raw.outMessages).find(m => bodyCell(m)?.equals(result.originalBody));
    assert(original); assert.equal(original.extraFlagsRaw, '3');
    assert.equal(tokenWire(bounced), null, 'Bounce is never decoded as a successful token delivery.');
    assert.throws(() => decodeNativeFundingBounce(beginCell().storeUint(0xffffffff, 32).storeUint(NATIVE_FUNDING, 32).endCell()));
  });
  await check('malformed, trailing and nested funding envelopes fail closed without dropping native movements', async () => {
    const bad = [wrap(decoded.businessBody, 11n, 0, 1), wrap(decoded.businessBody, 11n, 1, 0),
      wrap(envelope), wrap(beginCell().storeUint(NATIVE_REFUND, 32).endCell()),
      beginCell().storeSlice(envelope.beginParse()).storeBit(1).endCell(),
      beginCell().storeSlice(envelope.beginParse()).storeRef(Cell.EMPTY).endCell(),
      beginCell().storeUint(NATIVE_FUNDING, 32).endCell()];
    for (const cell of bad) {
      assert.throws(() => decodeNativeFundingBody(cell)); assert.equal(tokenWire(message(cell)), null);
      const raw = { ...recipient.raw, rawBoc: undefined, inMessage: message(cell) };
      const event = await normalizeLedgerEvent('localnet', recipient.account, raw, opcodes);
      assert(event.issues.includes('native_funding_invalid')); assert(event.movements.some(m => m.asset.kind === 'native'));
      assert(!event.movements.some(m => m.asset.kind !== 'native'));
    }
  });
  console.log(`${checks.length} native funding checks passed; Sandbox capture only, no historical-state qualification claimed.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });

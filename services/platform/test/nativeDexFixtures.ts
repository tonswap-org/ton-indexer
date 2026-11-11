import { Cell, loadShardAccount } from '@ton/core';
import { currentPerpsCaptures } from '../../../src/scripts/support/currentPerpsCaptures.js';
import { currentNativeDexManifest, signDexManifest } from './dexFixtures.js';
import { parseDexReleaseManifest } from '../src/dexPrices.js';

/** Original source-qualified pool/getter cells; the HTTP envelope and release identity are synthetic. */
export function* nativeDexFixtures() {
  for (const { file, capture } of currentPerpsCaptures()) {
    if (!['open-default.json', 'open-x6.json'].includes(file)) continue;
    const snapshot = capture.readSnapshots[0], state = snapshot.response.results[2].stack;
    const slice = Cell.fromBase64(state[0][1].bytes).beginParse();
    const xMaster = slice.loadAddress().toRawString(), binSpacing = slice.loadUint(16), feePips = slice.loadUint(32), xDecimals = slice.loadUint(8);
    const walletGasX = slice.loadUint(32), walletGramX = slice.loadCoins().toString(), budget = slice.loadRef().beginParse(); slice.endParse();
    const walletBudgetX = { senderGas: budget.loadUint(32), walletBounceGas: budget.loadUint(32), burnWalletGas: budget.loadUint(32), smallPayloadCells: budget.loadUint(16),
      largeWalletGas: budget.loadUint(32), largeSenderGas: budget.loadUint(32), rentSeconds: budget.loadUint(32), rentBits: budget.loadUint(32), rentCells: budget.loadUint(16),
      initBits: budget.loadUint(32), initCells: budget.loadUint(16), initCopies: budget.loadUint(8), transferBits: budget.loadUint(16), transferCells: budget.loadUint(8),
      transferCopies: budget.loadUint(8), creditProtection: budget.loadBit() }; budget.endParse();
    const peer = (index: number) => Cell.fromBase64(state[index][1].bytes).beginParse().loadAddress().toRawString();
    const account = (address: string) => {
      const row = capture.currentAccounts.find((row: any) => row.address === address);
      if (!row) throw new Error('Native original root account missing');
      const decoded = loadShardAccount(Cell.fromBase64(row.shardAccountBoc).beginParse()).account!;
      if (decoded.storage.state.type !== 'active' || !decoded.storage.state.state.code || !decoded.storage.state.state.data) throw new Error('Native root is not active');
      return { kind:'account', address, account_state:'active', balance_raw:decoded.storage.balance.coins.toString(),
        code_boc:decoded.storage.state.state.code.toBoc().toString('base64'), data_boc:decoded.storage.state.state.data.toBoc().toString('base64') };
    };
    const pool = snapshot.calls[1].address, t3Root = peer(4), t3 = account(t3Root), x = account(xMaster);
    const manifest = currentNativeDexManifest();
    for (const [role,address] of [['T3Hub',t3Root],['USDT',xMaster],['DlmmPoolFactory',peer(1)],['FeeRouter',peer(2)],['Treasury',peer(3)]]) manifest.contracts[role!].address=address;
    manifest.contracts.T3Hub.codeHash=Cell.fromBase64(t3.code_boc).hash().toString('hex');
    manifest.contracts.USDT.codeHash=Cell.fromBase64(x.code_boc).hash().toString('hex');
    manifest.tokens=[{symbol:'T3',root:t3Root,decimals:9,masterCodeHash:manifest.contracts.T3Hub.codeHash,walletCodeHash:manifest.templates.T3Wallet},
      {symbol:'USDT',root:xMaster,decimals:xDecimals,masterCodeHash:manifest.contracts.USDT.codeHash,walletCodeHash:manifest.templates.JettonV21Wallet}];
    manifest.spotMarkets=[{symbol:'USDT',pool,binSpacing,feePips,xDecimals,walletGasX,walletGramX,walletBudgetX}]; manifest.perpsMarkets=[];manifest.options=[];
    const signed=signDexManifest(manifest), release=parseDexReleaseManifest(signed), original=snapshot.response.results[1], head=snapshot.response.head;
    const response={network:'testnet',release:{releaseId:release.releaseId,manifestHash:release.manifestHash},
      readContext:{source:'lite',queriedAt:head.utime*1000+1000,head:{...head,workchain:-1,shard:'-9223372036854775808',fileHashHex:'2'.repeat(64)}},
      results:[t3,x,{kind:'account',address:pool,account_state:original.state,balance_raw:original.balance,code_boc:original.codeBoc,data_boc:original.dataBoc},
        ...snapshot.response.results.slice(2).map((result:any)=>({kind:'getter',address:pool,exit_code:result.exitCode,stack:result.stack,gas_used:null}))]};
    yield { file, manifest:signed, release, response, now:head.utime*1000+1000, assetId:xMaster,
      provenance:{scope:capture.scope,originalPoolSnapshot:snapshot,rootAccounts:capture.currentAccounts.filter((row:any)=>[t3Root,xMaster].includes(row.address))} };
  }
}

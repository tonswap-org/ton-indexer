import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Cell } from '@ton/core';
import { runtimeManifestFixture } from '../fixtures/runtimeManifest';
import { hashReleaseManifest, type RuntimeReleaseManifest } from '../../config/runtimeManifest';
import { boundaryState } from '../../runtime/physicalEvidence';
/** Synthetic fixture release identity, with every consumed native code pin and
 * vendor asset digest derived from the original captured account cells. The
 * returned assets are fixture bytes, not deployed release provenance. */
export function currentFaucetFixtureManifest(c:any, proofCodeHash:string) {
  const base=runtimeManifestFixture(),tokens=c.tokens as RuntimeReleaseManifest['tokens'];
  const states=c.currentAccounts.map((a:any)=>boundaryState(a.address,a.shardAccountBoc,1).state);
  const code=(hash:string)=>{
    const matches=states.flatMap((s:any)=>s.codeBoc?[Cell.fromBase64(s.codeBoc)]:[]).filter((v:Cell)=>v.hash().toString('hex')===hash);
    assert(matches.length>0,`Missing captured native code ${hash}`);return matches[0] as Cell;
  };
  const asset=(cell:Cell)=>{
    const bytes=cell.toBoc(),sha256=createHash('sha256').update(bytes).digest('hex');
    return {metadata:{path:`release-assets/${sha256}.boc`,sha256,bytes:bytes.length,codeHash:cell.hash().toString('hex')},boc:bytes.toString('base64')};
  };
  const faucetState=boundaryState(c.faucet,c.currentAccounts.find((a:any)=>a.address===c.faucet).shardAccountBoc,1).state;
  const t3=tokens.find(t=>t.symbol==='T3')!,ts=tokens.find(t=>t.symbol==='TS')!,stable=tokens.find(t=>t.symbol==='USDT')!;
  assert(t3&&ts&&stable);const minter=asset(code(stable.masterCodeHash)),wallet=asset(code(stable.walletCodeHash));
  const contracts={...base.contracts,TestnetFaucet:{address:c.faucet,codeHash:Cell.fromBase64(faucetState.codeBoc!).hash().toString('hex')}};
  for(const t of tokens){const role=t.symbol==='T3'?'T3Hub':t.symbol==='TS'?'TSMinter':t.symbol;contracts[role as keyof typeof contracts]={address:t.root,codeHash:t.masterCodeHash};code(t.masterCodeHash);code(t.walletCodeHash);}
  const manifest:RuntimeReleaseManifest={...base,network:'ton:localnet',globalId:-3,releaseId:'synthetic-native-faucet-collector',supplyBase:c.state.supplyBase,tokens,
    contracts,templates:{...base.templates,T3Wallet:t3.walletCodeHash,JettonV21Wallet:ts.walletCodeHash,T3RecoveryProof:proofCodeHash},
    vendor:{stablecoin:{...base.vendor.stablecoin,minter:minter.metadata,wallet:wallet.metadata}}};
  for(const t of tokens){const role=t.symbol==='T3'?'T3Hub':t.symbol==='TS'?'TSMinter':t.symbol;assert.deepEqual(manifest.contracts[role as keyof typeof contracts],{address:t.root,codeHash:t.masterCodeHash});}
  assert.equal(manifest.vendor.stablecoin.minter.codeHash,stable.masterCodeHash);assert.equal(manifest.vendor.stablecoin.wallet.codeHash,stable.walletCodeHash);
  assert.equal(manifest.templates.T3Wallet,t3.walletCodeHash);assert.equal(manifest.templates.JettonV21Wallet,ts.walletCodeHash);
  manifest.manifestHash=hashReleaseManifest(manifest);
  return {manifest,fixtureAssets:[{...minter.metadata,boc:minter.boc},{...wallet.metadata,boc:wallet.boc}]};
}

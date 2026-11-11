import { Address,Cell,contractAddress } from '@ton/core';
import { orderInitialData,parseOrderTerms } from '../orders/state';
import type { CurrentDlmmConfigBinding } from './currentDlmmPhysical';
/** A bounded read candidate only. Original factory/child execution must qualify
 * it through readCurrentDlmmOrderCreations before any wallet or cash authority. */
export function currentDlmmOrderCandidate(body:Cell,owner:string,binding:CurrentDlmmConfigBinding,code:Cell){
 const factory=binding.release.contracts.SpotOrderFactory;if(!factory||code.isExotic||code.hash().toString('hex')!==binding.release.templates.SpotOrder)throw Error('Current order template pin');
 const s=body.beginParse();if(s.loadUint(32)!==0x4f435254)throw Error('Current order creation opcode');s.loadUintBig(64);const nonce=s.loadUintBig(64),terms=parseOrderTerms(s.loadRef());s.endParse();
 const pool=binding.pools.find(p=>p.pool===terms.pool.toRawString()),token=pool?.[terms.sellIndex===0?'t3':'x'];if(!pool||!token||terms.inputMaster.toRawString()!==token.root||terms.recipient.toRawString()!==owner)throw Error('Current order installed terms');
 return{order:contractAddress(0,{code,data:orderInitialData(Address.parse(factory.address),Address.parse(owner),nonce)}).toRawString(),pool:pool.pool,root:token.root};
}

import type { NativePerpsPosition, NativePerpsState, NativePerpsTrade } from './currentPerpsState';
export const perpsAbs=(n:bigint)=>n<0n?-n:n;
const min=(a:bigint,b:bigint)=>a<b?a:b,max=(a:bigint,b:bigint)=>a>b?a:b;
const BPS=10000n,SCALE=1000000000n,LIMIT=1n<<120n;
export const perpsFloor=(n:bigint,d:bigint)=>{if(d<=0n)throw Error('Perps divisor');const q=n/d;return n<0n&&n%d!==0n?q-1n:q;};
const ceil=(n:bigint,d:bigint)=>-perpsFloor(-n,d);
export const emptyPerpsPosition=():NativePerpsPosition=>({gen:0n,size:0n,margin:0n,entryNotional:0n,lastFundingIndex:0n,counterparty:{reserved:0n,pendingFunding:0n,collectedLoss:0n,remainingEntitlement:0n}});
export type CurrentPerpsMarket=NativePerpsState['book']['markets'] extends Map<number,infer T>?T:never;
/** Recompute Coins changes with TVM signed flooring. Cash delivery is proved
 * separately; neither a reserve release nor a positive funding claim is cash. */
export function currentPerpsFunding(p:NativePerpsPosition,index:bigint){
 const cp={...p.counterparty},position={...p,lastFundingIndex:index,counterparty:cp};
 const amount=p.size===0n?0n:perpsFloor(p.entryNotional*(index-p.lastFundingIndex)*(p.size>0n?-1n:1n),BPS);
 let collected=0n,unpaid=0n,cancelled=0n;
 if(amount>0n)cp.pendingFunding=min(cp.pendingFunding+amount,min(cp.reserved,cp.remainingEntitlement));
 if(amount<0n){cancelled=min(cp.pendingFunding,-amount);cp.pendingFunding-=cancelled;cp.remainingEntitlement-=cancelled;const debt=-amount-cancelled;collected=min(debt,p.margin);unpaid=min(debt-collected,LIMIT-1n);position.margin-=collected;cp.collectedLoss+=collected;}
 return{position,amount,collected,unpaid,cancelled};
}
export function currentPerpsFill(m:CurrentPerpsMarket,size:bigint,price:bigint){
 const p=m.params,ratio=min(perpsAbs(size)*SCALE/p.depthUnit,351n*SCALE),impact=min(350n,p.impactAlpha*ratio/SCALE+p.impactBeta*(ratio*ratio/SCALE)/SCALE);
 return price+perpsFloor((size>0n?price:-price)*impact,BPS);
}
function pnl(p:NativePerpsPosition,price:bigint){const n=perpsAbs(p.size)*price-p.entryNotional*SCALE;return max(-(1n<<127n),min((1n<<127n)-1n,perpsFloor(p.size>0n?n:-n,SCALE)));}
const liquidatable=(p:NativePerpsPosition,fullPnl:bigint,floor:bigint)=>{const c=p.counterparty,l=max(fullPnl,0n)+c.pendingFunding;return c.reserved<=l+floor||min(c.reserved,c.remainingEntitlement)<=l;};
export function currentPerpsPlan(old:NativePerpsPosition,trade:NativePerpsTrade,deposit:bigint,market:CurrentPerpsMarket,feeBps:number,oraclePrice:bigint,fill:bigint){
 const funded=currentPerpsFunding(old,market.funding.index),next=funded.position;let fee=0n,payout=0n,lpPayout=0n,loss=0n,unpaidLoss=0n,notionalDelta=0n;
 if(trade.kind==='addMargin'){const position={...old,counterparty:{...old.counterparty},margin:old.margin+deposit};return{position,fee,payout,lpPayout,loss,unpaidLoss,notionalDelta,funding:{amount:0n,collected:0n,unpaid:0n,cancelled:0n}};}
 if(trade.kind==='open'||trade.kind==='increase'){
  const added=perpsAbs(trade.size!)*fill/SCALE;fee=added*BigInt(feeBps)/BPS;next.gen=old.size===0n?(trade.gen??0n):old.gen;next.size=old.size+trade.size!;next.entryNotional=old.entryNotional+added;next.margin+=deposit-fee;next.counterparty.reserved=max(next.counterparty.reserved,next.entryNotional*2n);next.counterparty.remainingEntitlement+=added;notionalDelta=added;
 }else if(trade.kind==='removeMargin'){next.margin-=trade.amount!;payout=trade.amount!;}
 else if(trade.kind==='funding'){lpPayout=next.counterparty.pendingFunding;next.counterparty.reserved-=lpPayout;next.counterparty.remainingEntitlement-=lpPayout;next.counterparty.pendingFunding=0n;loss=next.counterparty.collectedLoss;next.counterparty.collectedLoss=0n;}
 else{
  const total=perpsAbs(old.size);let size=trade.size===0n?total:perpsAbs(trade.size!);if(old.entryNotional-old.entryNotional*size/total<750000000n)size=total;
  const cp=next.counterparty,fullPnl=pnl(next,fill),floor=ceil(old.entryNotional*1500n,BPS);let forced=funded.unpaid>0n||liquidatable(next,fullPnl,floor),closed=forced?total:size;
  const fundingClaim=min(cp.pendingFunding,min(cp.reserved,cp.remainingEntitlement));let reserve=0n,entitlement=0n,closedEntitlement=cp.remainingEntitlement-fundingClaim;
  if(!forced&&closed<total){reserve=ceil((cp.reserved-fundingClaim)*(total-closed),total);if(reserve<=ceil(floor*(total-closed),total)){forced=true;closed=total;reserve=0n;}else{closedEntitlement=(cp.remainingEntitlement-fundingClaim)*closed/total;entitlement=cp.remainingEntitlement-fundingClaim-closedEntitlement;}}
  if(closed!==size)throw Error('Current Perps partial close was not accepted');
  const realized=perpsFloor(fullPnl*closed,total),claim=min(cp.reserved-reserve,min(fundingClaim+max(realized,0n),fundingClaim+closedEntitlement)),totalLoss=max(-realized,0n)+funded.unpaid;
  lpPayout=max(claim-totalLoss,0n);const gross=max(totalLoss-claim,0n),debit=min(gross,next.margin);unpaidLoss=min(gross-debit,LIMIT-1n);
  const share=next.margin*size/total;let retained=next.margin-share-max(debit-share,0n);payout=max(share-debit,0n);
  const quoted=(size*fill/SCALE)*BigInt(feeBps)/BPS;fee=size===total?min(quoted,payout):quoted;const retainedFee=min(retained,fee);retained-=retainedFee;payout-=fee-retainedFee;
  notionalDelta=-(old.entryNotional*size/total);next.size=old.size>0n?total-size:size-total;next.entryNotional+=notionalDelta;next.margin=retained;
  loss=cp.collectedLoss+debit;next.counterparty={reserved:reserve,pendingFunding:0n,collectedLoss:0n,remainingEntitlement:entitlement};
 }
 if(next.margin<0n||payout<0n)throw Error('Current Perps negative plan');
 if(['open','increase','close'].includes(trade.kind)){const direction=trade.kind==='close'?(old.size>0n?-perpsAbs(old.size-next.size):perpsAbs(old.size-next.size)):trade.size!;if(currentPerpsFill(market,direction,oraclePrice)!==fill)throw Error('Current Perps original oracle fill mismatch');}
 else if(fill!==oraclePrice)throw Error('Current Perps original oracle price mismatch');
 return{position:next,fee,payout,lpPayout,loss,unpaidLoss,notionalDelta,funding:funded};
}

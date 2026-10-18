/** Offline-only research transform. No runtime imports. */
import type { ExperimentalTicket } from '../apps/api/src/services/experimentalSizing.js'
export function recoveredMarketDesign(tickets:ExperimentalTicket[]) {
 if(tickets.length!==120||new Set(tickets.map(t=>t.selection)).size!==120||tickets.some(t=>!/^([1-6])-([1-6])-([1-6])$/.test(t.selection)||new Set(t.selection.split('-')).size!==3||!Number.isFinite(t.odds)||t.odds<=1||!Number.isFinite(t.probability)||t.probability<0||t.probability>1)||Math.abs(tickets.reduce((s,t)=>s+t.probability,0)-1)>1e-6)throw new Error('Invalid distribution')
 const total=tickets.reduce((s,t)=>s+1/t.odds,0),market=tickets.map(t=>1/t.odds/total),lanes=tickets.map(t=>t.selection.split('-').map(x=>Number(x)-1)),marginals=Array.from({length:3},()=>Array(6).fill(0))
 lanes.forEach((a,i)=>a.forEach((l,p)=>marginals[p][l]+=market[i]))
 const clip=(n:number)=>Math.max(-5,Math.min(5,n))/5
 const features=tickets.map((t,i)=>{const x=Array<number>(127).fill(0),a=lanes[i];a.forEach((l,p)=>x[p*6+l]=1);[[0,1],[0,2],[1,2]].forEach(([p,q],j)=>{const l=a[p],r=a[q];x[18+j*30+l*5+r-(r>l?1:0)]=1});x[108]=clip(Math.log(Math.max(t.probability,1e-12)/market[i]));a.forEach((l,p)=>x[109+p*6+l]=clip(Math.log(marginals[p][l])));return x})
 return {market,features}
}
export function recoveredMarketTransform(tickets:ExperimentalTicket[],weights:number[]) {
 if(weights.length!==127||weights.some(w=>!Number.isFinite(w)))throw new Error('Invalid weights')
 const {market,features}=recoveredMarketDesign(tickets),logs=market.map((p,i)=>Math.log(p)+features[i].reduce((s,x,j)=>s+x*weights[j],0)),max=Math.max(...logs),mass=logs.map(x=>Math.exp(x-max)),sum=mass.reduce((s,p)=>s+p,0)
 return tickets.map((t,i)=>({...t,probability:mass[i]/sum}))
}

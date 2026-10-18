import {describe,it,expect} from 'vitest'
import {recoveredMarketDesign,recoveredMarketTransform} from './recovered-market-model.js'
const tickets=Array.from({length:6},(_,a)=>Array.from({length:6},(_,b)=>Array.from({length:6},(_,c)=>a!==b&&a!==c&&b!==c?{selection:`${a+1}-${b+1}-${c+1}`,probability:1/120,odds:10+a*13+b*2+c,probStd:.01}:null))).flat(2).filter(x=>x!==null)
describe('recovered research distribution',()=>{
 it('zero residual exactly preserves normalized inverse odds and original risk proxy',()=>{const ts=recoveredMarketTransform(tickets,Array(127).fill(0)),total=tickets.reduce((s,t)=>s+1/t.odds,0);expect(ts.reduce((s,t)=>s+t.probability,0)).toBeCloseTo(1,12);ts.forEach((t,i)=>{expect(t.probability).toBeCloseTo(1/tickets[i].odds/total,14);expect(t.probStd).toBe(.01);expect(t.odds).toBe(tickets[i].odds)})})
 it('has one indicator per position and ordered pair, and finite normalized learned probabilities',()=>{const {features}=recoveredMarketDesign(tickets);features.forEach(x=>{expect(x).toHaveLength(127);expect(x.slice(0,18).reduce((s,v)=>s+v,0)).toBe(3);expect(x.slice(18,108).reduce((s,v)=>s+v,0)).toBe(3)});const p=recoveredMarketTransform(tickets,Array.from({length:127},(_,i)=>Math.sin(i)));expect(p.every(t=>t.probability>0)).toBe(true);expect(p.reduce((s,t)=>s+t.probability,0)).toBeCloseTo(1,12)})
 it('rejects malformed data and weights',()=>{expect(()=>recoveredMarketTransform(tickets,[])).toThrow();expect(()=>recoveredMarketDesign(tickets.slice(1))).toThrow()})
})

/** Pure offline metrics. Does not fit, select configurations, or read files. */
export function scoreDistributions(rows) {
 if(!rows.length)throw Error('No labelled rows')
 const losses=rows.map(({probabilities,winner})=>{
  if(probabilities.length!==120||probabilities.some(p=>!Number.isFinite(p)||p<0||p>1)||Math.abs(probabilities.reduce((a,b)=>a+b,0)-1)>1e-6||!Number.isInteger(winner)||winner<0||winner>=120)throw Error('Invalid distribution/label')
  return {nll:-Math.log(Math.max(Number.MIN_VALUE,probabilities[winner])),brier:probabilities.reduce((s,p,i)=>s+(p-Number(i===winner))**2,0)}
 })
 return {races:rows.length,meanNll:losses.reduce((s,x)=>s+x.nll,0)/rows.length,multiclassBrier:losses.reduce((s,x)=>s+x.brier,0)/rows.length,losses}
}
export function pairedBootstrap(left,right,iterations=3000,seed=20261019) {
 if(left.length!==right.length||!left.length)throw Error('Paired rows required')
 let state=seed>>>0;const random=()=>{state=(Math.imul(1664525,state)+1013904223)>>>0;return state/4294967296}
 const diff=left.map((x,i)=>x-right[i]),samples=[]
 for(let k=0;k<iterations;k++){let s=0;for(let j=0;j<diff.length;j++)s+=diff[Math.floor(random()*diff.length)];samples.push(s/diff.length)}
 samples.sort((a,b)=>a-b)
 return {meanDifference:diff.reduce((a,b)=>a+b,0)/diff.length,percentile95:[samples[Math.floor(iterations*.025)],samples[Math.floor(iterations*.975)]],iterations,seed,unit:'race',interpretation:'left minus right; negative better; repeated retrospective sample, not prospective proof'}
}
export function reliability(rows,predicate=()=>true) {
 const bins=[[0,.01],[.01,.05],[.05,.1],[.1,.2],[.2,.5],[.5,1.000001]]
 return bins.map(([lo,hi])=>{let count=0,sum=0,wins=0;for(const r of rows)r.tickets.forEach((t,i)=>{if(t.probability>=lo&&t.probability<hi&&predicate(t,r)){count++;sum+=t.probability;wins+=Number(i===r.winner)}});return {lower:lo,upper:Math.min(hi,1),count,meanProbability:count?sum/count:null,observedWinFrequency:count?wins/count:null}})
}

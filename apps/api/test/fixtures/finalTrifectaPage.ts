/** Synthetic complete market with a uniform payout-consistent quote. */
export function finalTrifectaPage(raceDate:string,venueCode:string,raceNo:number,final=true){
 const lanes=[1,2,3,4,5,6],rows:string[]=[];
 for(let group=0;group<5;group++)for(let row=0;row<4;row++)rows.push('<tr>'+lanes.map(first=>{
  const second=lanes.filter(n=>n!==first)[group],third=lanes.filter(n=>n!==first&&n!==second)[row];
  return `${row===0?`<td rowspan="4">${second}</td>`:''}<td>${third}</td><td>37.7</td>`;
 }).join('')+'</tr>');
 const query=`rno=${raceNo}&amp;jcd=${venueCode}&amp;hd=${raceDate.replaceAll('-','')}`;
 return `<div class="tab3"><a href="/owpc/pc/race/racelist?${query}">出走表</a><a href="/owpc/pc/race/raceresult?${query}">結果</a></div><p>${final?'締切時オッズ':'オッズ更新時間 13:00'}</p><span>3連単オッズ</span><table><thead><tr>${lanes.map(n=>`<th>${n}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

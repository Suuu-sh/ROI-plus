import { describe, expect, it } from 'vitest';
import { parseRaceListEntries, raceListUrl } from '../src/services/boatraceRaceList.js';

const identity={raceDate:'2026-10-11',venueCode:'01',raceNo:1};
function page(){
  const rows=Array.from({length:6},(_,index)=>`<tr><td>${index+1}</td><td><span class="is-fs12">${4001+index}</span>Racer ${index+1}</td></tr>`).join('');
  return `<div class="tab3"><a href="/owpc/pc/race/racelist?rno=1&amp;jcd=01&amp;hd=20261011">出走表</a><a href="/owpc/pc/race/raceresult?rno=1&amp;jcd=01&amp;hd=20261011">結果</a></div><table><thead><tr><th>枠</th><th>ボートレーサー</th></tr></thead><tbody>${rows}</tbody></table>`;
}

describe('official race-list source parser',()=>{
  it('builds a race-specific official URL and parses all six lane identities',()=>{
    expect(raceListUrl(1,'01','2026-10-11')).toBe('https://www.boatrace.jp/owpc/pc/race/racelist?hd=20261011&jcd=01&rno=1');
    expect(parseRaceListEntries(page(),identity)).toEqual(Array.from({length:6},(_,index)=>({lane:index+1,registrationNumber:String(4001+index)})));
  });
  it('fails closed for a mismatched identity, incomplete lanes, or duplicate registrations',()=>{
    expect(()=>parseRaceListEntries(page().replace('rno=1&amp;jcd=01&amp;hd=20261011','rno=2&amp;jcd=01&amp;hd=20261011'),identity)).toThrow();
    expect(()=>parseRaceListEntries(page().replace('<tr><td>6</td><td><span class="is-fs12">4006</span>Racer 6</td></tr>',''),identity)).toThrow();
    expect(()=>parseRaceListEntries(page().replace('>4006</span>','>4005</span>'),identity)).toThrow();
  });
});

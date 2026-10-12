import { describe, expect, it } from 'vitest';
import { parseRaceListEntries, raceListUrl } from '../src/services/boatraceRaceList.js';

const identity={raceDate:'2026-10-11',venueCode:'01',raceNo:1};
function page(){
  const rows=Array.from({length:6},(_,index)=>`<tbody><tr><td rowspan="4">${index+1}</td><td rowspan="4"><a href="/owpc/pc/data/racersearch/profile?toban=${4001+index}">Racer ${index+1}</a></td></tr><tr><td>detail A</td></tr><tr><td>detail B</td></tr><tr><td>detail C</td></tr></tbody>`).join('');
  return `<div class="tab3"><a href="/owpc/pc/race/racelist?rno=1&amp;jcd=01&amp;hd=20261011">出走表</a><a href="/owpc/pc/race/raceresult?rno=1&amp;jcd=01&amp;hd=20261011">結果</a></div><table><thead><tr><th>枠</th><th>ボートレーサー</th><th>登録情報</th></tr></thead>${rows}</table>`;
}

describe('official race-list source parser',()=>{
  it('builds a race-specific official URL and parses all six lane identities',()=>{
    expect(raceListUrl(1,'01','2026-10-11')).toBe('https://www.boatrace.jp/owpc/pc/race/racelist?hd=20261011&jcd=01&rno=1');
    expect(parseRaceListEntries(page(),identity)).toEqual(Array.from({length:6},(_,index)=>({lane:index+1,registrationNumber:String(4001+index)})));
  });
  it('fails closed for a mismatched identity, incomplete lanes, or duplicate registrations',()=>{
    expect(()=>parseRaceListEntries(page().replace('rno=1&amp;jcd=01&amp;hd=20261011','rno=2&amp;jcd=01&amp;hd=20261011'),identity)).toThrow();
    expect(()=>parseRaceListEntries(page().replace(/<tbody><tr><td rowspan="4">6[\s\S]*?<\/tbody>/,''),identity)).toThrow();
    expect(()=>parseRaceListEntries(page().replace('toban=4006','toban=4005'),identity)).toThrow();
  });
});

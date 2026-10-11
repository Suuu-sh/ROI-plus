type ResultPageArgs = {
  raceDate: string;
  venueCode: string;
  raceNo: number;
  finishOrder?: number[];
  racerIds?: string[];
};

/** Synthetic, official-shaped markup only; never contains captured page data. */
export function boatraceResultPage({
  raceDate, venueCode, raceNo, finishOrder = [1, 2, 5, 3, 4, 6], racerIds = ['4001', '4002', '4003', '4004', '4005', '4006'],
}: ResultPageArgs): string {
  const date = raceDate.replaceAll('-', '');
  const month = Number(date.slice(4, 6));
  const day = Number(date.slice(6, 8));
  const schedule = Array.from({ length: 12 }, (_, index) => {
    const number = index + 1;
    const cls = number === raceNo ? '' : ' class="is-thColor2"';
    return `<th${cls}><a href="/owpc/pc/race/raceresult?rno=${number}&amp;jcd=${venueCode}&amp;hd=${date}">${number}R</a></th>`;
  }).join('');
  const rows = finishOrder.map((number, index) => `<tbody><tr>
    <td class="is-fs14">${['１', '２', '３', '４', '５', '６'][index]}</td>
    <td class="is-fs14 is-fBold is-boatColor${number}">${number}</td>
    <td class="is-p10-0"><span class="is-fs12">${racerIds[number - 1] ?? ''}</span><span> Synthetic ${number}</span></td>
    <td>1'50"0</td>
  </tr></tbody>`).join('');
  return `<main>
    <div class="heading2"><img src="/static_extra/pc/images/text_place2_${venueCode}.png" alt="Synthetic Venue" /></div>
    <div class="tab2"><ul><li class="is-active2"><span class="tab2_inner">${month}月${day}日<span>開催日</span></span></li></ul></div>
    <div class="table1"><table><thead><tr><th colspan="2">レース</th>${schedule}</tr></thead></table></div>
    <div class="tab3 is-type1__3rdadd"><ul class="tab3_tabs">
      <li><a href="/owpc/pc/race/racelist?rno=${raceNo}&amp;jcd=${venueCode}&amp;hd=${date}">出走表</a></li>
      <li class="is-active"><span><span>結果</span></span></li>
    </ul></div>
    <div class="grid"><div class="table1"><table class="is-w495">
      <thead><tr><th>着</th><th>枠</th><th>ボートレーサー</th><th>レースタイム</th></tr></thead>${rows}
    </table></div></div>
    <div class="table1"><table><thead><tr><th>勝式</th><th>組番</th><th>払戻金</th><th>人気</th></tr></thead>
      <tbody><tr><td rowspan="2">3連単</td><td><div class="numberSet1"><span class="numberSet1_number">${finishOrder[0]}</span><span class="numberSet1_number">${finishOrder[1]}</span><span class="numberSet1_number">${finishOrder[2]}</span></div></td><td><span class="is-payout1">&yen;3,770</span></td><td>1</td></tr><tr><td>&nbsp;</td><td><span class="is-payout1">&nbsp;</span></td><td>&nbsp;</td></tr></tbody>
      <tbody><tr><td rowspan="2">単勝</td><td><div class="numberSet1"><span class="numberSet1_number">${finishOrder[0]}</span></div></td><td><span class="is-payout1">&yen;430</span></td><td>1</td></tr><tr><td>&nbsp;</td><td><span class="is-payout1">&nbsp;</span></td><td>&nbsp;</td></tr></tbody>
    </table></div>
    <div class="table1"><table><thead><tr><th>返還</th></tr></thead><tbody><tr><td><div class="numberSet1"><div class="numberSet1_row"></div><div class="numberSet1_row"></div></div></td></tr></tbody></table></div>
  </main>`;
}

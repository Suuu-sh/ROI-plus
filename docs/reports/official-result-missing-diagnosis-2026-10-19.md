# 2026-10-18 公式結果 proof 欠損の読み取り専用診断

調査日: 2026-10-19 JST。対象コード: `24103e8`。ランタイム変更・デプロイ・D1 更新・モデル昇格なし。公式 HTML 再取得は別の隔離検証であり、この診断では実施していない。

## 確認できた原因

`source-state-changed` 89 レースの主因は、実際の並行更新を示す記録ではなく、**対象選択と書き込み時の権限条件の不一致**。

1. `apps/api/src/index.ts:2094-2098` は R2 の完全アーカイブから得た `archiveRaceIds` を通常収集に渡す（`labelOnly` は未指定、既定 false）。
2. `apps/api/src/services/collectBoatraceResults.ts:92-95` はこの ID 集合を、購入のない結果ラベル対象として SELECT に追加する。
3. `:357-359` の `guardData` は `labelOnly:false` / `labelArchiveId:null` となり、アーカイブ対象の資格を渡さない。
4. 全 INSERT / UPDATE / success log の `currentSourceGuard` (`:413-432`) は、未精算通常購入・実験購入の存在・未精算 historical 購入・明示的 labelOnly のいずれかを要求する。R2 アーカイブ資格の分岐がない。
5. 購入なしアーカイブ対象では、ページ・選手登録・結果・既存データが正常でもこの guard は false。最後の success log の変更行数 0 が `:374-378` で例外になり、`:384-387` が failed / `source-state-changed` として保存する。

したがって、この経路では状態が一切変わらなくても再試行のたびに同じ失敗になる。エラー名だけから「並行更新が発生した」とは判定できない。

## 本番読み取りの裏付け

Cloudflare コネクターで、2026-10-18・実データ・`boatrace-results-worker-v1` のみを bounded SELECT。二つの query とも `rows_written=0`。

| 最新 failed reason | 件数 | guard の購入資格 |
|---|---:|---|
| source-state-changed | 89 | 通常 open=0、実験購入存在=0、historical open=0（全89件） |
| official-page-identity-or-outcome-rejected | 2 | 1件は実験購入あり、1件はなし |
| stored-evidence-conflict | 4 | 全4件購入資格なし |

89件すべてにページ SHA256 と prerace archive が存在。87件は D1 に数値着順6件がある。最新試行の範囲は `2026-10-18T04:41:12.866Z` ～ `2026-10-18T18:30:56.738Z`。

この表は当日の全 failed を対象とするため、125件の評価適格サブセットに限定した「stored-evidence-conflict 3件」と母数が異なる。125件中の不足98件（89+2+3+1+3）のうち89件の資格欠落は上記で確認したが、他の9件の回復可能性は公式ページ再検証側で別に扱う。

## 確定できないこと

- `collection_runs` は1レース1行を上書きし、失敗ログには読み取り時 `entries`、`guardData`、各 guard 条件の真偽が残らない。過去実行の正確な before / after 差分は復元できない。
- 現時点の資格欠落とコードの決定的な拒否は確認したが、89件すべての過去実行で他の guard 条件も正常だったとまでは主張しない。
- 数値着順6件が D1 にあることは、公式ページ検証 proof の代替にならない。欠損を結果の捏造・払戻だけ・通常の success への書き換えで補ってはならない。
- パーサー拒否2件の詳細例外や stored-evidence-conflict の正確なフィールド差分は、この静的 reason だけでは判別できない。

## 小さい安全な修正案（未実装）

アーカイブ対象の資格を、対象選択から書き込み guard まで明示的に引き継ぐ。単に guard を削除したり全件許可したりせず、既に検証した bounded complete archive の対象レース ID と締切の同一性を bind し、既存の選手登録・着順・払戻・quarantine の全チェックを維持する。通常 labelOnly と同様、アーカイブ専用ラベル収集は不要な終端 entry 更新を避ける設計が望ましい。

既存テスト `apps/api/test/boatraceResultsCollector.test.ts:223-242` はアーカイブ ID の「選択」しか確認しておらず、購入なし状態で `collectResults` が proof 保存まで成功する回帰テストがない。最小追加は、完全アーカイブ対象・購入なしの正常成功と、未指定 ID／資格変化／quarantine／registry 変更の拒否。本調査ではコードを変えていないため、テストの再実行は行っていない。

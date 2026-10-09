# EdgeLab 設計仕様（正本）

競馬（JRA）とボートレースの AI 予測・期待値分析・仮想運用プラットフォーム。実購入機能は持たない。

## 0. 原則
- 費用0円（Cloudflare 無料枠 + GitHub Actions 無料枠 + ローカル Python）。
- オッズ・予測値・結果を捏造しない。取得できない値は `NULL`（欠損）。サンプルデータは `data_origin='sample'` で必ず区別。
- 予測時点で利用できなかった情報を使わない（`available_at <= predicted_at` を常に守る）。
- 冪等：全テーブルは自然キーに UNIQUE 制約、書き込みは `INSERT ... ON CONFLICT DO UPDATE`。

## 1. 構成（モノレポ / npm workspaces）
```
apps/web        React + TS + Vite + Tailwind（UI。Claude 担当）
apps/api        Cloudflare Workers + Hono + D1（REST API・Cron）
packages/shared 型・期待値計算・判定ロジック（web/api 共通）
db/migrations   D1 SQL マイグレーション
db/seed         サンプルデータ SQL（data_origin='sample'）
ml/             Python：収集・正規化・特徴量・LightGBM 学習・校正・推論・D1 同期
data/fixtures   公式ダウンロードの実ファイル（テスト用）
```

### 推論方式（採用）
Workers 上で LightGBM を動かすのは不要かつ無料枠の CPU 制限に不利。**Python（ローカル / GitHub Actions）で収集→推論し、結果を Worker の `/api/ingest/*` に POST** して D1 に反映する。Worker 側 Cron は「結果照合・自動仮想購入・集計」だけを行う。

## 2. データソース判断
| 競技 | ソース | 採否 | 理由 |
|---|---|---|---|
| ボート | 公式 `www1.mbrace.or.jp/od2/{B,K}/YYYYMM/{b,k}YYMMDD.lzh` | 採用 | 公式無料DL。B=番組表（選手・勝率・モーター・ボート）、K=競走成績（展示・進入・ST・結果・払戻）。robots.txt Disallow なし。1日1ファイル、取得間隔 ≥3 秒 |
| ボート | 公式サイトの単勝オッズ | 低頻度で採用（フラグ有効時） | `ENABLE_BOATRACE_ODDS_SCRAPE=true` 時のみ取得。締切前25分以内のレースを10分ごとの実行で1回、1回最大30リクエスト、最低3秒間隔。大量アクセス等を避ける。オッズ欠損時は判定 `INSUFFICIENT DATA` |
| 競馬 | netkeiba（keiba-scraping が対象） | 不採用 | 利用規約でスクレイピング等の自動取得を禁止 |
| 競馬 | JRA-VAN | 不採用 | 有料 |
| 競馬 | JRA 公式サイト | 不採用 | 自動取得 API なし、規約上の許諾不明 |
| 競馬 | ユーザー提供 CSV（keiba-data-interface 互換列） | 採用 | 利用者が適法に入手したデータを取り込むインポータを提供 |

最終オッズの代替：K ファイルの単勝払戻（勝者のみ）＝確定単勝オッズ×100。勝者以外の最終オッズは欠損。

## 3. DB スキーマ（D1 / SQLite）
共通カラム：`data_origin TEXT NOT NULL CHECK(data_origin IN ('sample','real'))`。
- `venues(id TEXT PK, sport, name)`
- `races(id TEXT PK, sport TEXT CHECK IN('horse','boat'), venue_id, race_date TEXT(YYYY-MM-DD), race_no INT, name, distance INT, surface, track_condition, weather, wind_speed REAL, wave_height REAL, post_time TEXT(ISO), status TEXT CHECK IN('scheduled','closed','finished','cancelled'), data_origin, updated_at)`
  - id 形式：boat `boat-YYYYMMDD-<場コード2桁>-<R2桁>`、horse `horse-YYYYMMDD-<場>-<R2桁>`。サンプルは必ず `sample-` 接頭辞（実データと衝突させない）
- `entries(id PK, race_id, number INT(馬番/艇番), frame INT, name, jockey, trainer, weight_carried REAL, horse_weight INT, racer_class, national_win_rate REAL, local_win_rate REAL, motor_no, motor_2rate REAL, boat_no, boat_2rate REAL, exhibition_time REAL, start_exhibition REAL, features_json TEXT, available_at TEXT, data_origin, UNIQUE(race_id, number))`
- `odds_snapshots(id PK, race_id, bet_type TEXT('win' 等), selection TEXT('3' / '1-2' 等), odds REAL, captured_at TEXT, source, data_origin, UNIQUE(race_id, bet_type, selection, captured_at))`
- `results(race_id, finish_order INT, number INT, data_origin, PK(race_id, number))`
- `payouts(race_id, bet_type, selection, payout INT(100円あたり), popularity INT, data_origin, PK(race_id, bet_type, selection))`
- `models(id TEXT PK 例 'boat-win-lgbm-v1', sport, bet_type, version, algorithm, status TEXT CHECK IN('untrained','candidate','active','retired'), train_from, train_to, valid_from, valid_to, test_from, test_to, n_train INT, metrics_json TEXT, trained_at, notes)`
- `predictions(id PK, race_id, model_id, number, probability REAL, prob_std REAL(不確実性), predicted_at, data_origin, UNIQUE(race_id, model_id, number, predicted_at))`
- `bets(id TEXT PK uuid, race_id, sport, bet_type, selection, stake INT, mode TEXT CHECK IN('manual','auto'), predicted_prob REAL, odds_at_bet REAL, expected_roi REAL, edge_label, model_id, placed_at, status TEXT CHECK IN('open','won','lost','void'), payout INT, profit INT, final_odds REAL, settled_at, data_origin)`
- `collection_runs(id PK, source, sport, target_date, started_at, finished_at, status CHECK IN('success','partial','failed','skipped'), records INT, error TEXT, reason TEXT)`
- `daily_summaries(date, sport, bets INT, stake INT, payout INT, PK(date, sport))`（集計キャッシュ）
- `settings(key PK, value)`：`initial_bankroll=100000`, `unit_stake=100`, `auto_bet_enabled`, `auto_promote_enabled=false`, `min_expected_roi=0.05`, `max_prob_std=0.05`

保存期間：`odds_snapshots` は締切前最終と購入時点以外を 30 日で削除（Cron）。他は保持。

## 4. 期待値・判定（packages/shared）
- `expectedRoi(p, odds) = p * odds - 1`
- `breakEvenProb(odds) = 1 / odds`
- `normalizeProbs(ps)`：レース内合計を 1 に。
- 保守的 EV：`conservativeRoi = (p - 1.0*std) * odds - 1`
- 判定 `edgeLabel`：
  - p / odds / model が欠損、またはモデル `untrained` → `INSUFFICIENT_DATA`
  - std > maxProbStd（既定 0.05）→ `INSUFFICIENT_DATA`（不確実性過大で購入候補外）
  - conservativeRoi ≥ 0.20 → `HIGH_EDGE`
  - conservativeRoi ≥ 0.05 → `POSITIVE_EDGE`
  - expectedRoi ≥ -0.05 → `NEUTRAL`
  - それ以外 → `NEGATIVE_EDGE`
- 購入候補 = `HIGH_EDGE | POSITIVE_EDGE`。自動仮想購入はこれ かつ `auto_bet_enabled`。
- データ鮮度：最新オッズ `captured_at` からの経過分。

## 5. REST API（apps/api, base `/api`）
すべて JSON。`?origin=sample|real|all`（既定 all）で絞り込み可。
- `GET /health`
- `GET /races?sport=horse|boat&date=YYYY-MM-DD` → `RaceSummary[]`
- `GET /races/:id` → `RaceDetail`（entries に最新オッズ・最新予測・EV・判定を結合）
- `GET /rankings?sport=&date=` → `EdgeCandidate[]`（期待収益率降順）
- `POST /bets` body `{raceId, betType:'win', selection, stake}` → 予測/オッズ/EV をサーバ側でスナップショットして保存 → `Bet`
- `GET /bets?sport=&status=` → `Bet[]`
- `GET /performance/overview?sport=` → `Overview`（総資産・累計損益・回収率・購入回数・的中率・最大DD・資産推移）
- `GET /performance/breakdown` → 競技別・月別・EV帯別・モデル別・校正ビン（予測確率 10 分位 vs 実勝率）・オッズ変動分析
- `GET /models` / `POST /models/:id/promote` / `POST /models/:id/rollback`
- `GET /collection/status` → ソース別最終取得・成功率・件数・鮮度・エラー履歴、D1 テーブル行数（無料枠監視）
- `POST /ingest/{venues,races,entries,results,payouts,odds,predictions,models,collection-runs}` ヘッダ `Authorization: Bearer $INGEST_TOKEN`（Worker secret）。各 endpoint は upsert 冪等。results/payouts を受信したレースは `finished`。
- `POST /admin/settle`（ローカル開発用、同じ token）

Cron（`*/10 * * * *`）：フラグ `ENABLE_BOATRACE_ODDS_SCRAPE=true` の場合、締切まで 25 分以内の実データ・ボート scheduled レースから、直近 10 分に取得していない単勝オッズを最大 30 件取得（リクエスト間隔 3 秒以上、失敗時 1 回リトライ）し、D1 に保存する。取得を先に行ってから①結果が入ったレースの open bet を払戻で精算（`payout = stake/100 * 払戻`、`final_odds = 払戻/100` 的中時）②自動仮想購入 ③古い odds 削除を行う。

型は `packages/shared/src/types.ts` を正とする。

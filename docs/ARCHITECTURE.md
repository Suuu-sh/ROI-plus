# アーキテクチャと作業ガイド

この文書はリポジトリのコード・設定から確認できる構成を説明する。製品の目標と不変条件は [SPEC](SPEC.md)、実装の根拠は本文中に示したコード／設定を参照する。仕様と実装が異なる場合はどちらかを黙って正本扱いせず、差分を報告する。Cloudflare の管理画面、GitHub の Secret 設定、実行中環境の状態はこのリポジトリからは確定できない。

## 目標と現状の区別

| 項目 | 製品設計・目標 | リポジトリで確認できる実装 |
|---|---|---|
| 対象 | 競馬（JRA）とボートレース | 日次 Actions、公式データ収集、Worker Cron はボート中心。競馬はユーザー提供 CSV の取込・特徴量コードがあるが、JRA 自動収集はない。 |
| 予測 | 出典のあるデータを用いた AI 予測 | Python / LightGBM が学習・推論を行い、Worker はモデルを実行しない。アプリコードに LLM / GPT API 呼び出しは見当たらない。毎週の自動学習対象は boat。 |
| 購入 | 仮想運用のみ | `POST /api/bets` と Cron の自動購入は D1 の仮想 bet 記録のみ。投票・決済連携はない。Primary T-60 自動運用は実データの三連単 (`trifecta`) だけを評価する。 |
| オッズ | 取得許諾・頻度の制約を守る | Worker に公式単勝オッズ収集器がある。毎分トリガーは締切まで15分以内・JST当日の実データを対象にし、直近50秒の取得を除外、最大30レース・各対象1回リトライ・取得間隔3秒以上・1回最大49 fetch 試行。空対象ならDBへ書き込まない。旧 `settings.roi_d1_write_budget_utc` によるアプリ内推定予約は無効であり、workerはこの推定値を理由に書込を拒否しない。Cloudflare D1 provider quotaや実際の行書込量は別で、ここから残量を計測・保証しない。10分トリガーは精算・自動仮想購入・古いオッズ削除のみを行う。SPEC の単一Cron記述・25分以内・10分鮮度とは差分があり、SPEC は変更していない。`apps/api/wrangler.toml` のフラグ値は設定情報であり、デプロイ済み状態や許諾を意味しない。 |
| モデル管理 | 評価後に人が昇格・ロールバック | 学習結果は `candidate` として同期される。Worker API に手動昇格・ロールバック操作があり、学習 Action は昇格しない。 |

結果精算は公式結果ページの艇番・登録番号・着順・単勝払戻・返還欄を照合する。非完走艇は着順を捏造せず、明示された終端コードとして保持する。転覆券の損失精算だけは、同一公式結果ページに単一の「返還」表（空欄）があり、6艇の登録番号・他の艇の着順・勝者払戻が整合する場合に限る。成功収集ログにはページURL・SHA-256・終端艇・返還欄の判定を保存し、精算時に race/date/URL/hash/policy/艇番を再確認する。スタート後の転覆では返還がないという公式規則 ([返還](https://www.boatrace.jp/owsp/sp/extra/enjoy/guide/jiten/29/y_250.html)) をこの限定ケースに適用する。欠場や F/L、他の終端コード、返還欄が欠落・非空・複数の場合はこの根拠を使わず未精算に残す。失格後の舟券返還なしという公式説明は [失格](https://www.boatrace.jp/owsp/sp/extra/enjoy/guide/jiten/12/y_086.html) を参照。これは仮想購入の記録であり実投票・決済ではない。

## システム構成

競技ページの主表示は保存済み仮想購入をレースごとにまとめる購入レビューである。ボートと運用ボードの履歴表示は `GET /api/bets?sport=&origin=` と `GET /api/bets/experimental` を購入時刻の新しい順に統合し、実験券には通常成績対象外の印を付ける。実験台帳・残高・通常成績の集計は統合せず、sample表示では実験券を混在させない。賭け記録は購入時点で表示し、結果・払戻を照合する詳細だけを開いた時に `GET /api/races/:id` で取得する。購入時の確率・オッズ・期待収益率は bet の保存値を表示し、後日の予測や結果で置き換えない。着順・払戻が欠ける場合は欠損として示し、単一レースの結果から因果説明を生成しない。サンプル購入には出所バッジとサンプル結果の注記を表示する。日付フィルターは購入一覧とレース探索に共通し、「レースを調べる」内にランキング・出走表を残す。購入候補表示に結果を混入させない。

```text
ブラウザー
  └─ Cloudflare Worker `roi-plus` (apps/web)
       ├─ dist の SPA 静的配信
       └─ `/api/*` を Service Binding `API` で中継
            └─ Cloudflare Worker `roi-plus-api` (Hono)
                 └─ D1 binding `DB` (SQLite / db/migrations)

GitHub Actions / ローカル Python (ml/)
  ├─ 公式ボートレース B/K データ収集・正規化
  ├─ 特徴量化・LightGBM 学習または推論
  └─ Bearer 認証付き `/api/ingest/*` → API Worker → D1
```

- **Web**: React + TypeScript + Vite + Tailwind。Worker の `assets` 設定が `apps/web/dist` を配信し、SPA fallback を行う。`apps/web/worker.ts` が `/api/*` を API Service Binding に渡し、`PROXY_TOKEN` をヘッダーに付加する。Cloudflare Access の実際のポリシーは外部設定。
- **API**: Hono の base path は `/api`。Web/API の永続 DB は D1（ML pipeline は別途ローカル JSON store を使う）で、スキーマ変更は `db/migrations/`。Worker の Service Binding 経由の閲覧 API は `PROXY_TOKEN` を検証し、ingest と `/admin/settle` は `INGEST_TOKEN` を Bearer 認証する。`/health` はヘルス確認用。
- **D1 / 共有ロジック**: スキーマ・初期設定は `db/migrations/`、サンプル投入は `db/seed/`。型と EV 判定は `packages/shared/`。行の自然キーに UNIQUE 制約があり、ingest は upsert を行う。

### D1 書込予約状態

- アプリ内の日次 D1 推定予約による書込拒否は無効化済み。`reserveWriteBudget(s)` は旧 `roi_d1_write_budget_utc` 台帳を読み書きせず、アプリ操作を予約上限で停止しない。`GET /api/ingest/write-budget` と health / collection status は `enabled:false`, `state:"disabled"`、予約・残量 `null` として表示し、古い台帳値を現状の利用量として扱わない。seed / allowance の管理 POST は認証を維持し `410 d1_write_budget_disabled` を返す。
- これは Cloudflare D1 のプロバイダー quota / 課金 / 利用量を変更、計測、または保証するものではない。Cloudflare側quotaが尽きた場合はプロバイダーのエラーが引き続き発生する。Deploy workflow の D1 migration readiness gate はこのアプリ内予約とは別であり、維持する。
- 重複・暴走を抑える既存制御は維持する。ingest の自然キー/no-op判定・履歴ガード・入力行数上限、Cronの対象/fetch試行数と間隔、競合ロック・lease、D1 batch/原子的条件、bet idempotency・残高判定を予約台帳の代わりに無効化しない。オッズ等の限定収集とログ cleanup の上限も継続する。

### API の主な面

閲覧系の `/api/races`・`/api/races/:id`・`/api/rankings`・`/api/models`・`/api/collection/status`・`/api/performance/overview` は、`PROXY_TOKEN` が設定された環境で認証を通過した GET のみ Cloudflare Cache API に最大10秒保存し、`/api/bets` は最大5秒保存する。URL全体（クエリを含む）でキーを分離し、200 JSON以外は保存しない。`X-ROI-Cache-Bypass: 1` を付けた閲覧リクエストはキャッシュ参照/書込みを迂回し、実行拠点の該当キーをベストエフォートで削除する。外向けは常に `Cache-Control: private, no-store`、`X-ROI-Read-Cache` で `HIT` / `MISS` / `BYPASS` を示す。画面から購入または精算の成功を確認した後は、購入一覧・損益の読み取りを最大10秒間バイパスする。キャッシュ障害時はD1読み取りへフォールバックする。`/api/performance/*` の他経路・`/api/health`・ingest/admin と全書込系は対象外で、仮想購入の判断・記録は常にD1の最新状態を使う。Cloudflare Cache API は拠点ごとのキャッシュであり、全地域でのヒットやD1読み取り削減量は保証しない。

`GET /api/races`, `/api/races/:id`, `/api/rankings`, `/api/bets`, `/api/performance/*`, `/api/models`, `/api/collection/status` が読み取り面。`GET /api/ingest/models` は `INGEST_TOKEN` 認証付きのモデルレジストリ読み取りで、Pythonが人手昇格後の状態を確認する。`POST /api/bets` は仮想 bet を受け付け、単勝の複数選択は `{raceId, betType:'win', requestId?, selections:[{selection, stake}, ...]}`（1回1〜6件）、三連単は検証済みの保存済み ticket 候補を受け付ける。ticket group 全体を残高ガード付きで記録する。`requestId` を指定すると同じ payload の再送は冪等、同じ ID の別 payload は409。旧 `{selection, stake}` 形式も互換用に受け付ける。`GET /api/performance/rank-comparison` は購入時に保存した rank 1 を使い、全券確定・rank 1 を含む複数選択 group を同じレース集合・同じ総賭け金で比較する。順位の根拠は `candidate_rank/count`, `predicted_at_at_bet`, `odds_captured_at`, `bet_group_id` に保存し、後から再推定しない。旧 bet は順位不明として同比較から除外する。`POST /api/models/:id/promote|rollback` はモデル管理、`POST /api/ingest/{venues,races,entries,results,payouts,odds,predictions,ticket-predictions,prerace-observations,models,collection-runs}` は Python 等からの冪等同期。`POST /api/admin/settle` は認証付き精算操作。多くの読み取り API は `origin=sample|real|all` で出所を絞れる。実際の入出力契約は `apps/api/src/index.ts` と `packages/shared/src/types.ts` が根拠。

### 仮想購入履歴の結果待ち

`GET /api/bets` は購入時の情報を変更せず、未精算購入に限り `resultWaitReason` を返す。理由はレース状態・発走時刻、同じ出所の出走数と結果数（重複・出走外の結果も確認）、1着結果とその払戻、および精算状態から導く。区分は発走前、公式結果未取得、払戻未取得、結果収集失敗/一部失敗の記録あり、精算待ち、状況不明、中止、失格、欠場。失敗記録は当該レースの欠損原因を証明しない。結果収集の試行・成功時刻は、実データのボートで対象日と `mbrace-boat` ソースが一致する場合だけ返す（試行は開始、成功は完了時刻。未来時刻の記録は除外）。他の競技・サンプルには公式結果の収集状況を推定しない。サンプル購入は「サンプル（公式結果ではありません）」と明示し、公式結果待ちと混同しない。

Experimental T-60 三連単の置かれた券は別テーブル `experimental_paper_bets` に保存され、通常の `/api/bets`・損益集計・残高には含めない。各券の仮想購入額は100円以上かつ100円単位で、Kelly予算が100円に届かない判断は購入せず見送る。旧実装が作成した条件外の未精算券は `experimental_paper_bet_reconciliations` に原記録を残したまま無効化・返金し、精算と実験成績から除外する。券単位の参照は `GET /api/bets/experimental` を使う。この API は固定 experiment の placed ticket のみ（実データのボートに限定、最大500件、新しい順）を明示的な `recordKind: 'experimental_paper'` として返し、棄権判断は返さない。無効化した旧券は監査用に `status: 'void'` と返す。`dataOrigin: 'real'` は実データ由来を示すだけで実購入ではなく、通常履歴とも分離した仮想実験の記録である。応答は `private, no-store` で、通常履歴の短期 read cache を通らない。

`GET /api/performance/experimental` は保存済み実験券の結果から、柔軟購入額と「同じ券を各100円」とした固定額の事後比較を返す。新しい台帳・購入判断・bankroll更新は行わない。比較はレース単位で全券が won/lost に確定した場合だけ同じ券集合を使い、openは保留、void・reconciliation・100円単位で払戻復元できない券は除外する。さらに実験の現行レース上限（10券・合計1,000円）を超える記録は比較から除く。固定額払戻は精算済みの実験払戻を実購入額の100円単位数で割って復元するため、同額予算比較や独立戦略の成績を意味しない。

## AI・データフロー

1. `ml/edgelab/collectors/` が公式ボートレース B/K ファイルと、日次 Action 内の上限付き beforeinfo 取得を行い、`parsers/` が正規化する。日次処理はローカル JSON store を再利用し、再実行できる自然キーでデータをまとめる。
2. `features/` は許可した数値特徴量だけを作る。`available_at <= predicted_at` と同日・未来情報の除外を検査する。結果／払戻などを特徴量に混入させないため、特徴量列は allowlist で制限される。
3. `ml/edgelab/models/train.py` は時系列で train / validation / test を分割して LightGBM を学習し、検証データで温度校正する。レース単位 bootstrap の出力ばらつきが `prob_std`。十分なデータがない場合は暗黙に代替モデルを使わず `untrained` とする。成果物は `ml/artifacts/`。
4. `ml/edgelab/predict.py` は確率と不確実性を出し、`ml/edgelab/sync.py` が 500 行以下のチャンクで ingest API へ送る。Worker は予測を再計算せず、`packages/shared/src/ev.ts` の規則に沿う評価・候補表示と仮想運用を行う。
5. 日次 Action の `python -m edgelab daily` は前日・当日の B/K 収集、当日の予測、両日の取得済み結果・払戻の同期を行い、その後に履歴 backfill と実データのフィードバック採点を行う。予測は認証付きレジストリで確認した active モデルだけを使い、candidateを稼働モデルの代わりにはしない。対応する artifact がない・後日情報の特徴列を持つ場合は推論を停止し、結果同期とフィードバックは継続する。
6. 週次 Action の `python -m edgelab learn` は新規完了レースの増分を確認し、別IDの候補モデルを再学習する。同じ時間順holdout上で比較できる安全な稼働モデルとの比較を記録し、`promotionEligible=false` の候補は画面・APIとも通常昇格を拒否する。holdoutは週次評価で再利用されるため、独立した最終的な利益の証明とはしない。候補モデルの本番昇格・ロールバックは人が画面/APIから行う。

初回ベースラインの検証は `python -m edgelab validate-baseline` が既存candidateの保存済みartifactと実データを再学習・再収集なしで評価する別経路。適格条件は時間分離・完全コホート・lane基準とのpaired race/date-cluster区間などで、認証済みモデルregistry snapshotとartifact identityにも結び付ける。適格でも通常の改善昇格とは別の明示的な人手承認が必要で、承認後も初期の仮想運用モデルに過ぎず、クリーンな稼働モデルとの改善、point-in-time情報到着、または正の期待値・利益の証拠ではない。

ボートの旧 `boat-base-v1` 学習・推論入力はBファイル由来の事前特徴量に限定する。新しい候補向け `boat-prerace-v2` は別の feature column allowlist を使い、公式 beforeinfo ページから実際に取得した exhibition / start-exhibition / weather 行と、racer IDで結んだ過去の完了レースだけを使う。各観測はURL・SHA256・取得時刻・利用可能時刻・表示時刻または元の表示ラベルと一緒に別テーブルへ保存する。ローカル日次collectorは同じ race-identified beforeinfo ページの明示ラベル `締切予定時刻` も読み、締切値と実取得時刻をレース行へ保存する。ページ上の race identity がURLと一致しない、締切時刻が欠ける／曖昧／すでに過ぎている場合は締切証跡を付けない。既存の確認済み締切とページ値が食い違う場合も既存値を保持して利用不可として報告する。曖昧な「11R時点」等のweatherラベルは保持するが特徴量には使わない。過去の racer form は完全な6艇結果と、racer ID・結果双方の明示的な available-at 時刻がそろう場合だけ使う。三連単の時点境界は確認済みの公式締切から60秒前 (`betting_cutoff_at - 60s`) とし、学習入力はその時刻までに利用可能な観測と締切証跡だけを使う。締切証跡の取得時刻がT-60より後のレースはV2学習対象から外す。日次推論の `prediction_as_of` は収集とレジストリ取得を終えた後の実時刻で、実行時点ですでに取得済みの情報だけを使う。締切T-60を過ぎたレースは再判定して推論から外し、後から同じ予測をT-60時点へ書き換えない。この保守的な近似により、日次実行後に届いた展示・気象情報は次の日次実行まで予測に入らない。確認済みの締切が無いレース、activeなV2三連単モデル／一致するartifactが無い場合は推論を棄権し、単勝予測へフォールバックしない。Bファイルの `available_at` はレース日 JST 0時の近似値で、実際の公開時刻は未検証という制約が残る。旧artifactはmarkerがない場合も `boat-base-v1` として扱い、V2列とは照合されない。Workerは保存済み予測を使い、予測deadline内にLLMや学習を実行しない。`ml/edgelab/learning.py` の採点は、実データ・全艇の予測と結果・締切前時刻がそろうコホートを対象とする。オッズを用いた仮想リプレイと実際の仮想購入履歴の成績は区別する。詳細と不足条件は [LEARNING](LEARNING.md)、既存モデルの監査結果は [EV_AUDIT](EV_AUDIT.md) を参照。

Worker の単一 `* * * * *` Cron は、各分で限定された自動**仮想**購入の時刻判断を行い、10分境界では別に精算・古いオッズ削除を行う。experimental marker 付きで登録されたモデルの独立した実験用判断も毎分1回評価し、通常の自動購入フラグ・モデル・成績・残高から分離する。これは :05 の結果収集による早期returnと10分境界の保守処理より先に行い、10分側で二重評価しない。判断は毎分のオッズ収集より先に実行し、時刻 :05 の結果収集による早期returnよりも先に実行する。10分境界の判定は実行遅延の影響を避けるためイベントの予定時刻に基づく。オッズ収集は毎回、対象を読み出した後に重複防止ロックを取得する。旧UTC日次のアプリ内推定予約は無効。通常終了ではロックを解放し、異常終了時の残留ロックは5分で期限切れになる。収集失敗時も10分境界の精算等は継続する。10分処理では1時間より古い単勝・三連単オッズWorkerの品質のみ（保存レコード0件）の収集ログを最大10件削除する。品質除外と通信等のエラーが混在するログ、記録を保存したログ、他ソースのログは保持する。SPEC の10分ごとに全処理を行う記述とは差分があり、SPEC は変更していない。許諾・デプロイ済み設定はコードだけでは確認できない。

BOAT RACE公式出走表の時刻欄は「締切予定時刻」と表示される（例: [公式出走表](https://www.boatrace.jp/owpc/pc/race/racelist?hd=20261011&jcd=09&rno=1)）。既存Bファイルパーサーは `races.post_time` にヘッダー先頭のHH:MMを保存するが、その値は締切証跡ではない。既存の単勝オッズ取得で既に取得した公式 odds ページを再利用し、ページ内に明示された「締切予定時刻」と一致する当該レースのページ識別情報を読めた場合だけ、`betting_cutoff_at`、`betting_cutoff_source='boatrace-racelist-cutoff-v1'`、`betting_cutoff_observed_at` を保存する。観測時刻は取得時刻で、5分ごとに更新し、判断時には10分以内の証跡を必須にする。追加fetchは行わず、ラベル・識別情報・時刻が欠落または曖昧なページは締切を更新しないため、購入は `missing_or_invalid_cutoff` で止まる。既に主判断または自動購入があるレースの締切値は書き換えない。`post_time` は締切欠落の明示的棄権を記録する短い探索窓にだけ使い、締切値として代入しない。

主判断の目標は、その明示された公式締切のT-60秒。Workerの実処理時刻が目標の前後10秒以内（実締切まで50〜70秒）の場合に限り、決定直前に時刻を再確認して記録する。この許容幅にはT-60より最大10秒遅い観測も含むため、目標時刻・入力as-of時刻（`input_as_of_at`）・D1に記録された実際の判断時刻（`decided_at`）・実締切までの秒数を別々に保存し、T-60ちょうどの観測とは表示しない。入力は判断開始時点までに保存された予測・オッズに限定する。Primary自動判断は三連単のactive検証済みticket予測だけを選び、win予測から確率を推定・変換しない。Workerの毎分Cronはこの時刻窓を評価するため、目標±10秒に処理が来ないレースは購入せず棄権として記録する。時間超過、締切証跡不足、active予測／確率／オッズ不備、期待値条件未達はレースごとの購入なしを記録し、後着オッズで履歴判断を作り直さない。D1書込は予算予約で拒否しない。実際のD1 provider failureが起きた場合に永続記録できない場合があるため、永続abstentionの根拠にはしない。購入とprimary決定またはabstentionは同一競合ガード下で行い、両方が同じレースに記録されないようにする。新しい購入ベットは `decision_phase='primary_t60'` とし、旧ベットは `decision_phase=NULL` のままで遡及分類しない。

T-30 / T-10 の比較観測は秒単位のスケジューラーがないため未収集・評価不可で、擬似時刻や後着オッズを作らない。分単位のB/K日次処理や3秒間隔の結果取得は、その比較観測時刻を提供しない。`GET /api/paper/decisions?date=YYYY-MM-DD` は日付単位の判断履歴、利用した締切ソース、実際のタイミング、および比較観測の利用不可状態を返す。既存 `/board` と `/performance/*` の購入済みベット集計は従来の運用総計であり、T-60のみの成績とは表示しない。移行 `0008_paper_decision_timing.sql`、`0009_verified_betting_cutoff.sql`、`0010_boatrace_prerace_observations.sql`、`0011_boatrace_capture_archives.sql` は追加列・追加テーブルのみで、既存データの書き換えをしない。


### 事前情報のデータ保存

既存の `ENABLE_BOATRACE_TRIFECTA_ODDS_SCRAPE` が有効な場合、毎時05分の結果専用回を除く毎分Cronのオッズ収集回で、Workerはモデル・予測に依存せず公式ページを取得できる。`post_time` はページ候補の探索に使い、既存の信頼済み締切は実取得の開始窓を絞るために使うが、保存する締切・艇・展示・オッズは公式ページから独立に再確認する。実データの6艇レースであること、公式ページの識別情報が一致すること、公式事前情報ページに明示された締切があること、締切前に取得した三連単120通りすべての数値オッズがあることを保存条件とする。各ページのURL、SHA256、本文取得完了時刻、パーサーバージョン、抽出値を別々に保存する。モデルや予測テーブルを読まず、取得1回につき不変JSONを1行だけ書く。購入条件は従来どおり、activeモデルと完全な予測に対する別の検証ゲートを使う。

収集器は既存の毎分オッズ収集後に動き、同じ最大49リクエスト予算を共有する。毎時05分は結果専用回のため実行しない。1回あたり最大4レース・最大12 fetch、リクエスト間隔3秒以上、応答本文512KiB以下。同一レースのアーカイブは3分以内の既存スナップショットがあれば再取得を抑止し、それより古い場合は実時刻で新しい独立行を追記する。候補は信頼済み締切ソースの到着窓内に限定し、公式ページから確認する締切・艇・展示・オッズの証拠を緩和しない。永続カーソルを進め、失敗や不正な艇番が先頭レースに固定されて後続を妨げないようにする。締切不足、公式ページ識別不一致、オッズ欠落、締切後の取得、リクエスト予算不足などは理由コードで返す。失敗の要約は同日分の `collection_runs` 1行に保存する。D1 provider failure時は保存できない場合がある。

移行 `0011_boatrace_capture_archives.sql` は日付・カーソル索引と更新・削除を禁止するアーカイブ表を追加する。120オッズは1つのJSON行に保存する。Workerは取得前にロックを取り、1回の実行あたりのrace/fetch上限を守って保存する。旧アプリ内日次推定予約は使わない。`GET /api/ingest/prerace-capture-archives?date=YYYY-MM-DD&cursor=...&limit=...` は既存 `INGEST_TOKEN` を使い、日付を1つ指定し、1ページ最大25件でPython側の復元に使える。exportは保存JSON本文とSHA256を返す。`import-prerace-archives` は本文・レースID・公式URL・120オッズを検証し、beforeinfoを既存の特徴量観測形式に、オッズをローカル専用manifest付き表に追加する。オッズは通常同期へ含めず、オフライン学習・リプレイだけで使う。同一manifestとchecksumは冪等に無視し、cutoffの同一証跡は最も早い実取得時刻を保つ。`/board` と `/performance/*` は引き続き購入済みレースの運用成績だけを扱い、この保存データは購入・判断を変えない。新規スケジューラー、binding、認証方式、D1 provider quota設定は変更しない。移行は追加型で、Worker公開前に適用が必要だが、本変更では本番DB/Workerに操作していない。

### 仮想バンクロールと bet の制御

- 初期値は `initial_bankroll=100000` 円、`unit_stake=100` 円。どちらも D1 の `settings` で管理される。
- 手動・自動とも単勝の仮想 bet のみ。手動はレースごとに最大6選択を1つの原子的な ticket group として記録し、stake は正の整数円（`unit_stake` の倍数制約なし）。自動は既定1候補、最大6候補まで設定でき、`auto_bet_race_budget`（初期値100円）を候補へ均等に整数円配分する。投票サイトや決済には接続しない。
- 新規 bet は購入時点のオッズ取得時刻・予測時刻と、当時の候補順位（有効な予測と鮮度内オッズがある候補を期待ROI降順、艇/馬番昇順で同率順序）を保存する。旧 bet は順位・グループ不明として比較対象から除く。`/performance/rank-comparison` は rank 1 を含む複数選択 group の全件確定レースだけを対象に、実際の複数 bet と rank 1 のみへ同額を配分した反実仮想を比較する。利益の証明ではない。
- 整数円 stake の仮想払戻は、`stake / 100 * 公式払戻` の1円未満を bet ごとに切り捨て、整数円で保存する。SPEC の `payout INT` は従来どおりだが、従来実装の stake 制約（`unit_stake` 倍数）は新しい手動 bet では適用しない。
- 自動購入は Worker の `ENABLE_AUTO_BET=true` または D1 `auto_bet_enabled=true` のどちらかで有効になる。最新予測のモデルが `active` で、オッズがあり、`min_expected_roi`（初期値 0.05）以上かつ `HIGH_EDGE` / `POSITIVE_EDGE` 判定の候補だけを対象とする。`max_prob_std`（初期値 0.05）を超える予測は edge 判定で除外される。週次学習で作られた `candidate` モデルは自動購入に使われない。
- 手動・自動の購入は、利用可能なactive予測と10分以内のオッズ、解析可能な未来の締切時刻を要求する。boatはさらに安全な特徴量markerと64桁artifact SHA256を持つactiveモデルに限定し、旧v1の既存予測を使わない。締切後・未来の予測やオッズを候補に使わず、異なるUTCオフセットはSQLiteの時刻変換で比較する。出走・予測・オッズ・結果の出所はレースと一致させる。これは収益保証ではなく、誤った時点の判断を防ぐ追加ガード。
- モデルingestはactive/retired行の状態・評価を上書きしない。古い番組表を再同期してもfinished/cancelledレースをscheduledに戻さない。
- 精算はレースと購入の出所が一致し、全出走が数値着順または公式Kファイルの対応済み非完走コードで表現され、全勝者の実単勝払戻がそろうまでopenを維持する。非完走コードは着順を捏造せず全出走の完全性だけを示す。非完走艇を選択した単勝は、払戻・返還の保存証跡がない限りopenを維持する。日次処理は前日と当日の結果・払戻に加えて、前日の公式非完走コードがある艇のentryだけを同期する。結果・払戻の別POSTや取り込み遅延だけで負けに確定しない。既に確定した過去の購入を自動で書き換える処理は追加していない。
- `ml/edgelab/sync.py` は Worker 側で行単位の照会が多い `races` / `payouts` / `entries` を10件ずつ送信し、他のレース関連データは50件ずつ送信する。socket timeout またはHTTP 500/502/503/504の場合に限り、同じ自然キーを使う冪等なpayloadを2秒後に1回だけ再試行する。HTTP 429・その他の失敗は再試行せず、失敗を上位処理へ返す。APIエラー応答は安全な許可済みcodeだけを報告し、本文や予測データを例外文字列へ含めない。
- `collection_runs` の記録は本体・行数を制限した固定要約のみ保存し、日次アプリ内予約枠で拒否しない。D1 provider failure時にログ自体を保存できない場合はある。
- bet を挿入する SQL 自体が利用可能額を条件にする。利用可能額は `初期 bankroll + 確定 bet の profit 合計 - open bet の stake 合計`。判定と挿入を同じ SQL 文で行い、同時実行で残高上限をすり抜けないようにしている。自動 bet はさらにレースごとの一意制約で重複を防ぐ。
- `/performance/overview` の `bankroll` は確定分の損益だけを初期値に加えた表示で、open bet の stake を差し引いた「今すぐ使える額」とは別。利用可能額の判定根拠は `apps/api/src/index.ts` の `availableBankrollSql`。
- `void` は払戻 0・profit 0 で精算される。open stake は精算まで利用可能額から控除される。

## データ安全・重要な不変条件

- `data_origin` は `sample` / `real` を分離する。合成 fixture はテスト用。公式実データ・予測・オッズ・結果をサンプルや補完値で代替しない。取得不能値は欠損のまま扱う。
- 予測時点で未公開の情報を使わない。特に結果を学習特徴量にしない。新しい特徴量・collector を追加するときは `available_at` と時刻の意味をテストする。
- ingest は自然キー upsert 前提。再実行で重複や新しい `data_origin` の混入を起こさない。サンプルと実データを統合する変更はしない。
- 実購入・外部決済は存在しない。自動 bet も仮想 D1 レコード。モデル昇格は明示操作であり、学習や Actions に自動昇格を足さない。
- API / Actions / Wrangler の秘密は値ではなく変数名だけを扱う。Actions の認証 Secret は `INGEST_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`。`EDGELAB_API_URL` は秘密ではなく、API を直接呼ぶ tracked Actions workflow では canonical API Worker URL を固定する。ローカル Python は引き続き環境変数で接続先を指定できる。Worker の非秘密フラグ名は `ENABLE_AUTO_BET`, `ENABLE_BOATRACE_ODDS_SCRAPE`。
- `data/raw/`, `data/private_fixtures/`, `ml/data/` はローカル／キャッシュ用途で、ignore 対象。公式データや運用 state を不用意に追加・出力しない。Wrangler のローカル秘密ファイルなど、秘密値を含むものも追跡・表示しない。
- `npm run dev` は起動前に `db:reset` を実行し、**ローカル D1 state を削除して**マイグレーションとサンプルを入れ直す。重要なローカルデータを保持したい場合は起動しない。

## GitHub Actions と変数名

- `.github/workflows/daily.yml`: cron は UTC `00:30`, `02:00`, `04:00`, `14:30`（JST 09:30, 11:00, 13:00, 23:30）と手動実行。朝の複数回は GitHub schedule の遅延・欠落に備える。Python 3.12 / Node 22 で日次 pipeline を実行する。
- `.github/workflows/retrain.yml`: 毎週月曜 UTC `02:41`（JST 11:41）と手動実行。boat の候補学習と比較を行い、候補の `models` 行だけを同期する。
- `.github/workflows/trifecta-experimental-pipeline.yml`: UTC `00:50`, `04:20`, `14:50`（JST 09:50, 13:20, 23:50）の schedule は `learning_only` 固定で、PIT archive/結果ラベル取込、weather-missing experimental候補の学習・shadow比較・artifact保存のみ行う。registry登録・forecast submissionは行わない。手動の `train_and_forecast` と登録済みartifactを指定する `forecast_only` は維持。shadow holdoutはrace-date block単位、train-only lane-order baseline比較で、全cohort fit artifactの独立検証を意味しない。
- `.github/workflows/daily.yml` の既存schedule入口が再利用可能な `.github/workflows/trifecta-experimental-forecast.yml` を呼ぶ。UTC 00:40 / 05:40 / 10:40 の best-effort schedule または手動 dispatch で、依存と共有 daily cache の復元後に最長300分の予測専用runnerを起動する。毎分、最新登録candidate/experimentalの完全一致ID/SHA bundleを検証し、当日のPIT archive更新後の実時計で `target-5m..target`（締切 `T-6m..T-1m`）内の全対象を生成、締切順に1レースずつ独立POSTする（最大180レース、単一拒否は他対象を止めない）。学習・登録・昇格・共有cache保存はしない。Worker判断は既判断レースを除外し、同時締切の全対象を検査する。各tickは失敗を固定分類で記録し次tickで再開し、遅れたtickを過去時刻で再実行しない。concurrencyは別groupでcancelせず、外部schedule・runner供給・処理時間は常時稼働やT-60到着を保証しない。長時間runnerはActions使用分を消費するため、無料枠内の継続運用はGitHub契約・公開状態・使用量の別確認を要する。
- forecast submission のPython `urllib` 経路で観測された403を受け、API を直接呼ぶ tracked Actions workflow は canonical `https://roi-plus-api.suuu-sh.workers.dev` に固定し、`INGEST_TOKEN` Bearer 認証は維持する。`.github/workflows/verify-api-routing.yml` は手動実行の読み取り専用 `GET /api/health` でHTTP 200と API revision marker を確認する。workflow の静的設定や health 成功だけでは forecast 保存を証明しない。学習専用 schedule は従来どおり認証・UA・security 設定を変更せず、候補 artifact 保存を本番推論／仮想購入の稼働証明とみなさない。
- 実験予測 POST は明示的な `ROIPlus-Forecast/1.0` User-Agent を送る（Python urllib の既定UAが API Worker 到達前に403となり、明示UAでは API の401 JSON応答に到達することを確認）。Bearer 認証・予測検証は維持する。
- `.github/workflows/deploy-workers.yml`: `main` への push のうち API / Web / shared、root npm manifest・lockfile、D1 migrations、readiness gate の本体・テスト、またはこの workflow 自体を含む変更で実行する。migration readiness テスト、typecheck、全テスト、Worker dry run / web build、読み取り専用の D1 ledger readiness を通過した後に API deploy・health check・Web deploy を行う。PR 更新では実行しない。workflow 自身と gate 入力を paths に含め、デプロイ設定や fail-closed gate の修正も通常の検証経路を通す。
- 学習 pipeline は `boat-learning-state`、予測専用 workflow は `boat-experimental-forecast` と別の concurrency group を使う。学習側が `ml/data` と `ml/artifacts` を cache に保存し、予測側は同じ cache を読み取り専用で復元する。学習レポートは学習側で Actions artifact に保存する。
- Actions Secret 名は `INGEST_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`。値、アカウント ID の実値、ローカル保管場所は文書・ログ・チャットに書かない。Cloudflare Access の設定や Worker Secret はコード外で管理する。

## 開発・テスト・デプロイ

前提は Node.js 22+、Python 3.11+。リポジトリルートで:

```sh
npm ci
python3 -m venv ml/.venv
ml/.venv/bin/pip install -r ml/requirements.txt
npm run dev
```

`npm run dev` はローカル API (`127.0.0.1:8787`) と Web (`localhost:5180`) を同時起動し、ローカル D1 を初期化する。ingest を使う場合はローカル Worker に `INGEST_TOKEN` を安全に設定し、同期側にも同じ値を環境変数として渡す。秘密値をコマンド引数・シェル履歴・ログへ書かない。

```sh
npm test
npm run typecheck
ml/.venv/bin/python -m pytest ml/tests -q
npm -w apps/web run build
```

既存 Worker へのデプロイコマンドは次のとおり。いずれも Cloudflare の本番環境に変更を加えるため、明示的な依頼なしに実行しない。リモート D1 migration / SQL も同様。

```sh
npm -w apps/api run deploy
npm -w apps/web run deploy
```

ローカル D1 の初期化だけを行うコマンドは `npm run db:reset`（破壊的・ローカルのみ）。Wrangler 設定は `apps/api/wrangler.toml` と `apps/web/wrangler.jsonc`。ID や認証値は設定から転記・文書化しない。

## リポジトリマップ

| パス | 役割 |
|---|---|
| `apps/web/src/` | React 画面、API client、origin filter |
| `apps/web/worker.ts`, `apps/web/wrangler.jsonc` | Assets 配信、API Service Binding、Web Worker 設定 |
| `apps/api/src/index.ts` | Hono REST API、認証、ingest、仮想運用、Cron |
| `apps/api/src/services/`, `repo/` | オッズ取得・判定・D1 adapter |
| `apps/api/wrangler.toml` | API Worker / D1 binding / Cron / feature flags |
| `packages/shared/` | 共有型、期待値・判定・評価指標 |
| `db/migrations/`, `db/seed/` | D1 schema と sample data |
| `ml/edgelab/` | Python CLI、collector / parser / feature / model / prediction / sync |
| `ml/tests/`, `apps/*/test/`, `packages/shared/test/` | ML / Worker / UI / shared ロジックのテスト |
| `data/fixtures/` | 合成テスト fixture。公式実データを追加しない |
| `.github/workflows/` | Worker deploy gate / release、日次 pipeline、週次 retrain |
| `scripts/` | 手動運用用ラッパー。内容確認と本番影響確認なしに実行しない |

## 券種拡張（2026-10-10 開発中）

ユーザー依頼による拡張として、単勝とは別の `ticket_predictions` を追加し、ボート3連単の順序付き120組を扱う。これはSPECの単勝限定API・元の予測スキーマとの差分であり、SPECは書き換えていない。他券種は型に存在しても購入対応済みとはしない。

- 三連単は着順を学習した独立のランキングモデルから整合した確率分布を作る。単勝確率の積を使わない。時間分離holdout、trainだけで作る艇番順序基準、実際の取得時点のオッズで検証する。
- 候補は自動昇格しない。券種・artifact・独立検証証跡が一致したactiveモデルのみ仮想購入可能。未取得、未検証、確率集合不完全、標準偏差欠損、公式オッズの出所／組番／時刻不整合なら候補にしない。
- Primary T-60 の自動判断は三連単の保守的ROIだけを見て、単勝予測との比較をしない。最大候補数とレース予算は既存設定で制御し、全購入を同じレース予算内に収める。
- 結果と券種の払戻が整合しない場合はopenを保持する。同着・欠場・返還を含む三連単は現時点で対象外。取得時オッズと払戻換算オッズは区別する。
- 公式ページの実データ照合は [TICKET_DATA_AUDIT](TICKET_DATA_AUDIT.md) の1レースのみ。全履歴の公式一致、取得許諾、本番反映、利益は未証明。
- 本変更のリモートD1 migration、本番Workerデプロイ、新モデル昇格は未実施。既存単勝運用とは区別する。
- D1 変更は `0004_ticket_predictions_and_odds_evidence.sql`（購入時オッズ時刻は既存の `0007_ranked_multi_bets.sql` を利用） の追加 migration。三連単オッズ収集は `ENABLE_BOATRACE_TRIFECTA_ODDS_SCRAPE` が明示的に有効なときだけ Cron で動き、未設定／false が既定。単勝と共有する Worker fetch 試行上限49・最低3秒間隔を守る。取得は6艇120組が完全な非確定市場だけ保存し、source URL・取得時刻・本文 SHA-256・品質状態を記録する。これらは出所記録であり、署名や利用許諾の証明ではない。
- Primary T-60 自動購入は三連単だけで、単勝予測に依存しない。モデル学習時刻は予測時刻より厳密に前であることを要求する。

## 購入済みボートの毎時結果取得（2026-10-11）

`ENABLE_BOATRACE_RESULTS_SCRAPE` が明示的に `true` の場合だけ、既存毎分 Cron の **毎時05分**を結果ページ取得に割り当てる。実装の未設定／false は無効。本プロジェクトの設定には、ユーザーによる結果ページ取得・本番反映の明示承認後に true を追加した。設定ファイルだけではデプロイ完了・実取得を証明しない。許諾はユーザー申告に基づき、独立した証明ではない。

- 通常の毎時回は従来どおり、非隔離の実データ・ボートで締切から5分以上経過したopen仮想購入（単勝／三連単）のみが対象。明示確認付き手動routeの `labelOnly: true` に限り、現在JST日・実締切から5分経過・T-60以前のsource検証済みcapture archiveあり・open購入なし・結果worker成功証跡未保存のレースを、最大4レース（最大8 fetch試行）対象にできる。予測・モデル・履歴全体は取得／再実行せず、正常な全着順と必要な払戻が保存済みなら通常回は再取得しない。
- 公式 `https://www.boatrace.jp/owpc/pc/race/raceresult` を共有49試行枠の内側で、通常回は最大16 fetch試行、手動回は既存5分 lease内に収める最大8 fetch試行で扱う。通信失敗時のみ1回再試行し、取得間隔3秒以上、1試行30秒、本文512 KiB以内とする。8対象以下のD1 batchを必要に応じて繰り返す。レース数の固定上限は設けず、未処理対象は次回用に残す。対象は最終試行の古い順に選び、未公開・Cron遅延により、全購入の1時間以内反映は保証しない。
- 05分の結果専用回ではオッズ取得を実行しない。他59分のオッズと10分境界の精算・自動仮想購入・cleanupは維持する。同じCronの49 fetch budgetを渡し、追加49枠は設けない。JSON bulk insertを使い、対象を前回試行の古い順に選ぶ。日次のアプリ内書込予約は使わないが、fetch・batch・lock等の個別上限は維持する。Cloudflare D1 provider quota保証ではない。
- URLと本文の場コード画像・active開催日・唯一の選択レース・active結果タブを照合する。保存済み6艇の登録番号を必須とし、艇番ごとに一致する全6着順（1〜6の重複なし）と勝者の正の単勝払戻を要求する。三連単は1〜3着の組番一致も要求する。部分結果、欠場・非完走・同着・返還・中止等は拒否しopenを維持する。返還の見出しだけでなく実値を判定する。
- 着順／払戻／finished状態／成功証跡をD1 batchで原子的に保存する。各statement内でもrace identity・open実購入・隔離除外・6艇の登録番号・既存結果との一致を再確認し、fetch待ち中の状態変更を拒否する。既存結果・確定購入の修正、entry特徴量の変更、払戻の購入時オッズへの流用はしない。
- `collection_runs` の source `boatrace-results-worker-v1`、固定ID `boat-result:<raceId>` で1レース1行の最新試行だけを保持する。reason JSONにrace ID、公式URL、取得時刻、本文SHA-256、品質状態、検証済み結果／払戻、安全な固定失敗理由を保存し、本文・任意例外文は保存しない。これは出所記録であり署名ではない。公式結果worker証跡はAPI ingestからの作成・上書きを拒否する。
- auth付き `GET /api/ingest/experimental-trifecta/training-results?date=<current JST date>&limit<=5&cursor=...` は、source証跡・公式SHA/URL・実取得時刻・T-60以前のcapture archiveが揃うレースのうち、通常6着順と勝者一致の正の三連単払戻がD1に一致するラベルだけを返す。結果情報だけを返し艇特徴量を含めない。K取得時刻を過去へ付け替えず、学習側は結果／払戻のみ追加しB特徴量を変更しない。

成功結果は次の既存10分精算で照合する。最大8試行×30秒＋最大7間隔×3秒で、network＋spacingの最悪経路は261秒以内（DB処理時間・Cron遅延は別）。05分に実行開始して取得が間に合った場合は通常10分の精算に反映するが、遅延時は次回以降となる。安全なCronログ `boat-hourly-results` は状態・対象数・検証済みレース数・保存レコード数・fetch試行数・固定失敗理由、およびfetch失敗時の固定分類・HTTP status・件数だけを記録し、本文・応答ヘッダー・任意例外文は出さない。Workerのfetchは `redirect: manual` とし、3xxは追跡せず拒否し、HTTP／宣言サイズによる早期拒否時も応答bodyをcancelする（workerdは `redirect: error` を受け付けない）。既存の夜間B/K日次同期は維持する。新しいKラベル取得は、上記の手動 label-only 条件を追加したもので、通常の日次同期の入力やB特徴量を変更しない。SPEC §2/§5のB/K採用・Worker結果照合のみという記述とは追加取得元・頻度の差分があり、SPECは変更していない。

手動実行は Data 画面の「購入済みの結果を今すぐ取得」のクリックから、`POST /api/admin/collect-boat-results` に `confirmed: true` を送る。設定済みの信頼済みfrontend proxy認証またはingest bearer認証と取得フラグの有効化を必須にする。`labelOnly: true` は同じ認証・確認を必須にする追加の明示モードで、既存画面の通常リクエストでは起動しない。hourly markerだけを回避し、別の5分lease／完了後60秒throttleで手動重複を抑止する。対象・fetch上限・出所・隔離・原子的保存のガードは同じで、label-onlyは最大4レース、最大8 fetch試行、最低3秒間隔。結果取得後、別HTTP呼び出しの既存 `POST /api/admin/settle` を明示実行する。proxy経由の精算にも `confirmed: true` を要求し、従来のingest bearer認証とingest APIの認証は弱めない。精算は従来どおり保存済み結果のopen betを対象とする。初期表示に新しいGETは追加せず、取得・精算の件数／未確認状態を表示し、日次推論・学習を起動しない。

根拠: `apps/api/src/services/boatraceResults.ts`, `collectBoatraceResults.ts`, `apps/api/src/index.ts`。現行Cloudflareの [D1 per-invocation limits](https://developers.cloudflare.com/d1/platform/limits/) と [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/) を確認し、オッズ／精算の同時実行を結果専用回から分離した。

## 会場混同の復旧ガード

共通B/Kパーサーは唐津/津の重複を避けるため長い場名を優先する。旧モデルは復旧済みの出所markerがないため稼働・昇格・rollbackから除外し、正確なartifact/クリーンな入力に基づく候補を別IDで人手検証する。`auto_bet_paused` はWorker有効フラグより優先する停止条件。migration 0006の永続隔離は表示・精算・校正・資金計算・再ingestに適用する。migration 0007 は bet に購入時点のグループ・順位・候補母数・予測/オッズ時刻を追加する。なお SPEC §3/§5 は単一 bet と `unit_stake` 倍数を記述しており、現実装の複数選択・正の整数円 stake と差分がある。払戻列は整数円 `INT` のまま、切り捨て規則を導入した。SPEC は変更していない。原本からの修復と、固定評価期間の候補検証・Actions artifact復旧の流れは [RECOVERY](RECOVERY.md) を参照。

三連単の収集は既存の per-invocation fetch上限と対象件数制限を守る。アプリ内日次推定予約は無効化済みで、Cloudflare D1 provider quota残量の計測・保証は行わない。取得許諾は公式サイトオッズについてのユーザー申告に基づき、独立した許諾証明ではない。

### 結果取得時の三連単最終市場

三連単の仮想購入があるレースでは、公式結果の検証後に任意で `odds3t` を取得する。同じ結果取得の fetch 上限・3秒間隔・30秒 timeout・本文上限・通信失敗時1回retryを使う。公式の「締切時オッズ」表示、レースidentity、完全な120組、勝者のオッズと結果払戻÷100の一致が揃う場合だけ、結果の原子的成功証跡内 `finalMarket` に URL・本文SHA256・実取得時刻・120組を保存する。取得不可／不整合でも結果の保存と精算を妨げず最終オッズは欠損を保持する。購入時のオッズ・予測値は書き換えない。

通常betの未精算三連単は、負け券でもこの証跡の該当組番から `final_odds` を保存する。実験購入履歴は同じ証跡から負け券の `finalOdds` を表示する（返還・修復券は除外）。実験購入があり結果完了済みでも最終市場証跡がないレースは、既存結果取得の対象選択／試行上限内で再取得対象になる。公式ページが過去市場を公開しない場合は欠損のまま。SPECの「勝者以外は欠損」というK払戻代替に対する追加取得元の差分で、SPECは変更していない。

### T-60 購入時オッズの再取得（2026-10-14）

通常・実験の三連単自動仮想購入は、既存の締切60秒前±10秒の判断枠で公式120組市場を再取得し、そのオッズで期待値・購入額を判断する。保存済みオッズへのfallbackはしない。取得失敗・不完全・最終市場・判断枠超過は購入を見送る。予測時刻と特徴量の利用可能時刻は変えず、購入用市場の実リクエスト時刻・実取得完了時刻・URL・本文SHA256・120組をdecision snapshotの`purchaseOdds`に保存する（通常betの`odds_captured_at`も実取得時刻）。取得が正確に60秒前の瞬間だったとは表示しない。

毎分Cronの既存49 fetch枠・最低3秒間隔を共有し、同一呼び出しでは通常／実験の同一レース市場を再利用する。本文上限512 KiB・判断枠残時間のtimeout・1レース1試行とし、retry待ちで他レースの判断枠を占有しない。設定フラグが無効なら取得せず購入しない。既存の予測用capture archiveは変更せず、遅延取得で予測時刻を付け替えない。実験購入のbankroll更新にもSQL実行時の締切枠・scheduled・隔離除外の再確認を追加した。SPECの低頻度取得記述とは差分があり、SPECは変更していない。

### 承認付き通常購入履歴リセット

`reset-normal-purchase-history.yml` はユーザーの明示承認を受けた通常購入・成績・残高のリセット専用operatorである。exact source SHAと `RESET NORMAL PURCHASE HISTORY ONLY` の確認を必須にし、INGEST_TOKEN認証のsnapshot routeで通常 `bets` / `daily_summaries` と保護対象（通常decision監査、実験購入・decision・bankroll）を一貫したD1 batchで取得する。秘密設定は取得せず、初期資金値だけを扱う。リセット前にアクセス制御されたActions artifactへsnapshotを30日保存し、upload成功後だけreset routeを呼ぶ。

resetはsnapshot全行と初期資金を同じatomic D1 batchの先頭で照合し、購入・精算などの変更があればSQLエラーで全処理をrollbackする。削除は通常 `bets` / `daily_summaries` だけで、初期資金設定、通常decision監査、実験台帳・残高、レース・結果・予測・出所は変更しない。通常残高・成績はbetsから計算されるため初期資金／ゼロに戻る。実行後に保護対象の行数・SHA256を比較する。バックアップからの復元は自動化せず、artifactのJSON内の元列・元値を用いて別途人手レビューと明示承認を行う。SPECは変更していない。

### 過去データBASE三連単の専用仮想実験（2026-10-14）

未検証の過去データ学習BASEモデルを通常昇格や既存13レース実験と混同しない、固定モデルID `boat-trifecta-historical-base-20261014` の専用仮想経路。学習artifact source snapshotは `origin/main` の `839bb56`、この実装のrelease baseは `8aa37ac`。配布はWorker静的JSONの5 fit重み（pickle SHA-256 `b7688efcec865ce2bc9e770ec9e39631742481db5bc8a5f9b5a8b7ee2cbe0b3a`、immutable version `2026-10-14.1`）を使い、BASE 13列の固定allowlist、ソースSHA、fit数と有限値をruntimeで検証する。通常モデルregistry・昇格資格・既存experimental latest selectorは変更しない。

入力は現在の公式出走表の6艇 rosterに一致し、利用可能時刻がT-60以前で実際のarrival timestampが確認できる実データだけ。Bファイルの日次取得の検証済みsidecarから取込時刻・公式URL・本文SHA-256を既存 `features_json` に保持し、runtimeは6艇の共通SHA、canonical source URL、`source_available_at === entries.available_at`、取得時刻がtarget以前を確認する。JST 0時に合成された `available_at` やsidecarのないcacheは証跡として認めない。この当日B source gateは過去学習行のPoint-in-time証明ではない。source-bound archive identity/roster、公式三連単120組のcapture freshness、締切source・時刻ガードを再利用し、展示値は検証目的のarchiveに存在しても特徴量に渡さない。購入判断時の公式オッズは既存 `fetchPurchaseOdds` によるfresh complete marketだけで、保存済市場fallbackをしない。既存実験と独立したT-60の仮想残高・判断/券台帳、精算経路、UI/APIを持つ。現在の専用実験 ledger 以外に過去 raw 15kレコードや全過去120券の予測履歴は投入しない。

専用D1台帳は `0014_historical_trifecta_experiment.sql` の add-only 3 tables。`workflow_dispatch` でmainから実行する `historical-trifecta-schema.yml` は、bounded read-only `d1_migrations` queryを使い、このcheckoutの全migrationが適用済みか、唯一の不足が0014の時だけ進めるfail-closed手動経路。通常のmigration readiness checkはlocal migration一覧との完全一致を確認するため、migration名allowlistの追加更新は不要。既存の日次収集/syncがmainのこのコードで次回動作した後に、初めてsource sidecar付き新鮮行が見込める。既存収集・秘密同期・raw archive upload経路は増やさない。通常のwriteBudget推定は無効化済みno-opで、49 fetch枠など既存の実行時上限以上のprovider quota保証は主張しない。学習10508/校正2213/検証2070はレース件数、過去PIT/ROI証明、収益性、通常昇格資格はfalseのまま。仕様書は変更せず、SPECの通常qualified model/実験レジストリ設計との差分として記録する。

### 固定BASEモデルのR2観測アーカイブと3か月候補学習

`historical-trifecta-candidate.yml` は毎週、JST暦月で直近3か月（開始日を含み、as-of日を除外）のR2観測を読み、公式結果ラベルと結合できた実レースだけで時間順train/calibration/testの候補を評価する。2026-10-14時点の窓は2026-07-14以上・2026-10-14未満。保存開始前の過去オッズ・特徴量を遡及生成しないため、初回はデータ不足で候補が作られないのが正常で、3か月分の履歴が揃うまではその状態をreportに記録する。

R2は固定モデルID `boat-trifecta-historical-base-20261014` / version `2026-10-14.1` / source SHA-256 `b7688efcec865ce2bc9e770ec9e39631742481db5bc8a5f9b5a8b7ee2cbe0b3a` のBASE 13列・6艇・順序付き120確率を記録する。学習readerはWorker同梱モデルmetadataとの完全一致、`trainedAt <= predictedAt`、公式BファイルURL・本文SHA・実到着時刻、6艇rosterの公式archive証跡、T-60締切証跡、公式120組オッズ時刻を再検証する。特徴入力は`availableAt <= predictedAt`、確率は実際の`predictedAt`がT-60 targetの±10秒、購入判断用オッズは`requestedAt <= capturedAt <= observedAt`かつtargetの±10秒を満たす場合だけ受け入れる。オッズはBASE特徴量に混ぜず、推論後に取得されることもある。すべての時刻を後付けしない。結果・正確な三連単払戻は別の認証済み公式label exportから取得し、確定時刻が予測より後で全着順・勝者・払戻が一致するラベルだけを使用する。未保存・不完全・取得失敗は欠損のままcoverage reportに残し、全件収集を主張しない。

週次処理はfingerprint付きの新規candidate artifactとActions reportだけを作る。通常registry、推論同期、予測、購入判断、live係数の変更はしない。同じsnapshotの候補artifactはartifact SHAを検証して再利用し、別snapshotは別IDにする。最低300のtraining raceと時間分離calibration/testがない場合は`insufficient_data` / `unqualified`とし、少ないデータから昇格資格・利益を主張しない。再学習candidateのtest結果と、元のR2保存確率の同じtest raceに対するproper scoreを別々に評価する。profitabilityは実際の時刻付きオッズと完全一致払戻が揃う場合以外は算出しない。Actionsには候補と監査manifestだけを保存し、R2 raw archive本体はartifact化しない。自動昇格・R2削除・TTL変更は行わない。

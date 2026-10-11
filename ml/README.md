# EdgeLab ML

Python 3.11+ 用の収集・特徴量・学習 CLI です。依存は `ml/.venv` に導入済みの
`pandas`, `numpy`, `scikit-learn`, `lightgbm`, `lhafile`, `pytest` のみを使います。

```sh
PYTHONPATH=ml ml/.venv/bin/python -m edgelab collect-boat --from 2026-09-01 --to 2026-09-01
PYTHONPATH=ml ml/.venv/bin/python -m edgelab train --sport boat
PYTHONPATH=ml ml/.venv/bin/python -m edgelab train-trifecta
PYTHONPATH=ml ml/.venv/bin/python -m edgelab predict --sport boat --date 2026-09-02 --cutoff 2026-09-02T08:00:00+09:00
EDGELAB_API_URL=https://example.invalid INGEST_TOKEN=... PYTHONPATH=ml ml/.venv/bin/python -m edgelab sync
PYTHONPATH=ml ml/.venv/bin/python -m edgelab backfill --from 2026-01-01 --to 2026-09-01
PYTHONPATH=ml ml/.venv/bin/python -m edgelab backfill-sync --since 2026-01-01 --until 2026-09-01 --dry-run
ENABLE_BOATRACE_ODDS_SCRAPE=true PYTHONPATH=ml ml/.venv/bin/python -m edgelab live --date 2026-10-09 --window-min 25
```

ネットワーク収集は公式ボートレース日次 LZH のみを対象にします。取得済み
ファイルは `data/raw/boatrace` に保持し、再実行時は再取得しません。未開催日は
スキップ扱いです。番組表は前日利用可能、競走成績内の展示情報は締切 10 分前
利用可能として扱います。モデル成果物は `ml/artifacts/` に保存されます。

`train-trifecta` は保存済み実データだけで、完全な6艇K着順から pairwise ranking
候補を学習し、Plackett-Luce による厳密な三連単順序確率を時間順holdoutで採点します。
三つの単勝確率の積は使いません。holdout払戻リプレイは同一レースの締切10分前より
前に記録された公式・完全・非締切の三連単オッズ一式がある場合だけ実施し、不足時はROIを算出しません。
仮想リプレイは5本以上の独立fitによる ticket確率標準偏差を要求し、`(p - std) * odds - 1`
の保守的ROIと標準偏差上限で1レース1点（最良の三連単）を選びます。これは単一券種の
過去リプレイであり、全券種をまたぐ運用方針の検証ではありません。候補学習はモデル行をローカルへ記録しますが、
推論・リモート同期はせず、昇格も自動化しません。過去のB公開時刻は
実測されておらず、保持された実績も将来利益を証明しません。

`ticketEventPooledEce` は全レースの120 ticket-event行をまとめた micro ECE です。
レース内ticketは依存するため校正の参考値に限り、レース単位のtop-ticket ECEと各binの
レース数・予測値・的中率も併記します。いずれも昇格や利益の証明には使いません。

推論にはレジストリ上で明示的に active となり、候補評価の承認ゲート、三連単の意味論、
特徴量schema、artifact SHA256 がすべて一致するモデルが必要です。例:

```sh
PYTHONPATH=ml ml/.venv/bin/python -m edgelab predict-trifecta --cutoff 2026-10-10T08:00:00+09:00
PYTHONPATH=ml ml/.venv/bin/python -m edgelab sync --tables ticket_predictions
```

前者は保存済みローカル実データに予測行を保存するだけです。後者の同期は明示的な
ユーザー操作で、API側の buy-eligibility 条件を満たすことを保証しません。

公式サイトの単勝オッズ取得は `ENABLE_BOATRACE_ODDS_SCRAPE=true` の場合のみ有効です。
締切前25分以内のレースを10分ごとの実行で1回だけ取得し、1回最大30リクエスト、
リクエスト間隔は最低3秒とします。同一レースの直近10分以内の取得と確定オッズは
再取得しません。運営負荷を避け、定期実行は10分間隔を超えて頻繁に行わないでください。

GitHub Actions の `daily.yml` は当日・前日の結果と払戻を優先し、出走表・安全な
activeモデルの予測を同期して、保存予測の feedback scoring を行います。過去履歴の
D1 backfill は日次のD1同期から完全に分離しています。ローカル正規化キャッシュと Actions
cache は学習・feedback 用に維持し、cache miss 時の過去データ収集もローカル保存のみで
続けます。D1の日次書込枠を過去履歴で消費しません。
日次結果は `daily_collection_success` と `forecast_status` (`ready` / `not_ready`) を
別々に報告し、モデルや artifact が利用できない場合・対象レースがない場合は
具体的な `forecast_reason` を記録しつつ結果同期と
feedbackを続行します。`retrain.yml` は週次に
`python -m edgelab learn` を実行し、新しい完了実データが30レース以上ある場合に
限り別IDの候補artifactを作成・同一 temporal holdout で評価します。比較不能・
非改善の候補は `metrics_json.promotionEligible=false` になり、手動昇格も拒否されます。
どのActionも自動昇格しません。日次は認証済みモデルレジストリからactive IDを
読み、artifact欠損・旧late-feature列の場合は推論だけを止めて結果収集/同期を続けます。
feedback artifactは各Actionの `learning-feedback-*` / `learning-report-*` として保存されます。
必要な Actions secrets:

- `EDGELAB_API_URL`: ingest API のベース URL
- `INGEST_TOKEN`: ingest API bearer token
- `CLOUDFLARE_API_TOKEN`: Wrangler D1 情報取得用 token
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account ID

### venue v2 キャッシュ移行と単勝候補の復旧

`daily.yml` は `ml/data/boat-venue-v2.json` がない場合、対になったキャッシュ済み
B/K ファイルだけからローカル正規化行を再構築します。過去予測・オッズ履歴は保持し、
旧レース・結果・払戻・モデル状態は再利用しません。この移行処理自体は API へ同期せず、
マーカー作成後の日次処理は通常どおり続きます。

`.github/workflows/recover-win-baseline.yml` は手動 dispatch 専用です。既定の厳密な日次
キャッシュキー以外を拒否し、cache fallback や公式データの再取得はしません。候補を固定
train/validation/test 期間で評価し、candidate 状態だけを登録します。認証済みレジストリ
検証レポートと JSON/pickle artifact ペアを90日保存します。自動昇格・仮想購入の有効化は
しません。手動昇格後に daily でartifactを復旧する場合は、`validated_model_run_id` と
その run の正確な `validated_model_artifact_name` を指定してください。

`backfill` はローカル履歴を収集するコマンドです。`backfill-sync` は既定でリモート
D1書込を拒否し、`--dry-run` の推定だけを実行します。過去履歴のリモート同期は
日次ワークフローからも外しており、将来の明示的な運用判断なしに実行しません。
Actions cache が空の場合は履歴をローカル収集しますが、D1へ自動送信することはありません。
学習済みモデルは `ml/artifacts/` の cache が空だと推論だけが not-ready になります。
必要なら `workflow_dispatch` で `retrain.yml` を実行して cache を作成してください。

### ローカル Worker へ同期

別ターミナルで `apps/api` のローカル Worker を起動します:

```sh
npm -w apps/api run dev
```

Worker は `http://127.0.0.1:8787` で起動します。`apps/api/.dev.vars.example` の
`INGEST_TOKEN` と同じ値を `apps/api/.dev.vars` に設定し、次のように同期します
（トークン自体は共有・記録しないでください）:

```sh
EDGELAB_API_URL=http://127.0.0.1:8787 INGEST_TOKEN='<.dev.vars と同じ値>' PYTHONPATH=ml ml/.venv/bin/python -m edgelab sync
```

同期は venues → races → models → results → payouts → entries → predictions → ticket-predictions → odds → collection-runs の順で行い、親行とモデル状態の後に結果・払戻を先行します。各 POST は最大 500 行です（race依存テーブルは最大50行）。

パーサー・リーク防止・分割・学習・比較の確認:

```sh
ml/.venv/bin/python -m pytest ml/tests -q
```

ローカル保存予測の採点は network-free です:

```sh
PYTHONPATH=ml ml/.venv/bin/python -m edgelab feedback
```

レポートは `ml/data/learning/report.json`、replay-safe な採点記録と学習checkpointは
`ml/data/learning/` に保存されます。実データ・全艇の結果・完全な事前予測cohort・
安全なartifact feature schemaを検証できない予測は除外します。旧v1の遅い特徴列を
使った可能性がある履歴は採点対象にしません。ROIは事前の実オッズと記録済み勝者払戻を
使う counterfactual replay で、実購入や本番auto-betの利益を証明しません。詳細は
[docs/LEARNING.md](../docs/LEARNING.md)。

ユーザー提供の競馬 CSV のみを取り込みます。サンプルの競馬データは同梱・生成
しません。予測・払戻・オッズ等、ソースで得られない値は欠損として残します。


### テスト用フィクスチャ

`data/fixtures/boatrace/` の B/K テキストとオッズ HTML は、パーサー確認用の合成データです。
個人名・実際のレース結果・オッズなどの公式実データは含みません。従来の公式取得ファイルは
ローカルの `data/private_fixtures/boatrace/` に移動しており、Git 管理対象外です。
テストや CI は合成フィクスチャを使用します。公式データが必要な場合は、公式サイトから
対象ファイルを個別に取得し、次の対応でローカルに配置してください。

- 番組表 B: `data/private_fixtures/boatrace/b260901.txt`（CP932）または
  `b260901.utf8.txt`（UTF-8）
- 競走成績 K: `data/private_fixtures/boatrace/k260901.txt`（CP932）または
  `k260901.utf8.txt`（UTF-8）
- オッズ HTML: `data/private_fixtures/boatrace/oddstf_24_12_20261009.html`（UTF-8）

ファイル名は例です。ローカルの処理に合わせて実際の取得ファイル名で保存し、
`data/private_fixtures/` 以下のファイルは Git にコミットしないでください（ignore 済み）。

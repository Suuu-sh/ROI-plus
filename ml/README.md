# EdgeLab ML

Python 3.11+ 用の収集・特徴量・学習 CLI です。依存は `ml/.venv` に導入済みの
`pandas`, `numpy`, `scikit-learn`, `lightgbm`, `lhafile`, `pytest` のみを使います。

```sh
PYTHONPATH=ml ml/.venv/bin/python -m edgelab collect-boat --from 2026-09-01 --to 2026-09-01
PYTHONPATH=ml ml/.venv/bin/python -m edgelab train --sport boat
PYTHONPATH=ml ml/.venv/bin/python -m edgelab predict --sport boat --date 2026-09-02 --cutoff 2026-09-02T08:00:00+09:00
EDGELAB_API_URL=https://example.invalid INGEST_TOKEN=... PYTHONPATH=ml ml/.venv/bin/python -m edgelab sync
PYTHONPATH=ml ml/.venv/bin/python -m edgelab backfill --from 2026-01-01 --to 2026-09-01
ENABLE_BOATRACE_ODDS_SCRAPE=true PYTHONPATH=ml ml/.venv/bin/python -m edgelab live --date 2026-10-09 --window-min 25
```

ネットワーク収集は公式ボートレース日次 LZH のみを対象にします。取得済み
ファイルは `data/raw/boatrace` に保持し、再実行時は再取得しません。未開催日は
スキップ扱いです。番組表は前日利用可能、競走成績内の展示情報は締切 10 分前
利用可能として扱います。モデル成果物は `ml/artifacts/` に保存されます。

公式サイトの単勝オッズ取得は `ENABLE_BOATRACE_ODDS_SCRAPE=true` の場合のみ有効です。
締切前25分以内のレースを10分ごとの実行で1回だけ取得し、1回最大30リクエスト、
リクエスト間隔は最低3秒とします。同一レースの直近10分以内の取得と確定オッズは
再取得しません。運営負荷を避け、定期実行は10分間隔を超えて頻繁に行わないでください。

GitHub Actions の `daily.yml` は日次収集・推論・差分同期・可能な場合の履歴
backfill と保存予測の feedback scoring を行います。`retrain.yml` は週次に
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

初回は Actions cache が空です。まず `ml/state/backfill_state.json` の `done` に
リポジトリへ投入済みの backfill 範囲（例: `2026-07-01` から前日までの日付）を
記録してコミットしてください。初回 daily 実行はこのファイルを
`ml/data/backfill_state.json` にコピーし、その後は cache で継続します。学習済み
モデルは `ml/artifacts/` の cache が空だと daily が明確なエラーで停止します。
初回は workflow_dispatch で `retrain.yml` を実行して cache を作成してください。

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

同期は venues → races → entries → results → payouts → odds → models → predictions → collection-runs の順で行い、各 POST は最大 500 行です。

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

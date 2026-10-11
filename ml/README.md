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

アーカイブexport APIのリリース後は、既存の `EDGELAB_API_URL` / `INGEST_TOKEN` で
1日ずつ取得・検証し、ローカルstoreへ追加できます。これは読み取り専用で、結果をD1へ同期しません。

```sh
EDGELAB_API_URL=https://example.invalid INGEST_TOKEN=... PYTHONPATH=ml ml/.venv/bin/python -m edgelab import-prerace-archives --date 2026-10-11
```

アーカイブ本文のSHA256、日付・レースID・公式URL・パーサーバージョン・完全な120通りを検証します。
beforeinfoは既存 `prerace_observations` 形式に保存します。取得済み時刻・利用可能時刻は原本の
capture時刻を保ち、確認済み締切の同値証跡は最も早い取得時刻を保持します。三連単オッズは
同期対象外のローカル専用 `prerace_capture_odds` に隔離し、オフラインリプレイだけで使います。
同じmanifestとchecksumは再取込せず、拒否した件数と理由を出力します。

ネットワーク収集は公式ボートレース日次 LZH のみを対象にします。取得済み
ファイルは `data/raw/boatrace` に保持し、再実行時は再取得しません。未開催日は
スキップ扱いです。番組表は前日利用可能、競走成績内の展示情報は締切 10 分前
利用可能として扱います。モデル成果物は `ml/artifacts/` に保存されます。

`train-trifecta` は保存済み実データだけで、完全な6艇K着順から pairwise ranking
候補を学習し、Plackett-Luce による厳密な三連単順序確率を時間順holdoutで採点します。
三つの単勝確率の積は使いません。holdout払戻リプレイは同一レースの締切10分前より
前に記録された公式・完全・非締切の三連単オッズ一式がある場合だけ実施し、不足時はROIを算出しません。
仮想リプレイは5本以上の独立fitによるticket確率標準偏差を要求し、運用と同じ期待ROI降順・
選択文字列昇順で同率順序を決めます。期待ROIと `(p - std) * odds - 1` の保守的ROIが
それぞれ5%以上で、標準偏差が5%以下の候補から最大6点を選び、整数円のレース予算を配分します。
既定は運用の初期設定と同じ1点・100円で、`train-trifecta --replay-max-picks 3 --replay-race-budget 300`
のように実際の設定に合わせられます。0点も許容し、リプレイ出力には
`trifecta-runtime-ev-multipick-v1` と閾値・点数・予算を記録します。
これは単一券種の過去リプレイであり、全券種をまたぐ運用方針の検証ではありません。候補学習はモデル行をローカルへ記録しますが、
推論・リモート同期はせず、昇格も自動化しません。過去のB公開時刻は
実測されておらず、保持された実績も将来利益を証明しません。
V2 training rows use the official betting cutoff minus 60 seconds as their feature as-of boundary;
T-30 observations are excluded. The standard weekly `learn` command still trains the separate
boat win candidate and does not invoke `train-trifecta`.

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

GitHub Actions の `daily.yml` は当日・前日の結果と払戻を優先し、出走表と確認済み
active `boat-prerace-v2` trifecta model の `ticket_predictions` を同期して、保存予測の
feedback scoring を行います。日次予測は実際のAction実行時刻を予測時刻として保存し、
T-60より先の観測を使いません。ActionがT-60より早い場合は、その実行時点で取得済みの
観測だけを使うため、後着の展示／気象情報は含まれません。締切、V2 active artifact、
または時点情報が確認できない場合は単勝へフォールバックせず `not_ready` / abstention
にします。過去履歴の
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
読み、三連単ticket semantics・V2 feature schema・artifact digestが合わない場合は推論だけを止めて結果収集/同期を続けます。`train-trifecta` は明示的な候補学習コマンドであり、週次workflowからは起動しません。候補を作ってもD1へ自動同期／昇格しません。
feedback artifactは各Actionの `learning-feedback-*` / `learning-report-*` として保存されます。
必要な Actions secrets:

- `EDGELAB_API_URL`: ingest API のベース URL
- `INGEST_TOKEN`: ingest API bearer token
- `CLOUDFLARE_API_TOKEN`: Wrangler D1 情報取得用 token
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account ID

###
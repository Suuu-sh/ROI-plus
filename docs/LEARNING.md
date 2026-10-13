# 自動フィードバックと候補学習

## 実行

- daily workflow は保存済みの予測と後日確定した実データを採点し、`ml/data/learning/report.json` を Actions artifact に保存する。
- weekly retrain workflow は `python -m edgelab learn` を実行する。新しい完了実レースが30件未満、全体で400完了レース未満、または複数日の時間順 holdout を作れない場合は学習をスキップする。初回は既存の学習履歴 state がないため、新規件数の基準は利用可能な全実データに適用する。
- 手元の JSON store のみでフィードバックを再計算するには `PYTHONPATH=ml python -m edgelab feedback` を実行する。このコマンドはネットワークに接続しない。書き出し先は `ml/data/learning/`（cache対象・gitignore対象）。

## フィードバック規則

- `data_origin=real` に限定し、実レースの出走艇・結果が一致し、全艇の結果と勝者1艇を確認できるレースだけを採点する。予測は全艇分がそろい、同一時刻で、締切時刻より前であることを要求する。特徴の `available_at` も予測時刻以前でなければならない。artifact metadata の `trainedAt` が予測時刻以前であり、対象レース日が `trainTo` / `validTo` の両方より後のときだけ out-of-sample 採点する。後から作られたartifactで過去予測を採点したり、fit/校正期間内の予測を実績に含めたりしない。
- Log Loss、Brier、ECE と校正情報・トップ予測の外れ頻度を報告する。単一の敗戦を「判断ミス」とはしない。報告は確率品質の傾向であり、自動で特徴量やモデルを変更しない。
- ROI評価は全艇の予測時点以前に記録された実単勝オッズがそろい、選択レースの実勝者への払戻記録も存在するときだけ行う。払戻や敗者オッズを推定しない。経験ROIとレース選択損益のbootstrap 95%区間を併記し、賭数30未満・区間なし・区間下限0以下は「未証明／positive evidenceなし」とする。予測勝率×オッズだけでは利益を主張しない。
- ROIは既存のEVしきい値を使った counterfactual replay で、実際の精算・実購入・auto-bet全条件（不確実性/レースごとの上限制御等）を再現するものではない。利益の本番検証とは呼ばない。
- フィードバック採点にはローカルartifact JSONの特徴列が安全と確認できることを要求する。artifactがない／旧列を持つ既存v1モデルの履歴は明示的に除外し、リーク可能性がある予測を良い実績として扱わない。

## 学習・昇格

- 学習行はボートの `real` データに限定。全出走艇の実結果と勝者1艇、利用可能時刻、完了レース状態を要求する。
- 週次 `learn` が作る単勝候補はBファイルの事前特徴量だけを使う。Kファイルの展示・ST・天候項目は単勝候補からマスクする。別コマンド `train-trifecta` は V2 schema の三連単候補を作るが、オフライン候補に留まり日次 workflow や週次 `learn` から自動起動しない。V2訓練の予測時点は確認済み `betting_cutoff_at - 60秒` で、同じ時点までに利用可能な展示・ST・気象観測と racer ID が結ばれた完全な過去結果だけを使う。T-30時点の観測は含めない。既存 v1 artifact はこれらの項目が混入した可能性があり、比較基準として信頼しない。新しい候補は日付と実レース集合の fingerprint を含む別ID/artifactに保存する。
- D1のモデル自然キーはIDだけでなく `(sport, bet_type, version)` にも一意制約がある。候補versionにも日付とfingerprintを含め、artifactと同期行で同じ値を使う。全候補を `v1` のまま送らない。
- 候補の fit/temperature validation は holdout より時間的に前でなければならない。候補と比較可能なローカル incumbent artifact が同一holdout以前の fit/validation で、かつ安全な特徴列だけを使う場合に限り、同一holdout上の比較を出す。比較不能なら理由を記録する。holdout は週次候補間で再利用されるため、これは運用上の候補比較であり、独立した最終的な性能証明ではない。
- 日次の三連単推論は認証付きレジストリで唯一の active trifecta モデルを確認し、`boat-prerace-v2` marker・三連単意味論・promotion evidence・artifact SHA256 が一致するときだけ `ticket_predictions` を作って同期する。日次collectorは公式beforeinfoページ内の明示的な `締切予定時刻` と複数の一致した race-identity tab link を照合し、取得時刻を `betting_cutoff_observed_at` として保存する。締切が曖昧／欠落／取得前に経過済み、または既存の確認済み締切と食い違う場合は更新しない。`prediction_as_of` は収集とレジストリ取得の後に記録し、その時点で取得済みの情報だけを使って締切証跡が `prediction_as_of` 以前で、かつT-60より前のレースだけを再判定する。後から観測を過去時点へ割り当てない。確認済み締切がない、active V2 modelがない、artifactが欠ける／不一致、または時点情報が不正な場合は単勝予測へフォールバックせず予測を棄権するが、結果の収集・同期・feedbackは継続する。週次 `learn` は引き続き単勝候補を作り、`train-trifecta` の実行・候補登録・昇格を自動化しない。昇格・rollback は既存の人手操作を使う。
- 比較できる incumbent がない／Log Loss と Brier がともに改善しない／ECEが悪化する場合でも学習artifactと評価レポートは残すが、D1に候補として同期する場合は `metrics_json.promotionEligible=false` と理由を付け、昇格API/UIで不許可とする。
- network-free `feedback` は遠隔レジストリのstatusを確認しないため、採点レポートはモデルが現在 active かどうかを主張しない。`learn` の比較では認証済みregistry snapshotのactive状態とローカルartifact両方を必要とする。

このサイクルは測定、レポート、候補作成までを自動化するもので、報告された誤差から自動で「自己修正」したり、本番モデルを自動昇格したりはしない。

## 実験三連単の継続学習（weather-missing）

- `.github/workflows/trifecta-experimental-pipeline.yml` は JST 09:50 / 13:20 / 23:50 に `learning_only` として動く。公式アーカイブ／結果ラベルの取り込み、既存の厳格なPIT証跡監査、学習・時間順レース日ブロックのshadow比較、候補artifact/report保存までを行い、レジストリ登録・予測・購入判断は行わない。手動 `train_and_forecast` と明示指定の `forecast_only` は別モードとして維持する。学習scheduleによる候補作成は既存の推論モデル切替を意味しない。
- 学習cohort fingerprintは、適格な全training feature/outcome行と、そのレースの保存済みレース・艇・観測・結果・払戻・オッズ証跡をcanonical JSON化してSHA-256化する。同じfingerprintのartifactがcacheにあれば再学習をスキップする。証跡または訂正済み結果が変われば別の不変ID/artifactとなり、古いartifactは上書きしない。
- Shadow評価は日付単位で最新側のdate blockをholdoutし、同日レースをtrain/testへ分割しない（cohortが十分な日数を持つ場合は複数日をholdout）。比較はtrain期間だけでfitした三連単モデルと、train期間だけの平滑化艇番順序基準の exact-order Log Loss / multiclass Brier / top-ticket ECEを記録する。holdoutが少数または日付幅が足りない場合は未評価／shadowの記述統計として明示する。最終artifactは全cohortでfitするため、shadow scoreはそのartifactの独立検証ではない。
- weather-missing実験schemaは既定のPIT条件（実データ、出典と到着時刻、確認済みT-60、6艇、展示6艇、120オッズ、公式結果・払戻の一致）を緩めない。少数データの候補はexperiment-onlyで保存できるが、`evaluationQualified`, `promotionEligible`, `profitabilityProven` はfalseのまま。成果改善・収益・購入稼働を主張せず、自動昇格もしない。
- 現時点でforecast送信403は未解決であり、この学習専用scheduleはそれを修復・回避しない。候補artifactが作成されても本番推論や仮想購入が稼働したことを意味しない。

## 初回ベースラインの検証・復元

- `validate-initial-baseline` workflow は既存 candidate の JSON/pickle と、その作成時点のデータ cache を読み、再学習・データ収集なしで評価する。cache key は必ず完全一致で指定し、cache がなければ最新 cache へフォールバックせず失敗する。標準対象は `boat-win-lgbm-20261010-ee79bc87` と `daily-Linux-2026-10-10-38042505956`。
- 評価閾値は `initial-baseline-v1` に固定し、holdout 実レース400件以上・7日以上、分離された時間順 train/validation/holdout、safe feature schema、正常な確率、候補の保存済みproper score再現、ECE 0.05以下、Log Loss/Brier双方のlane基準比race-bootstrapとdate-cluster bootstrap 95%上限が0未満、週単位の大幅な逆転なしを要求する。閾値は結果を見て緩めない。lane基準率はtrain期間のみで推定する。
- これは保存済み予測のOOSスコアではなく、固定済みartifactを過去holdoutに再適用する「retrospective temporal replay」。過去時点のsource到着時刻も記録されていないため、Bファイルの時刻は `assumed_from_B_prerace_content_not_recorded` として扱う。適格でも初期の仮想ベースライン候補を判断する材料であり、完全なpoint-in-time証明や実運用性能の保証ではない。履歴特徴は未使用。既知の漏洩経路を持つ旧v1との比較は適格性評価に使わない。
- Profitability欄は実際に記録された全艇分の締切前オッズと実勝者の払戻がそろう場合だけcounterfactual replayとして算出する。予測確率とオッズから利益を推定せず、実購入ROIや現行自動購入ルールの再現と呼ばない。証拠不足は明示的に `counterfactual_replay_unproven` とする。
- オプション `sync_validation` は認証済みモデルレジストリを読み、検証済みcandidateのmetricsだけを更新する。JSON/pickle artifact本体は変更しない。`promotionEligible=false` はそのまま維持し、通常昇格とは別の `initialBaselineEligible` evidenceを記録するだけで、昇格は明示的な人手承認が必要。
- workflow は検証レポートと同一のJSON/pickle candidate artifact bundleを90日間保存する。承認後にActions cacheが失効している場合は、Daily workflowを手動実行し `validated_model_run_id` に検証workflowのrun IDを指定して正確なartifact pairを復元する。日次推論はregistryに登録されたsafe schema markerとpickle SHAが一致しない限りfail closedし、候補や旧artifactへ自動フォールバックしない。artifact retention/cacheともに失効した場合は再検証可能な正確なartifact pairを再取得するまで推論を再開しない。
- Daily は当日と前日のKファイルを毎回強制再取得する。Kは開催中に更新され得るため、通常のB・過去日のキャッシュ方針は変えず、更新されたKが有効なLZHかつ同日レース結果としてparseできた場合だけatomic replaceする。404、取得/parse失敗、要求budget不足は古いraw cacheと正規化済み行を保持し、collection runを `partial` / `failed` として記録する。強制再取得もネットワーク要求budgetに計上する。

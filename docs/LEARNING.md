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
- ボートは B ファイルの事前特徴量だけを新規モデルに使う。Kファイルの展示・ST・天候項目は締切前に使える根拠が不足するためマスクする。既存 v1 artifact はこれらの項目が混入した可能性があり、比較基準として信頼しない。新しい候補は日付と実レース集合の fingerprint を含む別ID/artifactに保存する。
- D1のモデル自然キーはIDだけでなく `(sport, bet_type, version)` にも一意制約がある。候補versionにも日付とfingerprintを含め、artifactと同期行で同じ値を使う。全候補を `v1` のまま送らない。
- 候補の fit/temperature validation は holdout より時間的に前でなければならない。候補と比較可能なローカル incumbent artifact が同一holdout以前の fit/validation で、かつ安全な特徴列だけを使う場合に限り、同一holdout上の比較を出す。比較不能なら理由を記録する。holdout は週次候補間で再利用されるため、これは運用上の候補比較であり、独立した最終的な性能証明ではない。
- `daily` / `learn` は認証付き読み取り専用モデルレジストリで active ID を確認する。`learn` の比較対象はレジストリで active と確認でき、適合するローカルartifactがあるモデルだけ。レジストリまたは推論用active artifactを確認できないときdaily予測はfail closedだが、結果の収集・同期・feedbackは継続する。候補作成・比較・Actionsのいずれも昇格しない。昇格・rollback は既存の人手操作を使う。
- 比較できる incumbent がない／Log Loss と Brier がともに改善しない／ECEが悪化する場合でも学習artifactと評価レポートは残すが、D1に候補として同期する場合は `metrics_json.promotionEligible=false` と理由を付け、昇格API/UIで不許可とする。
- network-free `feedback` は遠隔レジストリのstatusを確認しないため、採点レポートはモデルが現在 active かどうかを主張しない。`learn` の比較では認証済みregistry snapshotのactive状態とローカルartifact両方を必要とする。

このサイクルは測定、レポート、候補作成までを自動化するもので、報告された誤差から自動で「自己修正」したり、本番モデルを自動昇格したりはしない。

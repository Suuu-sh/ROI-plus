# 三連単の校正候補（ローカル隔離評価）

## 確認できたこと

- 現行実験学習コードは pairwise logistic の艇スコアを Plackett–Luce 分布へ変換する。全着順から作る30の対比較行は30独立レースではない。
- 実験学習は temperature=1、校正なし、validation/testなしで全対象をfitする。親による静的モデル照合でも現行公開IDと一致する5 fit・temperature=1を確認済み。過信の原因がこれだけだとは確定していない。
- ensemble の標準偏差は5 fit間のばらつきのみ。モデル構造に共通するバイアスや校正誤差を含まない。
- 通常 `train_trifecta` の既存temperature探索はprimary fitだけを評価し、その温度をensemble全体へ適用する。校正対象と最終分布が異なる点を候補経路で解消した。通常経路そのものは変更しない。

## 変更と検証範囲

`ml/edgelab/models/trifecta_calibration_candidate.py` は明示opt-inのオフラインreport専用エントリポイント。厳格な既存の出典・T-60・結果検証を維持し、日付全体を60/20/20でtrain/calibration/testに分離する。最低300/100/100レース・各2日を固定研究条件とする。これは統計的検出力や収益保証ではない。

trainだけで5 fitを作り、同じensembleのtemperatureをcalibrationだけで選ぶ。固定探索は1を含む鋭化・平滑化の両方向。testは最後に未校正ensembleと同じレースで比較し、Log Loss/Brierの改善・top-ticket ECE非悪化を記述的ゲートとする。低確率ビンは未校正p<=1%の同じticket集合で比較する。オッズで選んだ長穴群ではなく、ticket行は独立標本ではない。

モデルartifact・registry・稼働推論・昇格・購入判断は変更しない。ゲートを通過しても`promotionEligible=false`。候補が鋭化を選ぶ、または長穴過大評価が改善することは未実証。

## 実データでの実行結果

同日のJSON reportを参照。既存ローカルML storeのreal race行は15,588だが、必須の検証済み結果ラベルを持つrace IDが0だった。したがって厳格適格cohortの上限は0であり、候補結果は`insufficient_data`。全特徴量構築と全coverage走査は、この上限証明後に打ち切った。空の適格cohortをminimal projectionで評価し、source全体のcoverageを0だとは主張しない。storeのSHA256をreportへ記録した。

これはローカルstoreだけの証拠で、本番D1の欠損・全実データ不足を意味しない。production評価ticketでfitしていない。実データのheld-out改善、長穴抑制、収益性は未確認。

## 確認

専用pytest 5件成功：opt-in、fit前の不足停止、日付分離、trainだけの5 fit、test前のensemble校正、CLI report、120組の正規化を検証。合成テストのスコアは実データの性能根拠に使わない。

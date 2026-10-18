# Oct18 frozen residual comparison: official-result recovery

Research-only follow-up; original input, original 27-label comparison and original as-of remain unchanged. New evaluation as-of: **2026-10-18T18:43:58.749Z** (Oct19 JST). Detailed evidence: `market-residual-recovered-comparison-2026-10-19.json`.

## Recovery and evidence

- Attempted all 98 missing eligible race results with serial official `raceresult` GETs, minimum 3.1 seconds between request starts; all returned HTTP 200. No retry requests were needed. Actual fetch-completion times—not race-end estimates—are recorded as result availability.
- **94 recovered + 27 original verified = 121 / 125 labeled races**, 4 remain unknown. Recovery includes 89 six-finisher outcomes and 5 parser-supported capsize outcomes with explicit empty-refund evidence and actual numeric top3/payout. No synthetic lower finishing ranks were created.
- Unknown: `boat-20261018-02-11` and `boat-20261018-16-06` have explicit F/refunds; `boat-20261018-16-11` has unsupported エ/妨; `boat-20261018-23-11` has unsupported 落/妨 alongside 転. Existing parser support was not broadened. No losses/wins were synthesized for these races.
- Existing strict official parser checked URL and page date/venue/race identity, prerecord archived lane/racer registration roster, finish/payout consistency, and refund state. Offline evaluation independently reparsed saved HTML and SHA256 a second time.
- Fresh labels are explicitly `research-recovered-official-html-v1`, **not persisted collector `verified-official-outcome-v2` proofs**. The wrapper maps independently validated evidence to the existing offline evaluator's outcome contract only in memory. HTML and per-race metadata are locally ignored; the report records official source URLs, byte SHA256, fetched/recovered times, roster-source hashes and terminal codes.

## Same frozen comparison

Frozen candidate SHA256: `0a875cbfb51030ccf6fb2010f13cd3b7b58602b9170b1c84e1338c8d2370c0b5`.

Candidate artifact/implementation and all non-outcome race inputs (predictions, uncertainty, decision odds, cutoff proofs and decisions) are hash-checked unchanged. No fitting, retuning, registry write or promotion occurred. Same p≥0.1, odds≤50, monthly gross-stake cap ¥10,000, per-race cap ¥1,000, no payout recycling.

| Arm | Verified races | Mean NLL ↓ | Multiclass Brier ↓ | Selected races | Stake | Realized simulated profit | Unresolved stake |
|---|---:|---:|---:|---:|---:|---:|---:|
| Saved current | 121 | 5.197889 | 1.017227 | 8 | ¥5,800 | −¥5,800 | ¥0 |
| Frozen residual | 121 | 3.765275 | 0.956421 | 0 | ¥0 | ¥0 | ¥0 |
| Decision-odds market | 121 | 3.745123 | 0.955332 | 0 | ¥0 | ¥0 | ¥0 |

Market remains slightly better than residual on both proper scores. Residual improves over saved current probability scores but does not beat the market baseline. Zero stakes/profit is abstention, not demonstrated profitable operation.

The only selected previously unknown race was current-arm `boat-20261018-23-05`: its ¥200 selection `2-1-3` is now an official loss. Current unresolved stake falls from ¥200 to zero; simulated profit changes from −¥5,600 to −¥5,800. The other seven current selected races were already labeled. All four remaining unknown races were unselected by all three arms.

## Cause and limitations

See `official-result-missing-diagnosis-2026-10-19.md`: 89 original `source-state-changed` failures match archive-only race selection versus a narrower write-authorization guard, not demonstrated concurrent source mutation. Fresh official HTML demonstrates availability now, not availability at original failure time. All 94 recovered numeric result arrays and trifecta payouts exactly match the original saved D1 export; zero such mismatches in that subset. This does not establish persisted proof validity or resolve the 4 excluded outcomes. Recovery did not persist results to production or fix its collector.

One retrospective day, 4 unsupported outcomes, no full observed month and no prospective/independent validation. This is not profit, deployment or promotion evidence. Production was not stopped; no D1, deploy, setting, model or registry changes.

## Focused checks

- Six focused provenance/terminal/refund and frozen retrospective tests passed across two test files.
- Recovery/evaluator scripts syntax and focused TypeScript compilation passed.
- Actual 98-page recovery and frozen 121-label replay completed; artifact and non-outcome input hashes match.

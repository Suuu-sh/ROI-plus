# Archive-only result collection: live verification (2026-10-19 JST)

## Scope and method
- API deployment: commit `a972193`, completed 2026-10-18T19:03:49.312Z (2026-10-19 04:03:49 JST), version `05351824-aede-4838-babd-2e86cf4167d5` (deployment evidence supplied by parent).
- Observed natural ten-minute scheduled collection only. No manual collector/admin endpoint, remote SQL mutation, model promotion, or settings change was used for verification.
- Cloudflare D1 read-only SELECT queries returned `rows_written: 0`. Internal account/database routing identifiers are intentionally excluded.
- Source: `collection_runs.source=boatrace-results-worker-v1`, official boatrace.jp result URLs, joined against real D1 results/payouts and all three bet ledgers.

## Before deployment: fixed representative baseline
All three races had a failed `source-state-changed` proof, six real result rows and eight real payout rows already present, zero bets in normal/experimental/historical ledgers, two immutable prereace archives, and no quarantine. They were already `finished`, updated at 2026-10-18T14:31:01.171Z.

| Fixed race | Failed proof finished_at (UTC) |
|---|---|
| boat-20261018-19-01 | 2026-10-18T18:41:46.315Z |
| boat-20261018-20-07 | 2026-10-18T18:41:49.883Z |
| boat-20261018-19-02 | 2026-10-18T18:41:53.492Z |

The observed aggregate number of current `source-state-changed` proofs was 189, not the earlier diagnostic snapshot of 89. These fixed races had not yet been selected after deployment at the first observation; this report does **not** claim their failed proofs were repaired.

## After deployment: actual automatic unpurchased successes
The 19:10 UTC natural tick started at 19:10:56Z and produced four verified successes on purchased historical targets, plus nine rejected targets. The following 19:20 UTC natural tick reached archive-only races. The following three races had zero rows in **each** of `bets`, `experimental_paper_bets`, and `historical_trifecta_experiment_bets`; each had two prereace archive rows and no quarantine.

| Race | started_at (UTC) | finished_at / fetchedAt (UTC) | Outcome |
|---|---|---|---|
| boat-20261017-02-07 | 2026-10-18T19:20:57.197Z | 2026-10-18T19:21:34.769Z | success |
| boat-20261017-04-08 | 2026-10-18T19:20:57.199Z | 2026-10-18T19:21:45.010Z | success |
| boat-20261017-02-08 | 2026-10-18T19:20:57.200Z | 2026-10-18T19:21:48.719Z | success |

All proofs have `quality=verified-official-outcome-v2`, six numeric finish results, two collector-supported payouts (win/trifecta), `refundTablePresent=true`, and no non-refundable terminal numbers. All six proof result items and both proof payout items match D1 exactly for each race. D1 retains eight total real payout rows per race; the six other payout types were not replaced or newly verified by this two-market collector proof.

| Race | Official result URL | SHA-256 | Finish order | Win / trifecta payout (JPY per 100 JPY) |
|---|---|---|---|---|
| boat-20261017-02-07 | https://www.boatrace.jp/owpc/pc/race/raceresult?rno=7&jcd=02&hd=20261017 | 53d330b20f947ce3c218e4e80babe850359ac7ab3106064a2f0cb2b045e842cc | 4,5,1,3,2,6 | 4: 660 / 4-5-1: 4040 |
| boat-20261017-04-08 | https://www.boatrace.jp/owpc/pc/race/raceresult?rno=8&jcd=04&hd=20261017 | 81f3666fdb1f415f7ada51131518b8c5d207d096d4f7bd41ee7abd4e09ca06ee | 5,2,3,1,6,4 | 5: 900 / 5-2-3: 21360 |
| boat-20261017-02-08 | https://www.boatrace.jp/owpc/pc/race/raceresult?rno=8&jcd=02&hd=20261017 | e2cb796cfa154802fe076c36954b3872ec39ddeb14439f0a6f9102b9068703c1 | 2,1,3,4,5,6 | 2: 440 / 2-1-3: 1970 |

Race `updated_at` equals the corresponding fresh successful proof time. With no bets, no manual call, and archive-only scheduled selection requiring the canonical complete R2 target list plus official cutoff provenance, these are actual production automatic saves independent of purchase presence. These three were not the fixed predeployment examples; their prior proof/data state was not captured, so this is not a claimed zero-to-six insertion or failed-to-success transition for those exact races.

## Limits
- The production automatic path is proven for these three unpurchased races, not every archive or backlog item.
- Fixed Oct18 baseline examples remain unconfirmed pending later bounded selection. Purchase priority and request/write budgets remain in effect.
- Invalid/unsupported official pages remain rejected; no safety gate was bypassed.
- No model promotion was performed. Deployment retained variables; parent separately verified active version and health. This verification did not independently snapshot the model identity.


## Parent release checks
- Collector tests: 58 passed; shared/API typecheck, API bundle dry-run and diff check passed.
- Read-only migration readiness: ready, no missing/unexpected migrations.
- API version above serves 100% of traffic; public health remains OK.
- Experimental model remains `boat-trifecta-exp-noweather-20261013-10559e2c79ce`, artifact SHA `386ff046f73d0f604a293d2c7318acc794857d9448f1addaf3f164863a91bdda`, state `ready`. No registry or promotion operation.
- API-only direct Wrangler deployment preserved variables; no learner/Web deployment. Source/evidence push skips duplicate full-stack CI deployment because the scoped API release and live verification are already complete.

import { describe, expect, it } from 'vitest'
import { buildExperimentalStakeComparison, type ExperimentalStakeComparisonRow as Row } from '../src/services/experimentalStakeComparison.js'

const ticket = (overrides: Partial<Row> = {}): Row => ({ raceId: 'race-1', stake: 100, status: 'lost', payout: 0, reconciled: false, ...overrides })

describe('buildExperimentalStakeComparison', () => {
  it('scales official settled winning payout to ¥100 tickets and compares same settled cohort', () => {
    const result = buildExperimentalStakeComparison([
      ticket({ stake: 200, status: 'won', payout: 800 }),
      ticket({ stake: 100, status: 'lost', payout: 0 }),
    ])
    expect(result).toMatchObject({
      actual: { tickets: 2, stake: 300, payout: 800, profit: 500, roi: 800 / 300 },
      fixed100: { tickets: 2, stake: 200, payout: 400, profit: 200, roi: 2 },
      settledRaceCount: 1, pendingRaceCount: 0, excludedRaceCount: 0,
    })
  })

  it('excludes the whole race when any ticket is pending, void, or reconciled', () => {
    expect(buildExperimentalStakeComparison([ticket({ status: 'won', payout: 100 }), ticket({ status: 'open', payout: null })]))
      .toMatchObject({ actual: { tickets: 0 }, fixed100: { tickets: 0 }, pendingRaceCount: 1, settledRaceCount: 0 })
    expect(buildExperimentalStakeComparison([ticket({ status: 'won', payout: 100 }), ticket({ status: 'void', payout: 0 })]))
      .toMatchObject({ excludedRaceCount: 1, settledRaceCount: 0 })
    expect(buildExperimentalStakeComparison([ticket({ status: 'won', payout: 100, reconciled: true })]))
      .toMatchObject({ excludedRaceCount: 1, settledRaceCount: 0 })
  })

  it('excludes invalid stake units and non-integral, missing, or zero winning payouts', () => {
    for (const bad of [
      ticket({ stake: 150 }), ticket({ stake: 0 }), ticket({ stake: 200, status: 'won', payout: 101 }),
      ticket({ status: 'won', payout: 0 }), ticket({ status: 'won', payout: null }), ticket({ status: 'lost', payout: null }),
    ]) expect(buildExperimentalStakeComparison([bad]).excludedRaceCount).toBe(1)
  })

  it('enforces the ten-ticket and ¥1,000 per-race limits, grouping by race id', () => {
    // Ten tickets in one race at the maximum combined spend remain eligible.
    expect(buildExperimentalStakeComparison(Array.from({ length: 10 }, () => ticket())).settledRaceCount).toBe(1)
    expect(buildExperimentalStakeComparison([...Array.from({ length: 10 }, () => ticket()), ticket()]).excludedRaceCount).toBe(1)
    expect(buildExperimentalStakeComparison([ticket({ stake: 1000 }), ticket({ stake: 1000 })]).excludedRaceCount).toBe(1)
  })
})

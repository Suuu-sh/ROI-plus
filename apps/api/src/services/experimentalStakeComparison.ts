export interface ExperimentalStakeComparisonRow {
  raceId: string
  stake: number
  status: string
  payout: number | null
  reconciled: boolean
}

export interface StakeComparisonTotals {
  tickets: number
  stake: number
  payout: number
  profit: number
  roi: number | null
}

export interface ExperimentalStakeComparison {
  actual: StakeComparisonTotals
  fixed100: StakeComparisonTotals
  settledRaceCount: number
  pendingRaceCount: number
  excludedRaceCount: number
}

const emptyTotals = (): StakeComparisonTotals => ({ tickets: 0, stake: 0, payout: 0, profit: 0, roi: null })

export function buildExperimentalStakeComparison(rows: ExperimentalStakeComparisonRow[]): ExperimentalStakeComparison {
  const result: ExperimentalStakeComparison = {
    actual: emptyTotals(), fixed100: emptyTotals(), settledRaceCount: 0, pendingRaceCount: 0, excludedRaceCount: 0,
  }
  const races = new Map<string, ExperimentalStakeComparisonRow[]>()
  for (const row of rows) {
    const group = races.get(row.raceId)
    if (group) group.push(row)
    else races.set(row.raceId, [row])
  }

  for (const tickets of races.values()) {
    if (!tickets.length || tickets.some(ticket => ticket.reconciled || !['won', 'lost'].includes(ticket.status))) {
      if (tickets.some(ticket => ticket.reconciled || ticket.status === 'void' || !['open', 'won', 'lost'].includes(ticket.status))) {
        result.excludedRaceCount++
      } else {
        result.pendingRaceCount++
      }
      continue
    }
    const actualStake = tickets.reduce((sum, ticket) => sum + ticket.stake, 0)
    const valid = tickets.length <= 10 && actualStake > 0 && actualStake <= 1000
      && Number.isSafeInteger(actualStake)
      && tickets.every(ticket => Number.isSafeInteger(ticket.stake) && ticket.stake > 0 && ticket.stake % 100 === 0
        && ticket.payout !== null && Number.isSafeInteger(ticket.payout) && ticket.payout >= 0
        && (ticket.status !== 'won' || (ticket.payout > 0 && ticket.payout % (ticket.stake / 100) === 0))
        && (ticket.status !== 'lost' || ticket.payout === 0))
    if (!valid) {
      result.excludedRaceCount++
      continue
    }

    const actualPayout = tickets.reduce((sum, ticket) => sum + ticket.payout!, 0)
    const fixedPayout = tickets.reduce((sum, ticket) => sum + (ticket.status === 'won' ? ticket.payout! / (ticket.stake / 100) : 0), 0)
    const fixedStake = tickets.length * 100
    if (![actualPayout, fixedPayout, actualPayout - actualStake, fixedPayout - fixedStake].every(Number.isSafeInteger)) {
      result.excludedRaceCount++
      continue
    }
    const next = [
      result.actual.tickets + tickets.length, result.actual.stake + actualStake, result.actual.payout + actualPayout,
      result.fixed100.tickets + tickets.length, result.fixed100.stake + fixedStake, result.fixed100.payout + fixedPayout,
    ]
    if (!next.every(Number.isSafeInteger)) {
      result.excludedRaceCount++
      continue
    }
    result.settledRaceCount++
    result.actual.tickets += tickets.length
    result.actual.stake += actualStake
    result.actual.payout += actualPayout
    result.fixed100.tickets += tickets.length
    result.fixed100.stake += fixedStake
    result.fixed100.payout += fixedPayout
  }

  for (const totals of [result.actual, result.fixed100]) {
    totals.profit = totals.payout - totals.stake
    totals.roi = totals.stake ? totals.payout / totals.stake : null
  }
  return result
}

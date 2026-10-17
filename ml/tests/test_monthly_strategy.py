from edgelab.calibration.monthly_strategy import replay, evaluate


def ticket(i=0, **updates):
    return dict(id=str(i), raceId=f'r{i}', recordKind='experimental_paper', betType='trifecta',
                dataOrigin='real', selection='1-2-3', officialSelection='1-2-4', status='lost',
                predictedProb=.2, oddsAtBet=10, expectedRoi=.1, stake=100, payout=0,
                placedAt='2026-10-01T10:00:00+09:00', settledAt='2026-10-01T11:00:00+09:00',
                **updates)


def month(rows, p=None, odds=None):
    return replay(rows, p, odds)['months']['2026-10']


def test_gross_budget_includes_open_and_never_recycles_winnings():
    rows = [ticket(i) for i in range(110)]
    rows[0].update(status='won', officialSelection='1-2-3', payout=10000)
    rows[1].update(status='open', officialSelection=None, payout=None, settledAt=None)
    m = month(rows)
    assert m['grossStake'] == 10000
    assert m['tickets'] == 100
    assert m['budgetRejectedTickets'] == 10
    assert m['unresolvedStake'] == 100
    assert m['worstCaseProfit'] >= -10000


def test_missing_settlement_time_keeps_risk_reserved():
    row = ticket()
    row['settledAt'] = None
    m = month([row])
    assert m['settledTickets'] == 0
    assert m['unresolvedStake'] == 100
    assert m['realizedProfit'] == 0


def test_void_reserves_at_purchase_then_refund_is_zero_profit():
    row = ticket()
    row.update(status='void', payout=100)
    m = month([row])
    assert m['grossStake'] == 100
    assert m['realizedProfit'] == 0
    assert m['unresolvedStake'] == 0


def test_thresholds_and_unguaranteed_probability():
    row = ticket()
    assert month([row], .2, 20)['tickets'] == 1
    row['expectedRoi'] = None
    assert month([row], .2, 20)['tickets'] == 0
    out = evaluate([row])
    assert out['candidateOnly'] is True
    assert out['registered'] is False
    assert out['promoted'] is False
    assert out['promotionEligible'] is False
    assert out['winner'] is None
    assert out['monthlyPositiveProfitFrequency'] is None
    assert out['probabilityStatus'] == 'UNCALIBRATED'


def test_bad_result_not_removed_from_entry_risk():
    row = ticket()
    row['officialSelection'] = row['selection']
    m = month([row])
    assert m['grossStake'] == m['unresolvedStake'] == 100


def test_cross_month_open_exposure_is_not_reset():
    rows = [ticket(i) for i in range(100)]
    for row in rows:
        row.update(status='open', settledAt=None, payout=None, officialSelection=None)
    for i in range(100, 110):
        row = ticket(i)
        row.update(placedAt='2026-11-01T10:00:00+09:00', settledAt='2026-11-01T11:00:00+09:00')
        rows.append(row)
    result = replay(rows, None, None)['months']['2026-11']
    assert result['carriedMonthStartExposure'] == 10000
    assert result['tickets'] == 0


def test_future_settlement_is_not_credited():
    from edgelab.calibration.monthly_strategy import timestamp
    out = replay([ticket()], None, None, timestamp('2026-10-01T10:30:00+09:00'))
    assert out['months']['2026-10']['unresolvedStake'] == 100
    assert out['settlementCalendarMonths'] == {}


def test_repaired_void_is_unresolved_without_independent_refund_proof():
    row = ticket()
    row.update(status='void', payout=100, repairReason='repair')
    m = month([row])
    assert m['grossStake'] == m['unresolvedStake'] == 100
    assert m['settledTickets'] == 0


def test_unknown_status_fails_closed_without_crash():
    row = ticket()
    del row['status']
    m = month([row])
    assert m['unresolvedStake'] == 100

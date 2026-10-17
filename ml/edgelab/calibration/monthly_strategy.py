"""Offline fixed-grid exploratory candidate replay of saved placed tickets, never forecasts.

Gross monthly stakes, including unsettled exposure, are capped at JPY 10,000.
No proceeds are recycled. This stricter proxy needs no inferred settlement time.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime
import hashlib
import json
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from .experimental import _finite, _valid_selection, audit

STAKE = 100
MONTH_CAP = 10000
RACE_CAP = 1000
GRID = [(None, None)] + [(p, o) for p in (.05, .10, .20) for o in (20, 50)]


def timestamp(value: Any) -> datetime | None:
    try:
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return dt.astimezone(ZoneInfo('Asia/Tokyo')) if dt.tzinfo else None
    except (AttributeError, TypeError, ValueError):
        return None


def replay(rows: list[dict[str, Any]], min_probability: float | None, odds_cap: float | None, observed_at: datetime | None = None) -> dict:
    groups: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        if isinstance(row, dict) and isinstance(row.get('raceId'), str):
            groups[row['raceId']].append(row)
    months: dict[str, dict] = {}
    rejected = defaultdict(int)
    ordered = []
    accepted_exposures = []
    lifetime_spend = 0
    settlement_months = defaultdict(lambda: {'profit': 0, 'settledTickets': 0})
    for race, tickets in groups.items():
        times = [timestamp(t.get('placedAt')) for t in tickets]
        if any(t is None for t in times) or len(set(times)) != 1:
            rejected['race_missing_or_inconsistent_purchase_time'] += 1
            continue
        ordered.append((times[0], race, tickets))
    for placed, race, tickets in sorted(ordered):
        if observed_at is not None and placed > observed_at:
            continue
        month = placed.strftime('%Y-%m')
        m = months.setdefault(month, {'tickets': 0, 'races': 0, 'grossStake': 0,
                                     'settledTickets': 0, 'voidTickets': 0, 'hits': 0, 'realizedProfit': 0,
                                     'unresolvedStake': 0, 'events': [], 'budgetRejectedTickets': 0,
                                     'carriedMonthStartExposure': sum(STAKE for bought, closed in accepted_exposures
                                         if bought.strftime('%Y-%m') != month and (closed is None or closed >= placed.replace(day=1, hour=0, minute=0, second=0, microsecond=0)))})
        # Entry validation uses only purchase-time data. Bad results cannot remove risk.
        if (len({t.get('selection') for t in tickets}) != len(tickets)
                or any(not _finite(t.get('predictedProb')) or not 0 <= t['predictedProb'] <= 1 for t in tickets)
                or sum(t['predictedProb'] for t in tickets) > 1 + 1e-9):
            rejected['invalid_entry_race'] += 1
            continue
        settled = [t for t in tickets if t.get('status') in ('won', 'lost')]
        valid_result = not settled or audit(settled, bootstrap_samples=0)['n'] == len(settled)
        race_settled_times = [timestamp(t.get('settledAt')) for t in tickets]
        full_settled = (valid_result and all(t.get('status') in ('won', 'lost', 'void') for t in tickets)
                        and all(t is not None and t >= placed and (observed_at is None or t <= observed_at) for t in race_settled_times))
        full_settled = full_settled and not any(t.get('repairReason') for t in tickets) and all(
            _finite(t.get('stake')) and t['stake'] >= 100 and t['stake'] % 100 == 0
            and _finite(t.get('payout')) and t['payout'] >= 0
            and (t['payout'] * 100 / t['stake']).is_integer()
            and ((t.get('status') == 'void' and t['payout'] == t['stake'])
                 or (t.get('status') == 'lost' and t['payout'] == 0)
                 or (t.get('status') == 'won' and t['payout'] > 0)) for t in tickets)
        selected = []
        for t in sorted(tickets, key=lambda t: t.get('selection', '')):
            if (t.get('dataOrigin') != 'real' or t.get('recordKind') != 'experimental_paper'
                    or t.get('betType') != 'trifecta' or not _valid_selection(t.get('selection'))
                    or not _finite(t.get('oddsAtBet')) or t['oddsAtBet'] <= 1):
                rejected['noneligible_entry_ticket'] += 1
                continue
            # Snapshot expectedRoi is the production 1.96-sigma conservative ROI,
            # not proof that the raw probability or this uncertainty is calibrated.
            if min_probability is not None and (t['predictedProb'] < min_probability
                    or t['oddsAtBet'] > odds_cap or not _finite(t.get('expectedRoi'))
                    or t['expectedRoi'] <= 0):
                continue
            if len(selected) >= RACE_CAP // STAKE:
                rejected['race_cap_ticket'] += 1
                continue
            if m['grossStake'] + m['carriedMonthStartExposure'] + STAKE > MONTH_CAP or lifetime_spend + STAKE > 100000:
                m['budgetRejectedTickets'] += 1
                continue
            selected.append(t)
            m['grossStake'] += STAKE
            m['tickets'] += 1
            lifetime_spend += STAKE
            accepted_exposures.append((placed, max(race_settled_times) if full_settled else None))
        if selected:
            m['races'] += 1
        for t in selected:
            source_stake, payout = t.get('stake'), t.get('payout')
            # Use official recorded return scaled linearly; never substitute oddsAtBet.
            scalable = (_finite(source_stake) and source_stake >= 100 and source_stake % 100 == 0
                        and _finite(payout) and payout >= 0 and (payout * 100 / source_stake).is_integer()
                        and ((t.get('status') == 'void' and payout == source_stake) or (t.get('status') == 'lost' and payout == 0) or (t.get('status') == 'won' and payout > 0)))
            if full_settled and scalable:
                profit = payout * STAKE / source_stake - STAKE
                m['settledTickets'] += 1
                m['hits'] += t.get('status') == 'won'
                m['voidTickets'] += t.get('status') == 'void'
                settlement_months[max(race_settled_times).strftime('%Y-%m')]['profit'] += profit
                settlement_months[max(race_settled_times).strftime('%Y-%m')]['settledTickets'] += 1
                m['realizedProfit'] += profit
                m['events'].append((max(race_settled_times), race, profit))
            else:
                m['unresolvedStake'] += STAKE
    for m in months.values():
        events = defaultdict(float)
        for time, race, profit in m.pop('events'):
            events[(time, race)] += profit
        net = peak = drawdown = max_loss = 0
        for _, profit in sorted(events.items()):
            net += profit
            peak = max(peak, net)
            drawdown = max(drawdown, peak-net)
            max_loss = max(max_loss, -net)
        m.update(maxRealizedNetLoss=max_loss, maxSettlementDrawdown=drawdown,
                 worstCaseProfit=m['realizedProfit']-m['unresolvedStake'],
                 hitRate=m['hits']/(m['settledTickets']-m['voidTickets']) if m['settledTickets'] > m['voidTickets'] else None,
                 monthlyObservation='partial_not_monthly_evidence')
    return {'minRawProbability': min_probability, 'maxOdds': odds_cap,
            'conservativePositiveRoiGate': min_probability is not None,
            'months': months, 'settlementCalendarMonths': dict(settlement_months), 'rejected': dict(rejected)}


def evaluate(rows: list[dict], observed_at: datetime | None = None) -> dict:
    # With no cutoff this API is exploratory only; the evidence-producing CLI requires one.
    dates = sorted({t['raceDate'] for t in rows if isinstance(t, dict) and isinstance(t.get('raceDate'), str)})
    return {'status': 'insufficient_data', 'candidateOnly': True, 'registered': False,
            'promoted': False, 'promotionEligible': False, 'probabilityStatus': 'UNCALIBRATED',
            'cutoffEvidence': 'explicit_observed_at' if observed_at else 'exploratory_no_cutoff_not_temporal_evidence',
            'objective': 'monthly positive-profit frequency subject to JPY 10000 loss tolerance',
            'fullyObservedMonths': 0, 'monthlyPositiveProfitFrequency': None,
            'winner': None, 'observedRaceDates': dates,
            'policy': {'stake': STAKE, 'perRaceCap': RACE_CAP, 'monthlyGrossStakeCap': MONTH_CAP, 'initialBankroll': 100000,
                       'monthBoundary': 'prior-month open exposure at month start permanently consumes this month allowance; no release or winnings recycling',
                       'profitAttribution': 'purchase-month cohort; not settlement-calendar profit',
                       'riskPolicy': 'no_recycling_gross_stake_proxy; unresolved stakes remain reserved',
                       'tieBreak': 'purchase timestamp, race ID, selection lexicographic',
                       'holdoutBoundary': '2026-11-01T00:00:00+09:00',
                       'selectionGate': 'no winner before at least 3 future fully observed complete calendar months'},
            'candidates': [replay(rows, p, o, observed_at) for p, o in GRID],
            'limitations': ['Placed-ticket selection bias; not all 120 combinations.',
                            'API snapshot may be capped; no completeness proof, including calendar months.',
                            'Historical partial subset is exploratory, not threshold fitting or holdout evidence.',
                            'No monthly extrapolation, Monte Carlo evidence, or production changes.',
                            'Void tickets reserve budget at purchase; only explicit full refund settles at zero profit. Missing opportunities not simulated.',
                            'Gross budget is stricter than net-loss budget; winnings never replenish allowance.',
                            'Settlements credited at whole-race latest explicit settledAt only; otherwise unresolved.',
                            'Settlement drawdown excludes open risk; worstCaseProfit separately includes it.']}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('input', type=Path)
    p.add_argument('--observed-at', required=True, help='timezone-aware snapshot timestamp; future events excluded')
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    raw = args.input.read_bytes()
    observed = timestamp(args.observed_at) if args.observed_at else None
    if args.observed_at and observed is None:
        p.error('--observed-at must be timezone-aware ISO timestamp')
    out = evaluate(json.loads(raw), observed)
    out['observedAt'] = observed.isoformat() if observed else None
    out['provenance'] = {'betsSha256': hashlib.sha256(raw).hexdigest(), 'endpoint': '/api/bets/experimental'}
    args.output.write_text(json.dumps(out, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()

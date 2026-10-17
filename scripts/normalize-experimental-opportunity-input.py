"""Offline normalize read-only persisted exports; never recompute forecasts or odds.

Input contract: chunk-safe D1 decisions, exact runtime capture attestations, and
collector proof versus D1 six-place result/payout export. Missing proof stays missing.
"""
import argparse
import collections
import hashlib
import json
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, urlparse


def moment(value):
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.timestamp() if parsed.tzinfo is not None else float('nan')
    except (ValueError, AttributeError):
        return float('nan')


def outcome(row, source, as_of):
    if not source:
        return None
    proof = source['proof_results_json']
    saved = source['db_results_json']
    payout = source['proof_payouts_json']
    saved_payout = source['db_payouts_json']
    pairs = lambda rows: sorted((x['finishOrder'], x['number']) for x in rows)
    valid = source['proof_status'] == 'success' and source['quality'] == 'verified-official-outcome-v2'
    valid = valid and source['proof_race_id'] == row['race_id'] and source['proof_date'] == row['race_date']
    valid = valid and len(proof) == len(saved) == 6 and pairs(proof) == pairs(saved)
    valid = valid and sorted(x['number'] for x in saved) == list(range(1, 7))
    valid = valid and sorted(x['finishOrder'] for x in saved) == list(range(1, 7))
    valid = valid and len(payout) == len(saved_payout) == 1 and payout == saved_payout
    if not valid:
        return None
    winner = '-'.join(str(n) for _, n in pairs(saved)[:3])
    valid = payout[0]['selection'] == winner and isinstance(payout[0]['payout'], int) and payout[0]['payout'] > 0
    match = re.fullmatch(r'boat-(\d{8})-(\d{2})-(\d{2})', row['race_id'])
    if not match:
        return None
    url = urlparse(source['url'] or '')
    q = parse_qs(url.query)
    valid = valid and url.scheme == 'https' and url.hostname == 'www.boatrace.jp' and url.path == '/owpc/pc/race/raceresult'
    valid = valid and q.get('hd') == [match[1]] and q.get('jcd') == [match[2]] and q.get('rno') == [str(int(match[3]))]
    valid = valid and bool(re.fullmatch('[a-f0-9]{64}', source['sha256'] or ''))
    valid = valid and moment(source['available_at']) >= moment(row['post_time']) and moment(source['available_at']) > moment(row['decision_at']) and moment(source['available_at']) <= moment(as_of)
    if not valid:
        return None
    return dict(raceId=row['race_id'], qualityStatus=source['quality'], availableAt=source['available_at'], winnerSelection=winner, payoutPer100=payout[0]['payout'], sourceUrl=source['url'], bodySha256=source['sha256'], verified=True)


def validate_population(rows, as_of):
    if not rows or len(rows) != len({x['race_id'] for x in rows}):
        raise ValueError('Empty or duplicate decision population')
    if not all(moment(x['decision_at']) <= moment(as_of) for x in rows):
        raise ValueError('Invalid or future decision time')
    if len({x['model_id'] for x in rows}) != 1 or len({x['artifact_sha256'] for x in rows}) != 1:
        raise ValueError('Mixed model or artifact population')


def validate_binding(binding, rows, as_of, decisions_sha256):
    validate_population(rows, as_of)
    if not (binding['asOf'] == as_of and binding['modelId'] == rows[0]['model_id'] and binding['artifactSha256'] == rows[0]['artifact_sha256']):
        raise ValueError('Forecast binding scope mismatch')
    if binding['decisionsSha256'] != decisions_sha256:
        raise ValueError('Forecast binding input hash mismatch')
    if binding['matchedRows'] != sum(len(x['predictions']) for x in rows) or binding['matchedRaces'] != sum(bool(x['predictions']) for x in rows):
        raise ValueError('Forecast binding row counts mismatch')
    if any(binding[key] != 0 for key in ['artifactMismatchCount', 'featureSchemaMismatchCount', 'originMismatchCount']):
        raise ValueError('Forecast provenance mismatch')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--decisions', required=True)
    parser.add_argument('--captures', required=True)
    parser.add_argument('--outcomes', required=True)
    parser.add_argument('--as-of', required=True)
    parser.add_argument('--forecast-binding', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--inventory', required=True)
    args = parser.parse_args()
    rows = json.loads(Path(args.decisions).read_text())
    captures = {x['raceId']: x for x in json.loads(Path(args.captures).read_text())['rows']}
    outcomes = {x['race_id']: x for x in map(json.loads, Path(args.outcomes).read_text().splitlines())}
    validate_population(rows, args.as_of)
    models = {x['model_id'] for x in rows}
    artifacts = {x['artifact_sha256'] for x in rows}
    binding = json.loads(Path(args.forecast_binding).read_text())
    validate_binding(binding, rows, args.as_of, hashlib.sha256(Path(args.decisions).read_bytes()).hexdigest())
    normalized = []
    for row in rows:
        snap = row['snapshot']
        cap = captures.get(row['race_id'], {})
        market = snap.get('purchaseOdds')
        odds = {x['selection']: x['odds'] for x in (market or {}).get('odds', [])}
        hashes = snap.get('sourceHashes') or {}
        matching_hashes = all(hashes.get(key) == (cap.get('sourceHashes') or {}).get(key) for key in ['racelist', 'beforeinfo'])
        forecast_valid = bool(cap.get('archiveIdentityVerified') and cap.get('decisionArchiveValid') and cap.get('forecastArchiveAvailableBeforePrediction') and matching_hashes)
        normalized.append(dict(raceId=row['race_id'],originalDecisionOutcome=row['outcome'],originalDecisionReason=row['reason'],decisionAt=row['decision_at'],cutoffAt=snap.get('cutoffAt') or row['betting_cutoff_at'] or '',predictedAt=snap.get('predictedAt') or '',trainedAt=row['trained_at'],modelId=row['model_id'],dataOrigin='real',tickets=[dict(selection=p[0],probability=p[1],probStd=p[2],odds=odds.get(p[0],0)) for p in row['predictions']],cutoffProof=cap.get('cutoffProof') or {},forecastProof=dict(artifactSha256=row['artifact_sha256'],featureSchemaVersion='ticket-selection-v1',archiveIdentityVerified=forecast_valid,availableAt=cap.get('availableAt') or ''),purchaseOddsProof=market,outcome=outcome(row,outcomes.get(row['race_id']),args.as_of)))
    envelope=dict(schemaVersion=1,asOf=args.as_of,modelId=next(iter(models)),artifactSha256=next(iter(artifacts)),races=normalized)
    Path(args.output).write_text(json.dumps(envelope,ensure_ascii=False,indent=2)+'\n')
    counts=lambda key: dict(collections.Counter(key(x) for x in rows))
    report=dict(forecastRowBindingAudit=binding,schema='roi-historical-source-inventory-v1',asOf=args.as_of,source='read-only persisted D1 decisions, forecasts, immutable capture archives, verified collector proof and current D1 result/payout rows',sourceDecisionCount=len(rows),uniqueRaceCount=len(normalized),modelId=envelope['modelId'],artifactSha256=envelope['artifactSha256'],trainedAt=rows[0]['trained_at'],dates=counts(lambda x:x['race_date']),decisionOutcomes=counts(lambda x:x['outcome']),decisionReasons=counts(lambda x:x['reason'] or 'placed'),completeForecastCount=sum(len(x['predictions'])==120 for x in rows),completePurchaseMarketCount=sum(len((x['snapshot'].get('purchaseOdds') or {}).get('odds',[]))==120 for x in rows),validatedForecastSourceCount=sum(x['forecastProof']['archiveIdentityVerified'] for x in normalized),verifiedOutcomeAvailableAsOfCount=sum(x['outcome'] is not None for x in normalized),userDeclaredTestPurchaseDate='2026-10-13',excludedTestDateCount=sum(x['race_date']=='2026-10-13' for x in rows),completeCalendarMonths=0,monthlyPositiveProfitFrequency=None,limitations=['Saved decision population only; not all historical races have point-in-time decision markets and forecasts.','Current model was trained 2026-10-13; prior historical features cannot be scored as contemporaneous forecasts.','Fixed historical BASE R2 archive uses a different model and is not pooled.','Outcome trust is persisted verified collector SHA/proof plus D1 six-lane/payout equality; original HTML bodies were not re-fetched or rehashed.','Market source SHA is persisted provenance, not a cryptographic signature.','No inferred or final odds substitution; no missing probability or outcome imputation.','No full calendar month or positive-month frequency estimate.'],files={name:dict(sha256=hashlib.sha256(Path(path).read_bytes()).hexdigest()) for name,path in [('decisions',args.decisions),('captures',args.captures),('outcomes',args.outcomes),('normalizedInput',args.output),('forecastBinding',args.forecast_binding)]})
    Path(args.inventory).parent.mkdir(parents=True,exist_ok=True)
    Path(args.inventory).write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k not in ['limitations','files']},ensure_ascii=False))


if __name__ == '__main__':
    main()

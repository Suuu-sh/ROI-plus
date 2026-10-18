"""Prepare ignored, bounded read-only D1 export chunks for existing validators.
Never queries the network; never repairs missing evidence or synthesizes values.
"""
import argparse
import hashlib
import json
from pathlib import Path


def decoded(value):
    return json.loads(value) if isinstance(value, str) else value


def prepare(directory, prefix, as_of):
    files = sorted(directory.glob(prefix + '-[0-9]*.json'), key=lambda p: int(p.stem.split('-')[-1]))
    rows = [row for path in files for row in json.loads(path.read_text())]
    if not rows or len(rows) != len({x['race_id'] for x in rows}):
        raise ValueError('Empty or duplicate export')
    decisions, captures, outcomes = [], [], []
    mismatch = dict(artifactMismatchCount=0, featureSchemaMismatchCount=0, originMismatchCount=0)
    for row in rows:
        snap = decoded(row.pop('snapshot_json'))
        predictions = decoded(row['predictions'])
        for p in predictions:
            mismatch['artifactMismatchCount'] += p[3] != row['artifact_sha256']
            mismatch['featureSchemaMismatchCount'] += p[4] != 'ticket-selection-v1'
            mismatch['originMismatchCount'] += p[5] != 'real'
        decisions.append({**{k: row[k] for k in ['race_id', 'race_date', 'decision_at', 'outcome', 'reason', 'model_id', 'artifact_sha256', 'trained_at', 'post_time', 'betting_cutoff_at']}, 'snapshot': snap, 'predictions': [p[:3] for p in predictions]})
        entries = decoded(row['entries'])
        for e in entries:
            e['features_json'] = json.dumps(e['features_json'])
        captures.append(dict(raceId=row['race_id'], decisionAt=row['decision_at'], predictedAt=snap.get('predictedAt'), capturedAt=row['captured_at'], archive=decoded(row['archive_json']) if row['archive_json'] else None, race={**{k:row[k] for k in ['race_date','venue_id','race_no','betting_cutoff_at']},'id':row['race_id']}, entries=entries))
        proof = decoded(row['proof_json'] or {})
        # Outcomes are persisted official worker proofs only. Filter non-trifecta
        # payout types, preserving exact selection and integer payout equality.
        outcomes.append(dict(race_id=row['race_id'], proof_status=row['proof_status'], proof_date=row['proof_date'], quality=proof.get('quality'), proof_race_id=proof.get('raceId'), proof_results_json=proof.get('results', []), db_results_json=decoded(row['db_results_json']), proof_payouts_json=[dict(selection=p.get('selection'),payout=p.get('payout')) for p in proof.get('payouts',[]) if p.get('betType')=='trifecta'], db_payouts_json=decoded(row['db_payouts_json']), url=proof.get('url'), sha256=proof.get('sha256'), available_at=proof.get('fetchedAt')))
    output = directory / (prefix + '-decisions.json')
    output.write_text(json.dumps(decisions, ensure_ascii=False) + '\n')
    (directory / (prefix + '-archives.json')).write_text(json.dumps(dict(rows=captures), ensure_ascii=False) + '\n')
    (directory / (prefix + '-outcomes.jsonl')).write_text(''.join(json.dumps(x,ensure_ascii=False)+'\n' for x in outcomes))
    binding = dict(asOf=as_of, modelId=rows[0]['model_id'], artifactSha256=rows[0]['artifact_sha256'], decisionsSha256=hashlib.sha256(output.read_bytes()).hexdigest(), matchedRows=sum(len(x['predictions']) for x in decisions), matchedRaces=sum(bool(x['predictions']) for x in decisions), **mismatch)
    (directory / (prefix + '-binding.json')).write_text(json.dumps(binding,indent=2)+'\n')
    print(json.dumps(dict(sourceDecisions=len(rows),boundPredictionRows=binding['matchedRows'], **mismatch)))


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory',type=Path)
    parser.add_argument('prefix')
    parser.add_argument('--as-of',required=True)
    args=parser.parse_args()
    prepare(args.directory,args.prefix,args.as_of)

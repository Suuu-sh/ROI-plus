-- READ ONLY: start date, end date, row limit, offset.
-- Parse or losslessly gzip/base64 the full result before connector rendering.
SELECT d.race_id,d.decision_at,d.outcome,d.reason,d.model_id,d.snapshot_json,m.artifact_sha256,m.trained_at,r.race_date,r.post_time,r.betting_cutoff_at,r.venue_id,r.race_no,a.captured_at,a.archive_json,
(SELECT json_group_array(json_array(p.selection,p.probability,p.prob_std,p.artifact_sha256,p.feature_schema_version,p.data_origin)) FROM experimental_ticket_predictions p WHERE p.race_id=d.race_id AND p.model_id=d.model_id AND p.predicted_at=json_extract(d.snapshot_json,'$.predictedAt')) predictions,
(SELECT json_group_array(json_object('number',e.number,'features_json',json_object('racer_id',json_extract(e.features_json,'$.racer_id')))) FROM entries e WHERE e.race_id=d.race_id AND e.data_origin='real') entries,
cr.status proof_status,cr.target_date proof_date,cr.reason proof_json,
(SELECT json_group_array(json_object('finishOrder',x.finish_order,'number',x.number)) FROM results x WHERE x.race_id=d.race_id AND x.data_origin='real') db_results_json,
(SELECT json_group_array(json_object('selection',x.selection,'payout',x.payout)) FROM payouts x WHERE x.race_id=d.race_id AND x.bet_type='trifecta' AND x.data_origin='real') db_payouts_json
FROM experimental_paper_decisions d JOIN races r ON r.id=d.race_id JOIN experimental_models m ON m.id=d.model_id LEFT JOIN boatrace_prerace_capture_archives a ON a.id=d.capture_archive_id LEFT JOIN collection_runs cr ON cr.id='boat-result:'||d.race_id AND cr.source='boatrace-results-worker-v1' WHERE r.race_date BETWEEN ? AND ? ORDER BY d.race_id LIMIT ? OFFSET ?;

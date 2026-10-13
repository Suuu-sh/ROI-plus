// All virtual tickets counted as one purchase ledger with one bankroll.
//
// The former experiments (T-60 small-sample trifecta and the historical BASE
// trifecta) keep their own tables, decisions and settlement, but performance,
// equity and the bankroll guard read them together with ordinary bets. Tickets
// refunded by an experimental reconciliation count as void.
export const unifiedLedgerSql = `SELECT b.id,b.race_id,b.sport,b.bet_type,b.selection,b.data_origin,b.stake,b.payout,b.profit,b.status,
    b.placed_at,b.settled_at,b.model_id,b.expected_roi,b.odds_at_bet,b.final_odds,b.ev_lost,'normal' ledger
  FROM bets b WHERE NOT EXISTS(SELECT 1 FROM data_repair_audit_marks q WHERE q.record_type='bet' AND q.record_id=b.id)
  UNION ALL
  SELECT x.id,x.race_id,'boat','trifecta',x.selection,x.data_origin,x.stake,
    CASE WHEN xr.bet_id IS NULL THEN x.payout ELSE x.stake END,
    CASE WHEN xr.bet_id IS NULL THEN x.profit ELSE 0 END,
    CASE WHEN xr.bet_id IS NULL THEN x.status ELSE 'void' END,
    x.placed_at,CASE WHEN xr.bet_id IS NULL THEN x.settled_at ELSE xr.repaired_at END,
    x.model_id,x.expected_roi,x.odds_at_bet,NULL,0,'trifecta_t60'
  FROM experimental_paper_bets x
  JOIN experimental_paper_decisions xd ON xd.id=x.decision_id AND xd.experiment_key='boat-trifecta-small-sample-v1' AND xd.outcome='placed'
  LEFT JOIN experimental_paper_bet_reconciliations xr ON xr.bet_id=x.id
  WHERE x.data_origin='real'
  UNION ALL
  SELECT h.id,h.race_id,'boat','trifecta',h.selection,h.data_origin,h.stake,h.payout,h.profit,h.status,
    h.placed_at,h.settled_at,h.model_id,h.expected_roi,h.odds_at_bet,h.final_odds,0,'historical_base'
  FROM historical_trifecta_experiment_bets h`

/** Shared virtual bankroll: initial funds + settled profit − open stakes across every ledger. */
export const unifiedAvailableBankrollSql = `(COALESCE((SELECT CAST(value AS REAL) FROM settings WHERE key='initial_bankroll'), 100000)
  + COALESCE((SELECT SUM(CASE WHEN u.status IN ('won','lost') THEN u.profit WHEN u.status='open' THEN -u.stake ELSE 0 END) FROM (${unifiedLedgerSql}) u), 0))`

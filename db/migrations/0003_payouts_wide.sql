-- 拡連複（ボート）/ワイド（競馬）の払戻を保存できるようにする。
CREATE TABLE payouts_new (
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  bet_type TEXT NOT NULL CHECK (bet_type IN ('win', 'place', 'quinella', 'exacta', 'wide', 'trio', 'trifecta')),
  selection TEXT NOT NULL,
  payout INTEGER NOT NULL CHECK (payout >= 0),
  popularity INTEGER,
  data_origin TEXT NOT NULL CHECK (data_origin IN ('sample', 'real')),
  PRIMARY KEY (race_id, bet_type, selection)
);
INSERT INTO payouts_new SELECT race_id, bet_type, selection, payout, popularity, data_origin FROM payouts;
DROP TABLE payouts;
ALTER TABLE payouts_new RENAME TO payouts;

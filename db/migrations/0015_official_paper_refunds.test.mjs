import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import Database from 'better-sqlite3'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const migration = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), '0015_official_paper_refunds.sql'), 'utf8')

test('0015 preserves experimental bet and reconciliation values, FKs, and unrelated model/forecast rows', () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE races(id TEXT PRIMARY KEY);
    CREATE TABLE experimental_models(id TEXT PRIMARY KEY);
    CREATE TABLE experimental_paper_decisions(id TEXT PRIMARY KEY);
    CREATE TABLE historical_trifecta_experiment_decisions(id TEXT PRIMARY KEY);
    CREATE TABLE models(id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE predictions(id TEXT PRIMARY KEY, model_id TEXT NOT NULL REFERENCES models(id));
    INSERT INTO races VALUES ('r1'),('r2'),('r3'),('h1'),('h2'),('h3');
    INSERT INTO experimental_models VALUES ('em1');
    INSERT INTO experimental_paper_decisions VALUES ('ed1'),('ed2'),('ed3');
    INSERT INTO historical_trifecta_experiment_decisions VALUES ('hd1'),('hd2'),('hd3');
    INSERT INTO models VALUES ('normal-model','active');
    INSERT INTO predictions VALUES ('prediction-1','normal-model');

    CREATE TABLE experimental_paper_bets (
      id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL REFERENCES experimental_paper_decisions(id) ON DELETE RESTRICT,
      race_id TEXT NOT NULL REFERENCES races(id) ON DELETE RESTRICT,
      model_id TEXT NOT NULL REFERENCES experimental_models(id) ON DELETE RESTRICT,
      selection TEXT NOT NULL,
      stake INTEGER NOT NULL CHECK (stake>0),
      probability REAL NOT NULL CHECK (probability>=0 AND probability<=1),
      prob_std REAL NOT NULL CHECK (prob_std>=0),
      odds_at_bet REAL NOT NULL CHECK (odds_at_bet>0),
      expected_roi REAL NOT NULL,
      placed_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open','won','lost')),
      payout INTEGER CHECK (payout IS NULL OR payout>=0),
      profit INTEGER,
      settled_at TEXT,
      data_origin TEXT NOT NULL CHECK (data_origin='real'),
      UNIQUE(race_id,selection)
    );
    CREATE INDEX idx_experimental_paper_bets_status ON experimental_paper_bets(status,placed_at);
    CREATE TABLE experimental_paper_bet_reconciliations (
      bet_id TEXT PRIMARY KEY REFERENCES experimental_paper_bets(id) ON DELETE RESTRICT,
      experiment_key TEXT NOT NULL CHECK (experiment_key='boat-trifecta-small-sample-v1'),
      original_stake INTEGER NOT NULL CHECK (original_stake>0),
      refund_amount INTEGER NOT NULL CHECK (refund_amount=original_stake),
      repair_reason TEXT NOT NULL CHECK (repair_reason='invalid_stake_unit'),
      repaired_at TEXT NOT NULL,
      refund_applied_at TEXT
    );
    CREATE TRIGGER trg_experimental_paper_bets_valid_stake_insert BEFORE INSERT ON experimental_paper_bets
      WHEN NEW.stake<100 OR NEW.stake%100<>0 BEGIN SELECT RAISE(ABORT, 'invalid stake'); END;
    CREATE TRIGGER trg_experimental_paper_bets_valid_stake_update BEFORE UPDATE OF stake ON experimental_paper_bets
      WHEN NEW.stake<100 OR NEW.stake%100<>0 BEGIN SELECT RAISE(ABORT, 'invalid stake'); END;
    CREATE TRIGGER trg_experimental_paper_bet_reconciliations_no_update BEFORE UPDATE ON experimental_paper_bet_reconciliations
      BEGIN SELECT RAISE(ABORT, 'immutable'); END;
    CREATE TRIGGER trg_experimental_paper_bet_reconciliations_no_delete BEFORE DELETE ON experimental_paper_bet_reconciliations
      BEGIN SELECT RAISE(ABORT, 'immutable'); END;

    CREATE TABLE historical_trifecta_experiment_bets (
      id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL REFERENCES historical_trifecta_experiment_decisions(id) ON DELETE RESTRICT,
      race_id TEXT NOT NULL REFERENCES races(id) ON DELETE RESTRICT,
      model_id TEXT NOT NULL CHECK (model_id='boat-trifecta-historical-base-20261014'),
      selection TEXT NOT NULL,
      stake INTEGER NOT NULL CHECK (stake>=100 AND stake%100=0),
      probability REAL NOT NULL CHECK (probability>=0 AND probability<=1),
      prob_std REAL NOT NULL CHECK (prob_std>=0),
      odds_at_bet REAL NOT NULL CHECK (odds_at_bet>1),
      expected_roi REAL NOT NULL,
      placed_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open','won','lost')),
      payout INTEGER CHECK (payout IS NULL OR payout>=0),
      profit INTEGER,
      settled_at TEXT,
      final_odds REAL,
      data_origin TEXT NOT NULL CHECK (data_origin='real'),
      UNIQUE(decision_id,selection)
    );
    CREATE INDEX idx_historical_trifecta_experiment_bets_status ON historical_trifecta_experiment_bets(status,placed_at);

    INSERT INTO experimental_paper_bets VALUES
      ('e-open','ed1','r1','em1','1-2-3',100,0.4,0.01,12.5,4,'2026-10-01T01:00:00Z','open',NULL,NULL,NULL,'real'),
      ('e-won','ed2','r2','em1','2-3-4',200,0.3,0.02,9.5,1.85,'2026-10-01T02:00:00Z','won',1900,1700,'2026-10-01T03:00:00Z','real'),
      ('e-lost','ed3','r3','em1','3-4-5',300,0.2,0.03,5.5,0.1,'2026-10-01T04:00:00Z','lost',0,-300,'2026-10-01T05:00:00Z','real');
    INSERT INTO experimental_paper_bet_reconciliations VALUES
      ('e-open','boat-trifecta-small-sample-v1',100,100,'invalid_stake_unit','2026-10-01T06:00:00Z','2026-10-01T06:01:00Z');
    INSERT INTO historical_trifecta_experiment_bets VALUES
      ('h-open','hd1','h1','boat-trifecta-historical-base-20261014','1-2-3',100,0.4,0.01,12.5,4,'2026-10-02T01:00:00Z','open',NULL,NULL,NULL,NULL,'real'),
      ('h-won','hd2','h2','boat-trifecta-historical-base-20261014','2-3-4',200,0.3,0.02,9.5,1.85,'2026-10-02T02:00:00Z','won',1900,1700,'2026-10-02T03:00:00Z',9.5,'real'),
      ('h-lost','hd3','h3','boat-trifecta-historical-base-20261014','3-4-5',300,0.2,0.03,5.5,0.1,'2026-10-02T04:00:00Z','lost',0,-300,'2026-10-02T05:00:00Z',NULL,'real');
  `)
  const originals = Object.fromEntries(['experimental_paper_bets','historical_trifecta_experiment_bets','experimental_paper_bet_reconciliations']
    .map((name) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all()]))
  const unrelated = db.prepare('SELECT * FROM models JOIN predictions ON predictions.model_id=models.id').all()
  const rollback = db.transaction(() => {
    db.exec(migration)
    throw new Error('intentional migration failure')
  })
  assert.throws(() => rollback(), /intentional migration failure/)
  for (const [table, rows] of Object.entries(originals)) {
    assert.deepEqual(db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(), rows, `${table} should survive a failed migration`)
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='table' AND name LIKE '%refund_shadow'").get().count, 0)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  db.exec(migration)
  for (const [table, rows] of Object.entries(originals)) {
    assert.deepEqual(db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(), rows, `${table} values should be identical`)
  }
  assert.deepEqual(db.prepare('SELECT * FROM models JOIN predictions ON predictions.model_id=models.id').all(), unrelated)
  assert.deepEqual(db.pragma('foreign_key_check'), [])
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='index' AND name IN ('idx_experimental_paper_bets_status','idx_historical_trifecta_experiment_bets_status')").get().count, 2)
  assert.throws(() => db.prepare(`INSERT INTO experimental_paper_bets VALUES ('bad','ed1','r1','em1','x',100,.2,.01,2,1,'t','refunded',0,0,'t','real')`).run(), /CHECK constraint failed/)
  assert.throws(() => db.prepare(`INSERT INTO historical_trifecta_experiment_bets VALUES ('h-bad','hd1','h1','boat-trifecta-historical-base-20261014','x',100,.2,.01,2,1,'t','refunded',0,0,'t',NULL,'real')`).run(), /CHECK constraint failed/)
  db.prepare(`INSERT INTO experimental_paper_bets VALUES ('e-void','ed1','r1','em1','void-ticket',100,.2,.01,2,1,'t','void',100,0,'t','real')`).run()
  db.prepare(`INSERT INTO historical_trifecta_experiment_bets VALUES ('h-void','hd1','h1','boat-trifecta-historical-base-20261014','void-ticket',100,.2,.01,2,1,'t','void',100,0,'t',NULL,'real')`).run()
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM experimental_paper_bets WHERE status='void'").get().count, 1)
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM historical_trifecta_experiment_bets WHERE status='void'").get().count, 1)
  db.close()
})

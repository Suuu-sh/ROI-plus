import copy
import importlib.util
import math
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('normalize', Path(__file__).with_name('normalize-experimental-opportunity-input.py'))
normalize = importlib.util.module_from_spec(spec)
spec.loader.exec_module(normalize)

class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.row = dict(race_id='boat-20261014-13-01', race_date='2026-10-14', post_time='2026-10-14T10:00:00+09:00', decision_at='2026-10-14T09:59:00+09:00')
        results = [dict(number=i, finishOrder=i) for i in range(1,7)]
        self.proof = dict(proof_status='success', quality='verified-official-outcome-v2', proof_race_id=self.row['race_id'], proof_date=self.row['race_date'], proof_results_json=results, db_results_json=copy.deepcopy(results), proof_payouts_json=[dict(selection='1-2-3',payout=1000)], db_payouts_json=[dict(selection='1-2-3',payout=1000)], url='https://www.boatrace.jp/owpc/pc/race/raceresult?rno=1&jcd=13&hd=20261014',sha256='a'*64, available_at='2026-10-14T10:10:00+09:00')
        self.as_of='2026-10-14T11:00:00+09:00'
    def check(self):
        return normalize.outcome(self.row,self.proof,self.as_of)
    def test_valid(self):
        self.assertEqual(self.check()['payoutPer100'],1000)
    def test_diverged_payout(self):
        self.proof['db_payouts_json'][0]['payout']=2000
        self.assertIsNone(self.check())
    def test_duplicate_ranks(self):
        self.proof['proof_results_json'][1]['finishOrder']=1
        self.proof['db_results_json'][1]['finishOrder']=1
        self.assertIsNone(self.check())
    def test_foreign_url(self):
        self.proof['url']=self.proof['url'].replace('jcd=13','jcd=14')
        self.assertIsNone(self.check())
    def test_invalid_race_id(self):
        self.row['race_id']='invalid';self.proof['proof_race_id']='invalid'
        self.assertIsNone(self.check())
    def test_future_and_naive_time(self):
        for timestamp in ['2026-10-15T10:10:00+09:00','2026-10-14T10:10:00','invalid']:
            self.proof['available_at']=timestamp
            self.assertIsNone(self.check())
        self.assertTrue(math.isnan(normalize.moment('2026-10-14T10:00:00')))

class BindingTests(unittest.TestCase):
    def setUp(self):
        self.as_of='2026-10-17T10:35:04.843+09:00'
        self.rows=[dict(race_id='boat-20261014-13-01',decision_at='2026-10-14T10:00:00+09:00',model_id='model',artifact_sha256='a'*64,predictions=[[1]])]
        self.binding=dict(asOf=self.as_of,modelId='model',artifactSha256='a'*64,decisionsSha256='b'*64,matchedRows=1,matchedRaces=1,artifactMismatchCount=0,featureSchemaMismatchCount=0,originMismatchCount=0)
    def check(self):
        normalize.validate_binding(self.binding,self.rows,self.as_of,'b'*64)
    def test_valid(self):
        self.check()
    def test_tampered_binding(self):
        for key,value in [('decisionsSha256','c'*64),('artifactMismatchCount',1),('featureSchemaMismatchCount',1),('originMismatchCount',1),('matchedRows',2),('matchedRaces',2),('asOf','invalid'),('modelId','other'),('artifactSha256','c'*64)]:
            with self.subTest(key=key):
                old=self.binding[key];self.binding[key]=value
                with self.assertRaises(ValueError):self.check()
                self.binding[key]=old
    def test_population_time_and_duplicates(self):
        for timestamp in ['2026-10-18T10:00:00+09:00','2026-10-14T10:00:00','invalid']:
            self.rows[0]['decision_at']=timestamp
            with self.assertRaises(ValueError):self.check()
        self.rows[0]['decision_at']='2026-10-14T10:00:00+09:00'
        self.rows.append(copy.deepcopy(self.rows[0]))
        with self.assertRaises(ValueError):self.check()
    def test_optimized_python_still_rejects(self):
        import subprocess
        import sys
        code = "import importlib.util; s=importlib.util.spec_from_file_location('n',"+repr(str(Path(__file__).with_name('normalize-experimental-opportunity-input.py')))+"); n=importlib.util.module_from_spec(s); s.loader.exec_module(n); n.validate_binding("+repr(dict(self.binding,matchedRows=999))+","+repr(self.rows)+","+repr(self.as_of)+",'"+'b'*64+"')"
        result=subprocess.run([sys.executable,'-O','-c',code],capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('Forecast binding row counts mismatch',result.stderr)

if __name__=='__main__':unittest.main()

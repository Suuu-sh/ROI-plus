"""Synthetic-only TS/Python feature and inference parity."""
import importlib.util,itertools,json,pathlib,subprocess,tempfile,unittest
import numpy as np
ROOT=pathlib.Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('fit',ROOT/'scripts/train-recovered-market-model.py');fit=importlib.util.module_from_spec(spec);spec.loader.exec_module(fit)
class Parity(unittest.TestCase):
 def test_transform(self):
  ts=[{'selection':'-'.join(map(str,a)),'probability':1/120,'odds':10+i,'probStd':.01} for i,a in enumerate(itertools.permutations(range(1,7),3))];w=np.sin(np.arange(127));m,x=fit.design(ts);z=np.log(m)+x@w;p=np.exp(z-z.max());p/=p.sum()
  with tempfile.TemporaryDirectory(prefix='roi-parity-') as d:
   subprocess.run(['node','node_modules/typescript/bin/tsc','--target','es2022','--module','es2022','--moduleResolution','bundler','--skipLibCheck','--outDir',d,'scripts/recovered-market-model.ts'],cwd=ROOT,check=True,capture_output=True)
   pathlib.Path(d,'package.json').write_text('{"type":"module"}')
   js='import {recoveredMarketDesign,recoveredMarketTransform} from '+json.dumps(pathlib.Path(d,'scripts/recovered-market-model.js').as_uri())+';const t='+json.dumps(ts)+'; console.log(JSON.stringify({x:recoveredMarketDesign(t).features,p:recoveredMarketTransform(t,'+json.dumps(w.tolist())+').map(t=>t.probability)}))'
   actual=json.loads(subprocess.check_output(['node','--input-type=module','-e',js],cwd=ROOT))
  np.testing.assert_allclose(actual['x'],x,atol=1e-14,rtol=0);np.testing.assert_allclose(actual['p'],p,atol=1e-14,rtol=0)
if __name__=='__main__':unittest.main()

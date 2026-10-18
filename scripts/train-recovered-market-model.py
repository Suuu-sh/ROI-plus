"""Offline fit ONLY on prevalidated Oct14-17 replay rows. Never loads test."""
import sys,json,hashlib,datetime,pathlib
import numpy as np
from scipy.optimize import minimize
ROOT=pathlib.Path(__file__).resolve().parent
sha=lambda b:hashlib.sha256(b).hexdigest()
def design(ts):
    m=np.array([1/t['odds'] for t in ts]);m/=m.sum()
    a=np.array([[int(l)-1 for l in t['selection'].split('-')] for t in ts]);x=np.zeros((120,127));marg=np.zeros((3,6))
    for i in range(120):
        for p in range(3):marg[p,a[i,p]]+=m[i]
    for i in range(120):
        for p in range(3):x[i,p*6+a[i,p]]=1
        for j,(p,q) in enumerate([(0,1),(0,2),(1,2)]):
            l,r=a[i,p],a[i,q];x[i,18+j*30+l*5+r-int(r>l)]=1
        x[i,108]=np.clip(np.log(max(ts[i]['probability'],1e-12)/m[i]),-5,5)/5
        for p in range(3):x[i,109+p*6+a[i,p]]=np.clip(np.log(marg[p,a[i,p]]),-5,5)/5
    return m,x
def main():
    src,out=map(pathlib.Path,sys.argv[1:]);raw=src.read_bytes();inp=json.loads(raw);protocol_raw=(ROOT/'recovered-market-model-protocol.json').read_bytes();protocol=json.loads(protocol_raw)
    # This file must contain ONLY training dates; refuse any test row, even unlabeled.
    if any(r['raceId'][5:13] not in protocol['trainingDates'] for r in inp['races']):raise ValueError('Non-training input')
    rows=[r for r in inp['races'] if (r.get('outcome') or {}).get('qualityStatus')=='verified-official-outcome-v2']
    data=[]
    for r in rows:
        m,x=design(r['tickets']);y=[t['selection'] for t in r['tickets']].index(r['outcome']['winnerSelection']);data.append((r,m,x,y))
    train=[d for d in data if d[0]['raceId'][5:13] in protocol['innerFitDates']];valid=[d for d in data if d[0]['raceId'][5:13] in protocol['innerValidationDates']]
    if not train or not valid:raise ValueError('Empty temporal split')
    def pack(ds):return np.array([d[1] for d in ds]),np.array([d[2] for d in ds]),np.array([d[3] for d in ds])
    def loss(w,ds,l2=0,grad=False):
        m,x,y=pack(ds);z=np.log(m)+x@w;z-=z.max(axis=1,keepdims=True);p=np.exp(z);p/=p.sum(axis=1,keepdims=True);v=-np.log(p[np.arange(len(y)),y]).mean()+l2/2*(w@w)
        if not grad:return float(v)
        p[np.arange(len(y)),y]-=1;g=np.einsum('ni,nij->j',p,x)/len(y)+l2*w;return v,g
    def fit(ds,l2):
        result=minimize(lambda w:loss(w,ds,l2,True),np.zeros(127),jac=True,method='L-BFGS-B',options={k:v for k,v in protocol['optimizer'].items() if k!='method'})
        if not result.success:raise ValueError(str(result.message))
        return result.x
    scores=[{'arm':'market','l2':None,'validationNll':loss(np.zeros(127),valid)}]
    for l2 in protocol['l2Grid']:
        w=fit(train,l2);scores.append({'arm':'learned','l2':l2,'validationNll':loss(w,valid)})
    best=min(scores[1:],key=lambda s:(round(s['validationNll'],10),-s['l2']));selected=min(scores,key=lambda s:(round(s['validationNll'],10),0 if s['arm']=='market' else 1,-(s['l2'] or 0)));w=fit(data,best['l2'])
    artifact={'schemaVersion':1,'candidateId':'recovered-market-interactions-research','createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'protocol':protocol,'protocolSha256':sha(protocol_raw),'inputDatasetSha256':sha(raw),'implementationSha256':sha((ROOT/'recovered-market-model.ts').read_bytes()),'trainerSha256':sha(pathlib.Path(__file__).read_bytes()),'baseModelId':inp['modelId'],'baseModelArtifactSha256':inp['artifactSha256'],'weights':w.tolist(),'selectedPolicyArm':selected['arm'],'selectedL2':best['l2'],'selection':selected,'validationScores':scores,'trainingRaceIds':[d[0]['raceId'] for d in data],'trainingRaceCount':len(data),'innerFitRaceCount':len(train),'innerValidationRaceCount':len(valid),'trainingNll':loss(w,data),'registered':False,'promoted':False,'promotionEligible':False,'testStatus':'already-inspected retrospective, not untouched'}
    payload=(json.dumps(artifact,indent=2)+'\n').encode();out.open('xb').write(payload);print(json.dumps({k:artifact[k] for k in ['createdAt','trainingRaceCount','innerFitRaceCount','innerValidationRaceCount','validationScores','selection','trainingNll']}));print('artifactSha256',sha(payload))
if __name__=='__main__':main()

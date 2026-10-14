import {describe,expect,it,vi} from 'vitest';
import {runScheduledDecisionPasses,runScheduledDecisionStages,waitForNextPaperT60Target} from '../src/index.js';

describe('scheduled decision stage isolation',()=>{
  it('continues later decisions and scheduled recovery after a normal decision rejects',async()=>{
    const lines:string[]=[],experimental=vi.fn(async()=>({evaluated:1})),historical=vi.fn(async()=>({archiveObservations:[]}));
    const result=await runScheduledDecisionStages({
      normal:async()=>{throw new Error('sensitive database detail');},experimental,historical,log:line=>lines.push(line),
    });
    const recovery=vi.fn();
    await recovery();
    expect(result.normal.status).toBe('failed');
    expect(experimental).toHaveBeenCalledOnce();expect(historical).toHaveBeenCalledOnce();expect(recovery).toHaveBeenCalledOnce();
    expect(lines.map(line=>JSON.parse(line).status)).toEqual(['failed','success','success']);
    expect(JSON.parse(lines[0]).elapsedMs).toEqual(expect.any(Number));
    expect(lines[0]).toContain('"reason":"decision-stage-failed"');
    expect(lines[0]).toContain('"errorClass":"Error"');
    expect(lines.join('\n')).not.toContain('sensitive database detail');
  });

  it('preserves the normal decision and continues historical work after experimental rejects',async()=>{
    const lines:string[]=[],normal=vi.fn(async()=>({bought:1,report:{boughtBetCount:2}})),historical=vi.fn(async()=>({archiveObservations:[]}));
    const result=await runScheduledDecisionStages({normal,experimental:async()=>{throw 'private failure';},historical,log:line=>lines.push(line)});
    expect(result.normal).toMatchObject({status:'success',value:{bought:1}});
    expect(result.experimental.status).toBe('failed');expect(historical).toHaveBeenCalledOnce();
    expect(JSON.parse(lines[0])).toMatchObject({event:'paper-decision-timing',status:'success',boughtBetCount:2});
    expect(JSON.parse(lines[1])).toMatchObject({event:'experimental-paper-decision',status:'failed',reason:'decision-stage-failed',errorClass:'Error'});
    expect(lines.join('\n')).not.toContain('private failure');
  });

  it('waits only for an upcoming target and runs decisions on the refreshed wall clock',async()=>{
    let clock=1_800_000_000_000;const target=clock+47_000,sleep=vi.fn(async(ms:number)=>{clock+=ms;});
    const timing=await waitForNextPaperT60Target({now:()=>clock,findTarget:async(after,through)=>{
      expect(after).toBe(1_799_999_990_000);expect(through).toBe(1_800_000_060_000);return target;
    },refresh:async()=>{},sleep});
    const decisions=vi.fn(async()=>clock);
    const stage=await runScheduledDecisionStages({experimental:decisions,historical:async()=>({})});
    expect(timing).toMatchObject({status:'ready',targetMs:target,actualMs:target-8_000});
    expect(sleep).toHaveBeenCalledWith(39_000);expect(decisions).toHaveBeenCalledOnce();expect(stage.experimental.value).toBe(target-8_000);
  });

  it('skips an expired target after timer overshoot without reusing the target timestamp',async()=>{
    let clock=1_800_000_000_000;const target=clock+20_000,lines:string[]=[];
    const timing=await waitForNextPaperT60Target({now:()=>clock,findTarget:async()=>target,refresh:async()=>{},
      sleep:async(ms:number)=>{clock+=ms+18_001;},log:line=>lines.push(line)});
    expect(timing).toMatchObject({status:'expired',targetMs:target,actualMs:target+10_001});
    expect(JSON.parse(lines[0])).toMatchObject({event:'paper-t60-target',status:'skipped',reason:'t60-window-expired'});
    const observed:number[]=[];
    await runScheduledDecisionStages({experimental:async()=>{observed.push(clock);return{};},historical:async()=>({})});
    expect(observed).toEqual([target+10_001]);
  });

  it('does not sleep for a target whose safe early point has passed, and keeps the real current clock',async()=>{
    let clock=1_800_000_000_000;const target=clock+5_000,sleep=vi.fn(async(ms:number)=>{clock+=ms;});
    const refresh=vi.fn(async()=>{});
    const timing=await waitForNextPaperT60Target({now:()=>clock,findTarget:async()=>target,refresh,sleep});
    const observed:number[]=[];
    await runScheduledDecisionStages({experimental:async()=>{observed.push(clock);return{};},historical:async()=>({})});
    expect(timing).toMatchObject({status:'ready',targetMs:target,actualMs:clock});
    expect(sleep).not.toHaveBeenCalled();expect(refresh).toHaveBeenCalledOnce();expect(observed).toEqual([1_800_000_000_000]);
  });

  it('evaluates the current window before waiting and reuses the same decision context at the next target',async()=>{
    vi.useFakeTimers();let clock=1_800_000_000_000;vi.setSystemTime(clock);const target=clock+47_000,context={requestBudget:{used:0,max:49}},calls:string[]=[];
    const stage=(name:string)=>async()=>{calls.push(`${name}:${clock}:${context.requestBudget.max}`);return name==='historical'?{archiveObservations:[]}:{evaluated:0};};
    const lines:string[]=[];
    const result=await runScheduledDecisionPasses({normal:stage('normal'),experimental:stage('experimental'),historical:stage('historical'),log:line=>lines.push(line)},async()=>{
      clock=target-8_000;vi.setSystemTime(clock);return {status:'ready' as const,targetMs:target};
    },()=>{});
    expect(result.upcoming).not.toBeNull();
    expect(calls).toEqual([
      `normal:${1_800_000_000_000}:49`,`experimental:${1_800_000_000_000}:49`,`historical:${1_800_000_000_000}:49`,
      `normal:${target-8_000}:49`,`experimental:${target-8_000}:49`,`historical:${target-8_000}:49`,
    ]);
    expect(JSON.parse(lines[3])).toMatchObject({pass:'upcoming-t60',startDeltaMs:-8_000});
    vi.useRealTimers();
  });
});

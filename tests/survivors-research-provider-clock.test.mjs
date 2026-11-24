import assert from 'node:assert/strict';
import test from 'node:test';
import {createProviderClock,timedProviderResult} from '../src/client/survivors-research/provider-clock.js';

function harness(){
  let frame=0,queued=null;
  const trace=[],applied=[],faults=[];
  const clock=createProviderClock({trace:event=>trace.push(event),fatal:error=>faults.push(error),
    async step(target,held){
      if(held)applied.push({id:held.decision_id,frame:frame+1,deferred:true});
      if(queued)applied.push({id:queued.id,frame:frame+1});
      frame=target;
      queued?.resolve({applied_tick:target});
      queued=null;
      return {relative_tick:frame,terminal:false};
    }});
  const roleResult=(role,value)=>({backend_metadata:role==='micro'
    ? {upstream_nace_evaluation_time_ms:value}
    : {upstream_openai_processing_ms:value}});
  const request=(id,role,value,signal,wait=Promise.resolve())=>timedProviderResult(clock,{
    id,role,observation:{tick:frame},signal,
  },async()=>{await wait;return roleResult(role,value);});
  const ack=decision_id=>clock.acknowledge({decision_id},action=>new Promise(resolve=>{
    assert.equal(queued,null);
    queued={id:action.decision_id,resolve};
  }));
  return {clock,trace,applied,faults,request,ack};
}

test('provider clock freezes until concurrent replies are known and publishes by readiness',async()=>{
  const h=harness();
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const order=[];
  const strategy=h.request('strategy','strategy',500).then(()=>order.push('strategy'));
  const advisor=h.request('advisor','advisor',200).then(()=>order.push('advisor'));
  const micro=h.request('micro','micro',200,undefined,gate).then(()=>order.push('micro'));
  await new Promise(setImmediate);
  assert.equal(h.clock.snapshot().frame,0);
  assert.deepEqual(order,[]);
  release();
  await micro;
  assert.deepEqual(order,['advisor','micro']);
  assert.equal(h.clock.snapshot().frame,11);
  await h.ack('micro');
  assert.equal(h.clock.snapshot().frame,12);
  await h.request('second','micro',400);
  await h.ack('second');
  await Promise.all([advisor,strategy]);
  assert.deepEqual(order,['advisor','micro','strategy']);
  assert.equal(h.clock.snapshot().frame,30);
  assert.equal(h.clock.snapshot().virtual_ms,500);
  assert.deepEqual(h.faults,[]);
});

test('an auxiliary launched on the same turn joins a foreground upgrade',async()=>{
  const h=harness();
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const upper=Promise.resolve().then(()=>h.request('advisor','advisor',100,undefined,gate));
  const upgrade=h.request('upgrade','upgrade',200);
  await new Promise(setImmediate);
  assert.equal(h.clock.snapshot().frame,0);
  release();
  await Promise.all([upgrade,upper]);
  await h.ack('upgrade');
  assert.deepEqual(h.trace.filter(row=>row.type==='provider_clock:publish').map(row=>row.id),['advisor','upgrade']);
});

test('one hundred one-millisecond replies carry fractions without free frames',async()=>{
  const h=harness();
  for(let i=0;i<100;i++){
    const id='micro-'+i;
    await h.request(id,'micro',1);
    await h.ack(id);
  }
  assert.equal(h.clock.snapshot().frame,6);
  assert.equal(h.clock.snapshot().virtual_ms,100);
  assert.equal(h.applied.length,6);
  const replacements=h.trace.filter(row=>row.type==='provider_clock:action_deferred'&&row.replaced_decision_id);
  assert.ok(replacements.length>80);
  assert.deepEqual(h.faults,[]);
});

test('the newest zero-frame choice can drive old frames before the next result',async()=>{
  const h=harness();
  await h.request('first','micro',100);
  await h.ack('first');
  // Move into the next grid interval first so later 1 ms reports share it.
  await h.request('second','micro',1);
  await h.ack('second');
  await h.request('queued-old','micro',1);
  assert.equal((await h.ack('queued-old')).clock_deferred,true);
  await h.request('queued-new','micro',1);
  assert.equal((await h.ack('queued-new')).clock_deferred,true);
  await h.request('third','micro',100);
  await h.ack('third');
  assert.deepEqual(h.applied.map(row=>row.id),['first','second','queued-new','third']);
  assert.equal(h.applied.find(row=>row.id==='queued-new').frame,8);
});

test('an already received result waits on virtual time beyond its transport deadline',async()=>{
  const h=harness();
  const transport=AbortSignal.timeout(5);
  const upper=timedProviderResult(h.clock,{id:'advisor',role:'advisor',observation:{tick:0}},async()=>{
    transport.throwIfAborted();
    return {backend_metadata:{upstream_openai_processing_ms:150}};
  });
  await h.request('first','micro',100);
  await h.ack('first');
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(transport.aborted,true);
  await h.request('next','micro',100);
  await h.ack('next');
  await upper;
  assert.ok(h.trace.some(row=>row.id==='advisor'&&row.type==='provider_clock:publish'&&row.virtual_ms===150));
});

test('missing provider values and terminal cancellations never publish or advance',async()=>{
  const h=harness();
  await assert.rejects(h.request('bad','micro',null));
  assert.match(h.faults[0].message,/供应商处理时间/);
  assert.equal(h.clock.snapshot().frame,0);
  const other=harness();
  const pending=other.request('advisor','advisor',50);
  other.clock.end();
  await assert.rejects(pending,{name:'AbortError'});
  assert.equal(other.clock.snapshot().frame,0);
  assert.equal(other.trace.filter(row=>row.type==='provider_clock:publish').length,0);
});

test('default admission shares the Drex direction and micro gate and releases cancelled waiting work',async()=>{
  const {createPacedNaceAdmission}=await import('../src/client/survivors-research/provider-clock.js');
  const {NACE_PROVIDER}=await import('../src/client/survivors-research/models/nace-decisions.js');
  const admit=createPacedNaceAdmission(25);
  const result=[];
  const stamp=role=>()=>result.push([role,performance.now()]);
  await admit({role:'advisor',provider:NACE_PROVIDER},stamp('direction'));
  const stop=new AbortController();
  const cancelled=admit({role:'micro',signal:stop.signal},stamp('cancelled'));
  const next=admit({role:'micro'},stamp('micro'));
  await admit({role:'strategy'},stamp('strategy'));
  stop.abort();
  await assert.rejects(cancelled,{name:'AbortError'});
  await next;
  assert.deepEqual(result.map(([role])=>role),['direction','strategy','micro']);
  assert.ok(result[2][1]-result[0][1]>=25);
});

test('closing the provider clock cancels an admission without a late model load',async()=>{
  const {createPacedNaceAdmission}=await import('../src/client/survivors-research/provider-clock.js');
  const admission=createPacedNaceAdmission(25);
  await admission({role:'micro'},()=>{});
  const clock=createProviderClock({admission,step:()=>assert.fail('Cancelled admission cannot step')});
  let called=false;
  const pending=timedProviderResult(clock,{id:'cancel',role:'micro',observation:{tick:0}},()=>{called=true;});
  await Promise.resolve();
  clock.end();
  await assert.rejects(pending,{name:'AbortError'});
  await new Promise(resolve=>setTimeout(resolve,35));
  assert.equal(called,false);
});

test('advisor timeout and missing strategy time leave a valid micro on its own causal frame',async()=>{
  const h=harness();
  let failAdvisor;
  const timeout=new Promise((_,reject)=>{failAdvisor=reject;});
  const failure=Object.assign(Error('Model request timed out'),{code:'timeout'});
  const advisor=assert.rejects(h.request('slow-advisor','advisor',300,undefined,timeout),error=>error===failure);
  const strategy=assert.rejects(h.request('missing-strategy','strategy',null),/缺少 strategy/);
  const micro=h.request('healthy-micro','micro',450);
  await new Promise(setImmediate);
  assert.equal(h.clock.snapshot().frame,0);
  failAdvisor(failure);
  await Promise.all([advisor,strategy,micro]);
  await h.ack('healthy-micro');
  assert.deepEqual(h.applied,[{id:'healthy-micro',frame:18}]);
  assert.equal(h.clock.snapshot().virtual_ms,300);
  assert.equal(h.clock.snapshot().pending,0);
  assert.equal(h.clock.snapshot().terminal,false);
  assert.deepEqual(h.faults,[]);
  assert.deepEqual(h.trace.filter(row=>row.type==='provider_clock:publish').map(row=>row.id),['healthy-micro']);
  const failures=h.trace.filter(row=>row.type==='provider_clock:auxiliary_failed');
  assert.deepEqual(failures.map(row=>row.role).sort(),['advisor','strategy']);
  assert.equal(failures.find(row=>row.role==='advisor').error.code,'timeout');
  assert.ok(failures.every(row=>row.provider_processing_ms===null&&row.ready_virtual_ms===null&&
    row.effective_provider_processing_ms===null&&row.provider_model_compensated_ms===null));
});

test('300 ms limits effective processing without rounding each request or discarding its answer',async()=>{
  const h=harness();
  const samples=[270.5,300,300.5,640,0];
  const expectedFrames=[17,35,53,71,71];
  const expectedVirtualMs=[270.5,570.5,870.5,1170.5,1170.5];
  for (const [index,raw] of samples.entries()) {
    const id='sample-'+index;
    const result=await h.request(id,'micro',raw);
    const ack=await h.ack(id);
    assert.equal(result.backend_metadata.upstream_nace_evaluation_time_ms,raw);
    assert.equal(h.clock.snapshot().frame,expectedFrames[index]);
    assert.equal(h.clock.snapshot().virtual_ms,expectedVirtualMs[index]);
    assert.equal(h.clock.snapshot().provider_processing_cap_ms,300);
    const timing=h.trace.find(row=>row.type==='provider_clock:reported'&&row.id===id);
    assert.deepEqual([timing.provider_processing_ms,timing.effective_provider_processing_ms,
      timing.provider_model_compensated_ms,timing.ready_virtual_ms],
    [raw,Math.min(raw,300),Math.max(0,raw-300),expectedVirtualMs[index]]);
    if(index<4)assert.equal(ack.applied_tick,expectedFrames[index]);
    else assert.equal(ack.clock_deferred,true);
  }
  assert.deepEqual(h.applied.map(row=>row.frame),[17,35,53,71]);
  assert.deepEqual(h.faults,[]);
});

test('overlapping long replies share the cap horizon and retain individual processing evidence',async()=>{
  const h=harness();
  const advisor=h.request('advisor','advisor',700);
  const strategy=h.request('strategy','strategy',900);
  const upgrade=h.request('upgrade','upgrade',640);
  await Promise.all([advisor,strategy,upgrade]);
  await h.ack('upgrade');
  assert.deepEqual(h.trace.filter(row=>row.type==='provider_clock:publish')
    .map(row=>[row.id,row.ready_virtual_ms,row.provider_model_compensated_ms]),
  [['advisor',300,400],['strategy',300,600],['upgrade',300,340]]);
  assert.equal(h.clock.snapshot().virtual_ms,300);
  assert.deepEqual(h.applied,[{id:'upgrade',frame:18}]);
});

test('a fractional dispatch carries its exact virtual time into the next effective delay',async()=>{
  const h=harness();
  await h.request('fractional','micro',7.5);
  assert.equal((await h.ack('fractional')).applied_tick,1);
  await h.request('under-cap','micro',270);
  const report=h.trace.find(row=>row.type==='provider_clock:reported'&&row.id==='under-cap');
  assert.equal(report.dispatch_virtual_ms,7.5);
  assert.equal(report.ready_virtual_ms,277.5);
  assert.equal(h.clock.snapshot().frame,16);
  assert.equal((await h.ack('under-cap')).applied_tick,17);
});

test('an auxiliary that misses its batch retains its due time without rewinding the shared clock',async()=>{
  const h=harness();
  let releaseMain,releaseAux;
  const main=h.request('first','micro',640,undefined,new Promise(resolve=>{releaseMain=resolve;}));
  await new Promise(setImmediate);
  const aux=h.request('late','strategy',50,undefined,new Promise(resolve=>{releaseAux=resolve;}));
  releaseMain();
  await main;
  await h.ack('first');
  assert.equal(h.clock.snapshot().virtual_ms,300);
  releaseAux();
  await h.request('second','micro',100);
  await aux;
  await h.ack('second');
  const late=h.trace.find(row=>row.type==='provider_clock:publish'&&row.id==='late');
  assert.deepEqual([late.dispatch_virtual_ms,late.ready_virtual_ms,late.virtual_ms,late.frame],[0,50,300,18]);
  assert.ok(h.trace.every((row,index)=>index===0||row.virtual_ms>=h.trace[index-1].virtual_ms));
  assert.deepEqual(h.applied.map(row=>row.frame),[18,24]);
});

test('terminal stepping cancels a capped reply before its target action frame',async()=>{
  const events=[];
  const clock=createProviderClock({trace:event=>events.push(event),
    async step(target){assert.equal(target,17);return {relative_tick:9,terminal:true};}});
  await assert.rejects(timedProviderResult(clock,{id:'ends',role:'micro',observation:{tick:0}},async()=>({
    backend_metadata:{upstream_nace_evaluation_time_ms:640},
  })),{name:'AbortError'});
  assert.equal(clock.snapshot().frame,9);
  assert.equal(clock.snapshot().terminal,true);
  assert.ok(!events.some(event=>event.type==='provider_clock:publish'));
  const terminal=events.find(event=>event.type==='provider_clock:cancelled');
  assert.deepEqual([terminal.provider_processing_ms,terminal.effective_provider_processing_ms,
    terminal.provider_model_compensated_ms],[640,300,340]);
});

test('a failed micro or unclockable upgrade remains terminal and drops a late advisor reply',async()=>{
  for(const role of ['micro','upgrade']){
    const h=harness();
    let completeAdvisor;
    const wait=new Promise(resolve=>{completeAdvisor=resolve;});
    const late=assert.rejects(h.request('late','advisor',70,undefined,wait),{name:'AbortError'});
    const cause=Error('Failed foreground transport');
    const main=role==='micro'
      ? h.request('main',role,450,undefined,Promise.reject(cause))
      : h.request('main',role,null);
    await assert.rejects(main,{name:'AbortError'});
    completeAdvisor();
    await late;
    await new Promise(setImmediate);
    assert.equal(h.clock.snapshot().terminal,true);
    assert.equal(h.clock.snapshot().pending,0);
    assert.equal(h.clock.snapshot().frame,0);
    assert.deepEqual(h.applied,[]);
    assert.equal(h.faults.length,1);
    assert.match(h.faults[0].message,role==='micro'?/Failed foreground transport/:/缺少 upgrade/);
    assert.equal(h.trace.filter(row=>['provider_clock:reported','provider_clock:publish','provider_clock:auxiliary_failed'].includes(row.type)).length,0);
  }
});

test('a cancelled auxiliary ignores a late result without stopping current or future main actions',async()=>{
  const h=harness();
  const controller=new AbortController();
  let complete;
  const late=new Promise(resolve=>{complete=resolve;});
  const advisor=assert.rejects(h.request('cancelled-advisor','advisor',80,controller.signal,late),{name:'AbortError'});
  controller.abort();
  complete();
  await advisor;
  await h.request('first-micro','micro',120);
  await h.ack('first-micro');
  await h.request('second-micro','micro',120);
  await h.ack('second-micro');
  assert.equal(h.clock.snapshot().frame,15);
  assert.equal(h.clock.snapshot().pending,0);
  assert.deepEqual(h.faults,[]);
  assert.deepEqual(h.trace.filter(row=>row.type==='provider_clock:publish').map(row=>row.id),['first-micro','second-micro']);
});

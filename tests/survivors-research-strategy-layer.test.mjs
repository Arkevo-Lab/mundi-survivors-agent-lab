import test from 'node:test';
import assert from 'node:assert/strict';
import {createStrategyMemory} from '../src/client/survivors-research/models/strategy-memory.js';
import {createStrategyScheduler} from '../src/client/survivors-research/models/strategy-scheduler.js';
import {parseStrategy} from '../src/client/survivors-research/models/action-strategy.js';
const sample = (tick,run_id='r') => ({observation:{tick,run_id,observation_id:`obs-${tick}`,sampled_at_ms:tick,player:{hp:100}},
  frame:{tick,player:{x:tick/10,y:0},gemsCollected:Math.floor(tick/100)},hitsTaken:Math.floor(tick/300)});
const text=JSON.stringify({schema:'survivors-strategy-v1',approach:'创造安全空间并收集',phase:'收集',
  transition:'道路持续受阻时调整',success_signal:'经验增加',failure_signal:'受击增加'});
test('strategy memory bounds public history and remaps restored run',()=>{
  const memory=createStrategyMemory();
  for (const tick of [0,100,600,700]) assert.ok(memory.observe(sample(tick)));
  const s=memory.snapshot(); assert.equal(s.from_tick,100); assert.equal(s.coverage_ticks,600);
  assert.equal(s.displacement.dx,60); assert.equal(s.pickups_delta,6);assert.equal(s.hits_delta,2);
  const restored=createStrategyMemory();restored.importState(memory.exportState(),'branch');
  assert.equal(restored.snapshot().run_id,'branch');assert.equal(restored.snapshot().from_tick,100);
  assert.equal(restored.observe(sample(699,'branch')),false);
});
test('strategy schema rejects extra fields and malformed text',()=>{
  assert.equal(parseStrategy(text).phase,'收集');
  for(const raw of ['```json\n'+text+'\n```',JSON.stringify({...JSON.parse(text),actions:['up']})]) assert.throws(()=>parseStrategy(raw));
});
test('flagship strategy changes only generation settings, preserving mini input and prompt',async()=>{
  const {strategyModelInput}=await import('../src/client/survivors-research/models/action-strategy.js');
  const {STRATEGY_CONFIG}=await import('../src/client/survivors-research/models/strategy.js');
  const chunk=(name,data)=>{const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(name,4);data.copy(out,8);return out;};
  const header=Buffer.alloc(13);header.writeUInt32BE(480,0);header.writeUInt32BE(270,4);
  const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',Buffer.from([0])),chunk('IEND',Buffer.alloc(0))]);
  const observation={schema:'survivors-observation-v1',run_id:'r',observation_id:'o',tick:20,terminal:false,profile:'state-detail-v1',player:{movement:[0,0]}};
  const history={schema:'survivors-strategy-history-v1',run_id:'r',from_tick:20,to_tick:20,coverage_ticks:0,window_ticks:600,displacement:{dx:0,dy:0},hp_delta:0,hits_delta:0,pickups_delta:0,action_counts:{},trajectory:[{tick:20,dx:0,dy:0}]};
  const args={schema:'survivors-strategy-input-v2',observation,history,prior_strategy:null,
    image:{profile:'structured-v1',tick:20,mime_type:'image/png',data_url:'data:image/png;base64,'+png.toString('base64')}};
  const original=strategyModelInput('gpt-5.4-mini',args), flagship=strategyModelInput('gpt-6.1-terra',args);
  assert.deepEqual(flagship.messages,original.messages);
  assert.deepEqual({...flagship,messages:undefined},{model:'gpt-6.1-terra',response_format:{type:'json_object'},
    max_completion_tokens:8192,stream:false,reasoning_effort:'high',messages:undefined});
  assert.equal(original.reasoning_effort,'none');assert.equal(original.max_completion_tokens,1024);
  assert.throws(()=>strategyModelInput('unexpected-model',args),/Invalid strategy public input/);
  assert.deepEqual([STRATEGY_CONFIG.model,STRATEGY_CONFIG.reasoning_effort,STRATEGY_CONFIG.max_completion_tokens,
    STRATEGY_CONFIG.server_timeout_ms,STRATEGY_CONFIG.timeout_ms],['gpt-6.1-terra','high',8192,60000,65000]);
});
test('asynchronous scheduler runs once per 600 ticks, retains strategy on failure and remaps age',async()=>{
  const memory=createStrategyMemory(), events=[]; let resolve,requests=0,clock=100; const priors=[];
  const scheduler=createStrategyScheduler({memory,now:()=>++clock,id:()=>`s${requests+1}`,
    advise:({prior_strategy})=>{priors.push(prior_strategy);requests++;return new Promise(r=>{resolve=r;});}});
  const emit=e=>events.push(e), s=sample(50); scheduler.observe({...s,emit});
  assert.equal(scheduler.dispatch({...s,image:{tick:50,mime_type:'image/png'},emit}),true);
  assert.equal(scheduler.dispatch({...s,image:{tick:50,mime_type:'image/png'},emit}),false);
  await Promise.resolve();resolve({content:text});await new Promise(r=>setImmediate(r));
  const s1=sample(60);assert.equal(scheduler.observe({...s1,emit}).strategy_id,'s1');
  assert.equal(scheduler.current(70).age_ticks,20);
  assert.equal(scheduler.dispatch({...s1,image:{tick:60,mime_type:'image/png'},emit}),false);
  const s2=sample(650);scheduler.observe({...s2,emit});
  assert.equal(scheduler.dispatch({...s2,image:{tick:650,mime_type:'image/png'},emit}),true);
  await Promise.resolve();assert.equal(priors[0],null);assert.equal(priors[1].strategy_id,'s1');assert.equal(priors[1].age_ticks,600);resolve({content:'invalid'});await new Promise(r=>setImmediate(r));
  const s3=sample(660);assert.equal(scheduler.observe({...s3,emit}).strategy_id,'s1');
  assert.equal(events.filter(e=>e.type==='strategy:attempt').at(-1).status,'invalid');
  assert.equal(scheduler.current(660).age_ticks,610);
  await scheduler.finish(emit);
});
test('finishing aborts in-flight strategy without publishing late result',async()=>{
  const memory=createStrategyMemory(),events=[];let resolve;
  const scheduler=createStrategyScheduler({memory,id:()=> 'unfinished',advise:()=>new Promise(r=>{resolve=r;})});
  const emit=e=>events.push(e), s=sample(0);scheduler.observe({...s,emit});
  scheduler.dispatch({...s,image:{tick:0,mime_type:'image/png'},emit});await Promise.resolve();
  const finish=scheduler.finish(emit);resolve({content:text});await finish;
  assert.equal(events.filter(e=>e.type==='strategy:published').length,0);
  assert.equal(events.find(e=>e.type==='strategy:attempt').status,'cancelled');
});

test('node strategy retains only accepted prefix and marks legacy coverage',async()=>{
  const {createResumeContext,restoreNodeModel}=await import('../src/client/survivors-research/models/node-context.js');
  const row=tick=>{const s=sample(tick);return {observation:{...s.observation,loot:[],enemies:[],coverage:{loot:{visible:0,sent:0,truncated:false}}},frame:s.frame,hitsTaken:s.hitsTaken};};
  const accepted={decision_id:'prior',source_tick:0,accepted_tick:10,strategy:JSON.parse(text)};
  const context=createResumeContext({source_run_id:'r',source_mode:'advisory-cardinal-v2',base_tick:20,
    context_samples:[row(0),row(10),row(20),row(30)],accepted_strategies:[accepted,{...accepted,decision_id:'future',accepted_tick:30}]});
  const restored=restoreNodeModel({context,nodeTick:20,branchRunId:'branch',targetMode:'advisory-cardinal-v2',enableStrategy:true});
  assert.equal(restored.strategyRestore.active.strategy_id,'prior');
  assert.equal(restored.strategyRestore.nextTick,20);
  assert.equal(restored.strategyMemory.snapshot().run_id,'branch');
  const legacy=structuredClone(context);delete legacy.strategy;
  assert.ok(restoreNodeModel({context:legacy,nodeTick:20,branchRunId:'b',targetMode:'advisory-cardinal-v2',enableStrategy:true}).contextReport.missing.includes('strategy_history_unavailable'));
  const bad=structuredClone(context);bad.strategy.active_strategy.accepted_tick=21;
  assert.throws(()=>restoreNodeModel({context:bad,nodeTick:20,branchRunId:'b',targetMode:'advisory-cardinal-v2',enableStrategy:true}));
});


test('trajectory retains an observed out-and-return despite zero net displacement',()=>{
  const memory=createStrategyMemory();
  for (const [tick,x] of [[0,0],[10,3],[20,0]]) {const s=sample(tick);s.frame.player.x=x;assert.ok(memory.observe(s));}
  const history=memory.snapshot();assert.equal(history.displacement.dx,0);
  assert.deepEqual(history.trajectory,[{tick:0,dx:0,dy:0},{tick:10,dx:3,dy:0},{tick:20,dx:0,dy:0}]);
  const clone=createStrategyMemory();clone.importState(memory.exportState(),'branch');
  assert.deepEqual(clone.snapshot().trajectory,history.trajectory);
});

test('scheduler never dispatches on terminal sample or before exact 600 tick cadence',async()=>{
  const memory=createStrategyMemory(),events=[];let requests=0;
  const scheduler=createStrategyScheduler({memory,id:()=>String(++requests),advise:async()=>({content:text})});
  const emit=e=>events.push(e), start=sample(10);scheduler.observe({...start,emit});
  assert.ok(scheduler.dispatch({...start,image:{tick:10,mime_type:'image/png'},emit}));
  await new Promise(r=>setImmediate(r));
  const before=sample(609);scheduler.observe({...before,emit});
  assert.equal(scheduler.dispatch({...before,image:{tick:609,mime_type:'image/png'},emit}),false);
  const terminal=sample(610);terminal.observation.terminal=true;scheduler.observe({...terminal,emit});
  assert.equal(scheduler.dispatch({...terminal,image:{tick:610,mime_type:'image/png'},emit}),false);
  assert.equal(requests,1);
  await scheduler.finish(emit);
});

test('failed strategy HTTP trace survives scheduler and a missing response remains unknown',async t=>{
  const {createStrategist}=await import('../src/client/survivors-research/models/strategy.js');
  const trace={input:{messages:[]},raw_response:'{}',usage:{input_tokens:12},backend_metadata:{upstream_dispatched:true,upstream_request_prepare_ms:4,upstream_request_serialize_ms:2}};
  let variant='timeout';
  t.mock.method(globalThis,'fetch',async()=>{
    if(variant==='unanswered') throw new Error('network disconnected');
    return Response.json({error:{code:variant},trace},{status:variant==='timeout'?504:502});
  });
  for(const type of ['timeout','provider_error','unanswered']) {
    variant=type;const events=[],memory=createStrategyMemory();
    const scheduler=createStrategyScheduler({memory,id:()=>type,advise:createStrategist().advise});
    const s=sample(0),emit=e=>events.push(e);scheduler.observe({...s,emit});
    scheduler.dispatch({...s,image:{tick:0,mime_type:'image/png'},emit});
    await new Promise(r=>setImmediate(r));scheduler.observe({...sample(1),emit});
    const attempt=events.find(e=>e.type==='strategy:attempt');
    assert.ok(attempt);assert.equal(attempt.status,type==='timeout'?'timeout':'failed');
    if(type==='unanswered') {
      assert.equal(attempt.backend_metadata,null);assert.equal(attempt.usage,null);
    } else {
      assert.deepEqual(attempt.input,trace.input);assert.deepEqual(attempt.usage,trace.usage);
      assert.deepEqual(attempt.backend_metadata,trace.backend_metadata);assert.equal(attempt.raw_response,'{}');
    }
    assert.ok(Number.isFinite(attempt.timings.transport_finished_at_ms));
    await scheduler.finish(emit);
  }
});

test('strategy adapter completes timing on malformed, refused, and truncated responses',async t=>{
  const {createStrategist}=await import('../src/client/survivors-research/models/strategy.js');
  let raw='not json';let envelope='normal';
  t.mock.method(globalThis,'fetch',async()=>envelope==='bad-envelope' ? new Response('{', {status:200}) : Response.json({raw_response:raw}));
  const call=()=>createStrategist().advise({observation:sample(0).observation,image:{},history:{},prior_strategy:null,signal:new AbortController().signal});
  for(const [name,value] of [['malformed','not json'],['refusal',JSON.stringify({choices:[{message:{refusal:'declined'}}]})],
    ['truncated',JSON.stringify({choices:[{finish_reason:'length',message:{content:''}}]})],
    ['bad-fields',JSON.stringify({choices:[{message:{content:'{}'}}]})]]) {
    raw=value;
    await assert.rejects(call(),error=>{assert.ok(Number.isFinite(error.details.timings.output_parse_finished_at_ms),name);assert.ok(error.details.timings.output_parse_ms>=0);return true;});
  }
  envelope='bad-envelope';
  await assert.rejects(call(),error=>{assert.ok(Number.isFinite(error.details.timings.response_decode_finished_at_ms));assert.ok(error.details.timings.response_decode_ms>=0);return true;});
});


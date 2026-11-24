import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdvisorMemory} from '../src/client/survivors-research/advisor-memory.js';
import {createAdvisorScheduler} from '../src/client/survivors-research/models/advisor-scheduler.js';
import {createControlBrief,validControlBrief} from '../src/client/survivors-research/models/control-brief.js';
import {validCardinalContext} from '../src/client/survivors-research/models/action-cardinal.js';
import {projectLocalMicro} from '../src/client/survivors-research/models/local-micro.js';
import {drexPathMicroInput,providerDirectionInput} from '../src/client/survivors-research/models/local-path-micro.js';
import {R160_DIRECTION_PROMPT,R160_MICRO_PROMPT,R160_STRATEGY_PROMPT} from '../src/client/survivors-research/models/r160-prompts.js';
const strategy=(id,source,accepted,tick)=>({strategy_id:id,source_tick:source,accepted_tick:accepted,age_ticks:tick-source,
  strategy:{schema:'survivors-strategy-v1',approach:'拉开后保持攻击机会',phase:'准备攻击',transition:'安全后回收',success_signal:'经验增加',failure_signal:'接触增多'}});
const obs=tick=>({run_id:'r',observation_id:'obs-'+tick,tick,sampled_at_ms:tick,terminal:false,player:{hp:100,speed:3.2,movement:[0,0],gem_pickup_radius:.7},
  loot:[],enemies:[],hazards:[],coverage:{loot:{visible:0,sent:0,truncated:false}}});
const frame=tick=>({tick,sampled_at_ms:tick,player:{x:0,y:0},gemsCollected:0});
test('accepted direction retains exactly the strategy seen at its own dispatch',async()=>{
  const memory=createAdvisorMemory(),events=[],calls=[];let finishSecond;
  const clock={request:x=>x.load()};
  const advisor=createAdvisorScheduler({memory,cardinal:true,provider:'nace-decisions',advise:async x=>{
    calls.push(x);if(calls.length===2)return new Promise(resolve=>{finishSecond=resolve;});
    return {guidance:{target_id:null,heading:'up'},backend_metadata:{upstream_nace_evaluation_time_ms:100}};}});
  const emit=e=>events.push(e),s1=strategy('old',0,0,0);
  advisor.observe({observation:obs(0),frame:frame(0),hitsTaken:0,emit});
  advisor.dispatch({observation:obs(0),directionObservation:obs(0),candidates:[],image:{tick:0,mime_type:'image/png'},budget:0,
    strategy:s1,control_brief_mode:'control-brief-v1',providerClock:clock,emit});
  await new Promise(resolve=>setImmediate(resolve));
  const hint=advisor.observe({observation:obs(18),frame:frame(18),hitsTaken:0,emit});
  assert.equal(calls[0].strategy_context.strategy_id,'old');assert.equal(hint.control_brief.strategy_id,'old');
  assert.equal(hint.control_brief.age_ticks,18);assert.equal(hint.control_brief.approach,s1.strategy.approach);
  assert.equal(validCardinalContext('cardinal-micro',hint,obs(18)),true);
  const next=advisor.observe({observation:obs(30),frame:frame(30),hitsTaken:0,emit});
  assert.equal(next.control_brief.strategy_id,'old');assert.equal(next.control_brief.age_ticks,30);
  const projection=projectLocalMicro({observation:obs(30),advisorHint:next,targetHandoff:true});
  assert.deepEqual(projection.guidance.control_brief,next.control_brief);
  advisor.observe({observation:obs(60),frame:frame(60),hitsTaken:0,emit});
  advisor.dispatch({observation:obs(60),directionObservation:obs(60),candidates:[],image:{tick:60,mime_type:'image/png'},budget:0,
    strategy:strategy('new',40,50,60),control_brief_mode:'control-brief-v1',providerClock:clock,emit});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(advisor.observe({observation:obs(70),frame:frame(70),hitsTaken:0,emit}).control_brief.strategy_id,'old');
  finishSecond({guidance:{target_id:null,heading:'right'},backend_metadata:{upstream_nace_evaluation_time_ms:100}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(advisor.observe({observation:obs(78),frame:frame(78),hitsTaken:0,emit}).control_brief.strategy_id,'new');
  assert.equal(advisor.observe({observation:obs(180),frame:frame(180),hitsTaken:0,emit}),null);
  await advisor.finish(emit);
});
test('control brief validation checks provenance and does not invent a missing strategy',()=>{
  assert.equal(createControlBrief(null,20),null);
  const b=createControlBrief(strategy('s',10,15,20),20);assert.ok(validControlBrief(b,20));
  assert.equal(validControlBrief({...b,age_ticks:11},20),false);
  assert.equal(validControlBrief({...b,accepted_tick:21},20),false);
});
test('brief mode uses independent complete prompts with unchanged choices and old mode intact',()=>{
  const q={name:'guidance',choices:['up','down','left','right'].map(x=>({value:'none:'+x,description:x})),instructions:'legacy'};
  const direction=providerDirectionInput({questions:[q]},0,{targetHandoff:true,combatAware:true,briefAware:true});
  assert.equal(direction.questions[0].instructions,R160_DIRECTION_PROMPT);assert.equal(direction.questions[0].choices.length,4);
  const state={schema:'survivors-local-micro-v4',tick:20,guidance:{heading:'up'},feedback:{},threats:[]};
  const input={input:[{role:'user',content:[{type:'input_text',text:JSON.stringify(state)},{type:'input_image',image_url:'fixture'},{type:'input_text',text:'fixture'}]}]};
  const profile={phase:1,interval:null,remaining_plan:{status:'idle',as_of_tick:20,segments:[]},recent_micro_processing:null,provider_processing_cap_ms:300};
  const old=drexPathMicroInput(input,profile,'hold-sequence-coverage-v1');
  const current=drexPathMicroInput(input,{...profile,brief_mode:'control-brief-v1'},'hold-sequence-coverage-v1');
  assert.equal(current.questions[0].instructions,R160_MICRO_PROMPT);assert.deepEqual(current.questions[0].choices,old.questions[0].choices);
  assert.equal(current.questions[0].choices.length,65);assert.doesNotMatch(current.questions[0].instructions,/start returning within this plan/);
  assert.match(R160_STRATEGY_PROMPT,/already too far away/);assert.match(R160_MICRO_PROMPT,/empty local threat list/);
  assert.match(R160_MICRO_PROMPT,/hypot\(dx,dy\)-radius/);
  assert.match(R160_MICRO_PROMPT,/several short waits/);
  assert.match(R160_MICRO_PROMPT,/ages 1–11 are active/);
  for(const prompt of [R160_STRATEGY_PROMPT,R160_DIRECTION_PROMPT,R160_MICRO_PROMPT])
    assert.doesNotMatch(prompt,/before (?:another response or useful strike|the next (?:effective )?response or (?:useful )?strike)/);
});

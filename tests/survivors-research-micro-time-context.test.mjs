import assert from 'node:assert/strict';
import test from 'node:test';
import {createExecutionWindow} from '../src/client/survivors-research/provider-execution-window.js';
import {runAgent} from '../src/client/survivors-research/agent-loop.js';
import {DREX_CAPPED_TIMING_PROVIDER_INPUT_PROFILE,drexPathMicroInput} from '../src/client/survivors-research/models/local-path-micro.js';
import {NACE_PROVIDER} from '../src/client/survivors-research/models/nace-decisions.js';
import {ResearchModelError} from '../src/client/survivors-research/models/common.js';
import {encodeOpaquePng,pngImage} from '../scripts/survivors-research/provider-clock-png.mjs';
import {RESEARCH_SEQUENCE_PROFILE,researchCandidates} from '../src/shared/survivors-research-contract.js';

const move=direction=>'move:'+direction+':hold:100';
const source=(tick=0)=>({tick,config:{action_profile:RESEARCH_SEQUENCE_PROFILE}});
const node=(tick,harness)=>({source:source(tick),facts:{hits_taken:0},node_state:{harness}});
const still=()=>node(0,{movement:{entry:{id:'stop'}},movementPlan:[],planInfo:null});
const ack=(tick,action_ids)=>({type:'action_applied',tick,applied_tick:tick,action_id:action_ids[0],action_ids});
const end=(tick,started_tick,direction,reason='hold-expired')=>({type:'movement_ended',tick,
  started_tick,action_id:move(direction),reason});
const endPlan=(tick,started_tick,reason)=>({type:'movement_plan_ended',tick,started_tick,reason});
const observe=(window,tick,{mark=true,terminal=false}={})=>{
  const observation_id='obs-'+tick;
  if(mark)window.record({type:'observation_sampled',tick,observation_id,terminal});
  return window.observe({tick,observation_id,terminal},{includeRemainingPlan:true}).remaining_plan;
};

test('remaining plan uses the first same-frame watermark and counts only future ticks',()=>{
  const win=createExecutionWindow(still());
  assert.equal(observe(win,0,{mark:false}).status,'unknown');
  assert.deepEqual(observe(win,0),{as_of_tick:0,status:'idle',segments:[]});
  win.record(ack(1,['right','up','left'].map(move)));
  assert.deepEqual(observe(win,1).segments,[{direction:'right',remaining_ticks:5},{direction:'up',remaining_ticks:6},{direction:'left',remaining_ticks:6}]);
  win.record(end(6,1,'right'));
  assert.deepEqual(observe(win,6).segments,[{direction:'up',remaining_ticks:6},{direction:'left',remaining_ticks:6}]);

  const late=createExecutionWindow(still());
  assert.equal(observe(late,1).status,'idle');
  late.record(ack(1,[move('right')]));
  assert.equal(observe(late,1).status,'idle');
});

test('replacement, upgrade completion and terminal observation close the old movement remainder',()=>{
  const win=createExecutionWindow(still());
  win.record(ack(1,['right','up','left'].map(move)));
  win.record(ack(2,['down','down','down'].map(move)));
  win.record(end(2,1,'right','replaced'));
  win.record(endPlan(2,1,'replaced'));
  assert.deepEqual(observe(win,2).segments.map(s=>s.remaining_ticks),[5,6,6]);
  assert.ok(observe(win,2).segments.every(s=>s.direction==='down'));
  win.record(ack(3,['choose:level-2:whip']));
  win.record(end(3,2,'down','replaced'));
  win.record(endPlan(3,2,'replaced'));
  win.record({type:'upgrade_selected',tick:3,offer_id:'level-2',option_id:'whip'});
  assert.equal(observe(win,3).status,'idle');
  win.record(ack(4,[move('up')]));
  win.record(end(9,4,'up'));
  win.record(endPlan(9,4,'completed'));
  assert.equal(observe(win,9).status,'idle');
  win.record(ack(10,[move('down')]));
  assert.equal(observe(win,10,{terminal:true}).status,'idle');
});

test('restored plans are known only with a complete trustworthy snapshot and event prefix',()=>{
  const complete=node(20,{movement:{entry:{id:move('right'),kind:'hold'},startTick:18,deadline:23},
    movementPlan:[{entry:{id:move('up'),kind:'hold'},duration:6}],planInfo:{started_tick:18}});
  assert.deepEqual(observe(createExecutionWindow(complete),20).segments,
    [{direction:'right',remaining_ticks:3},{direction:'up',remaining_ticks:6}]);
  const legacy=structuredClone(complete);
  delete legacy.node_state.harness.planInfo;
  assert.equal(observe(createExecutionWindow(legacy),20).status,'unknown');
  const missingReceipt=createExecutionWindow(complete);
  assert.equal(observe(missingReceipt,23).status,'unknown');
});

test('Drex compiles the previous plan and delay estimates with the same 65 path choices',()=>{
  const old={phase:2,interval:null};
  const plan={status:'active',as_of_tick:21,segments:[{direction:'left',remaining_ticks:5}]};
  const estimate={count:2,median_ms:350,min_ms:300,max_ms:400};
  const sample={model:'gpt-6-luna',input:[{role:'user',content:[
    {type:'input_text',text:JSON.stringify({schema:'survivors-local-micro-v3',tick:21,guidance:{heading:'up'},feedback:{},threats:[]})},
    {type:'input_image',image_url:'fixture'},{type:'input_text',text:'fixture'}]}]};
  const timing={...old,remaining_plan:plan,recent_micro_processing:estimate};
  const input=drexPathMicroInput(sample,timing),projection=JSON.parse(input.input[0].content[0].text);
  assert.deepEqual(projection.remaining_plan,plan);
  assert.deepEqual(projection.recent_micro_processing,estimate);
  assert.deepEqual(input.questions[0].choices,drexPathMicroInput(sample,old).questions[0].choices);
  assert.equal(input.questions[0].choices.length,65);
  assert.match(input.questions[0].instructions,/first create sideways clearance, then turn back/);
  assert.match(input.questions[0].instructions,/cannot change movement during the current wait/);
  assert.ok(!input.questions[0].instructions.includes('请严格优先'));
  assert.equal(Object.hasOwn(projection,'provider_processing_cap_ms'),false);
  const capped={...timing,provider_processing_cap_ms:300,recent_micro_processing:{count:2,median_ms:250,min_ms:200,max_ms:300}};
  const capInput=drexPathMicroInput(sample,capped);
  const capState=JSON.parse(capInput.input[0].content[0].text);
  assert.deepEqual([capState.provider_processing_cap_ms,capState.recent_micro_processing],[300,capped.recent_micro_processing]);
  assert.deepEqual(capInput.questions[0].choices,input.questions[0].choices);
  assert.match(capInput.questions[0].instructions,/at most provider_processing_cap_ms per request/);
  assert.match(capInput.questions[0].instructions,/network or framework waits are paused/);
  assert.throws(()=>drexPathMicroInput(sample,{...capped,provider_processing_cap_ms:400}),/Invalid micro timing context/);
  assert.throws(()=>drexPathMicroInput(sample,{...capped,recent_micro_processing:estimate}),/Invalid micro timing context/);
  for(const invalid of [
    {...timing,remaining_plan:{...plan,as_of_tick:22}},
    {...timing,remaining_plan:{...plan,status:'unknown'}},
    {...timing,remaining_plan:{...plan,segments:[{direction:'up',remaining_ticks:19}]}},
    {...timing,recent_micro_processing:{...estimate,count:6}},
    {...timing,recent_micro_processing:{...estimate,wall_ms:700}},
    {...old,remaining_plan:plan},
  ])assert.throws(()=>drexPathMicroInput(sample,invalid),/Invalid micro timing context/);
});

test('agent caps each earlier successful micro time before summarizing the latest five',async()=>{
  const data=[200,400,'failed',300,'upgrade',400,500,600,700],history=[],events=[];
  let row=0;
  const original=encodeOpaquePng(Buffer.alloc(480*270*4,255));
  const visual=(tick)=>({...pngImage(original,tick),profile:'structured-v1'});
  const offer={offer_id:'level-2',options:[{option_id:'whip-level',name:'Fixture',description:'Fixture'}]};
  const model={config:{provider_input_profile:DREX_CAPPED_TIMING_PROVIDER_INPUT_PROFILE},
    prepareLocalMicro:()=>({local_projection:{}}),
    async decide({observation,provider_profile}){
      const elapsed=data[observation.tick];
      const action=elapsed==='upgrade'?'choose:level-2:whip-level':move('right');
      if(elapsed!=='upgrade'){
        assert.equal(provider_profile.provider_processing_cap_ms,300);
        history.push(provider_profile.recent_micro_processing);
      }
      if(elapsed==='failed')throw new ResearchModelError('timeout','Fixture timeout',{backend_metadata:{
        provider:NACE_PROVIDER,upstream_status:200,upstream_nace_evaluation_time_ms:99000}});
      return {action_id:action,action_ids:[action],backend_metadata:{provider:NACE_PROVIDER,
        upstream_status:200,upstream_nace_evaluation_time_ms:elapsed==='upgrade'?99000:elapsed,upstream_round_trip_ms:12000}};
    }};
  const clock={snapshot:()=>({terminal:false}),request:request=>request.load()};
  await runAgent({model,providerClock:clock,actionProfile:RESEARCH_SEQUENCE_PROFILE,visualProfile:'structured-v1',onEvent:event=>events.push(event),
    prepareImage:({observation})=>visual(observation.tick),
    prepareLocalMicroImage:()=>pngImage(original,row-1),
    executedMovement:({tick})=>({interval:null,remaining_plan:{status:'idle',as_of_tick:tick,segments:[]}}),
    observe:async()=>{
      if(row>=data.length)return {terminal:true};
      const tick=row++,upgrade_offer=data[tick]==='upgrade'?offer:undefined;
      return {visual_frame:{tick},observation:{tick,observation_id:'obs-'+tick,upgrade_offer},
        candidates:researchCandidates(RESEARCH_SEQUENCE_PROFILE,upgrade_offer)};
    },submit:async ({observation_id,action_ids})=>({applied_tick:Number(observation_id.slice(4))+1,action_ids})});
  assert.deepEqual(history,[
    null,{count:1,median_ms:200,min_ms:200,max_ms:200},{count:2,median_ms:250,min_ms:200,max_ms:300},
    {count:2,median_ms:250,min_ms:200,max_ms:300},{count:3,median_ms:300,min_ms:200,max_ms:300},
    {count:4,median_ms:300,min_ms:200,max_ms:300},{count:5,median_ms:300,min_ms:200,max_ms:300},
    {count:5,median_ms:300,min_ms:300,max_ms:300},
  ]);
  assert.ok(events.some(event=>event.type==='model:attempt'&&event.backend_metadata.upstream_nace_evaluation_time_ms===600));
});

test('600 ms action profile runs 6/6/24 ticks, can be interrupted, and replays independently', async () => {
  const {RESEARCH_COVERAGE_SEQUENCE_PROFILE,RESEARCH_SCHEMA,RESEARCH_ENGINE,RESEARCH_RULES,researchPlanValidator}=
    await import('../src/shared/survivors-research-contract.js');
  const {ResearchWorld,validateConfig}=await import('../src/client/survivors-research/sim-world.js');
  const {replayResearch}=await import('../src/client/survivors-research/sim-replay.js');
  const legacy=validateConfig({seed:11,max_ticks:60,action_profile:RESEARCH_SEQUENCE_PROFILE});
  const coverage=validateConfig({...legacy,action_profile:RESEARCH_COVERAGE_SEQUENCE_PROFILE});
  const first=['right','up','left'].map(move),tail='move:left:hold:400';
  const extended=[first[0],first[1],tail];
  const validator=researchPlanValidator(coverage.action_profile);
  assert.ok(validator(extended[0],extended));
  assert.ok(!validator(first[0],first));
  assert.ok(!validator(tail,[tail]));
  assert.ok(!researchPlanValidator(legacy.action_profile)(extended[0],extended));
  assert.equal(researchCandidates(legacy.action_profile).some(({id})=>id===tail),false);

  for (const config of [legacy,coverage]) {
    const isCoverage=config===coverage;
    const world=new ResearchWorld(config),initial_state=world.initialState();
    const receiptNode=still();receiptNode.source.config=config;
    const execution=createExecutionWindow(receiptNode);
    const action_ids=isCoverage?extended:first;
    const actions=[{applied_tick:1,action_id:action_ids[0],action_ids}];
    if(isCoverage)actions.push({applied_tick:29,action_id:'stop',action_ids:['stop']});
    const spans=[];
    for(let tick=1;tick<=39;tick++){
      const action=actions.find(row=>row.applied_tick===tick);
      if(action)execution.record(ack(tick,action.action_ids));
      for(const event of world.advance(action?.action_id,action?.action_ids)){
        execution.record(event);
        if(event.type==='movement_ended')spans.push([event.action_id,event.started_tick,event.tick,event.reason]);
      }
      if(isCoverage&&tick===12)assert.deepEqual(observe(execution,tick).segments,[{direction:'left',remaining_ticks:24}]);
      if(isCoverage&&tick===29)assert.equal(observe(execution,tick).status,'idle');
    }
    assert.deepEqual(spans,[
      [first[0],1,6,'hold-expired'],[first[1],7,12,'hold-expired'],
      isCoverage?[tail,13,29,'stopped']:[first[2],13,18,'hold-expired'],
    ]);
    world.finish('stopped');
    const result={schema:RESEARCH_SCHEMA,engine:RESEARCH_ENGINE,rules:RESEARCH_RULES,status:'ended',
      run_id:'coverage-fixture',...world.performanceResult()};
    const replay=await replayResearch({config,initial_state,actions,result});
    assert.equal(replay.consistent,true);
  }
});

test('coverage node derivation preserves the checkpoint and rejects old armed plans', async () => {
  const {RESEARCH_COVERAGE_SEQUENCE_PROFILE}=await import('../src/shared/survivors-research-contract.js');
  const {ResearchWorld,resumeConfig,resumeInitialState,validateConfig}=await import('../src/client/survivors-research/sim-world.js');
  const {NODE_SCHEMA,deriveCoverageResumeNode,verifyResumeNode}=await import('../src/client/survivors-research/resume-node.js');
  const {hashJSON}=await import('../src/client/survivors-research/evidence.js');
  const config=validateConfig({seed:11,max_ticks:600,action_profile:RESEARCH_SEQUENCE_PROFILE});
  const world=new ResearchWorld(config);
  const createNode=async()=>{
    const snapshot=world.snapshot(),tick=snapshot.tick,run_id='coverage-parent';
    const node_state=world.resumeNode(run_id);
    const payload={schema:NODE_SCHEMA,node_id:'a'.repeat(64),node_state,snapshot,
      source:{run_id,tick,config,state_hash:node_state.node_hash},context:{source_run_id:run_id,base_tick:tick},
      facts:{hp:snapshot.player.hp,gems_collected:snapshot.player.gemsCollected,hits_taken:snapshot.hits_taken}};
    return {...payload,integrity:await hashJSON(payload)};
  };
  world.advance();
  const parent=await createNode(),unchanged=structuredClone(parent);
  const proof={parentFileSha256:'b'.repeat(64)};
  const migrated=await deriveCoverageResumeNode(parent,proof);
  await verifyResumeNode(migrated);
  assert.deepEqual(migrated,await deriveCoverageResumeNode(parent,proof));
  assert.deepEqual(parent,unchanged);
  assert.deepEqual(migrated.node_state.harness,parent.node_state.harness);
  assert.deepEqual(migrated.node_state.engine_state,parent.node_state.engine_state);
  assert.equal(migrated.source.profile_migration.advanced_ticks,0);
  assert.equal(migrated.source.config.action_profile,RESEARCH_COVERAGE_SEQUENCE_PROFILE);
  assert.deepEqual(new ResearchWorld(migrated.source.config,resumeInitialState(migrated.node_state)).snapshot(),parent.snapshot);
  assert.throws(()=>resumeConfig(parent.node_state,{action_profile:RESEARCH_COVERAGE_SEQUENCE_PROFILE}),/source simulation profile/);
  world.advance(move('right'),[move('right')]);
  await assert.rejects(deriveCoverageResumeNode(await createNode(),proof),/不能派生/);
});

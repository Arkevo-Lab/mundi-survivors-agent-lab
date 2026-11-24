import test from 'node:test';
import assert from 'node:assert/strict';
import {createCombatContext,validCombatContext} from '../src/client/survivors-research/models/combat-context.js';
import {runAgent} from '../src/client/survivors-research/agent-loop.js';
import {encodeOpaquePng,pngImage} from '../scripts/survivors-research/provider-clock-png.mjs';
import {RESEARCH_COVERAGE_SEQUENCE_PROFILE,researchCandidates} from '../src/shared/survivors-research-contract.js';
import {drexPathMicroInput} from '../src/client/survivors-research/models/local-path-micro.js';

const range={shape:'rectangle',max_half_width:1.8,max_half_height:1.25,center_forward:1.5,center_y_step:-.53};
const combat={damage:10,range,strikes_per_cycle:2,repeat_ticks:6,direction_mode:'alternating_at_emission',
  cooldown_remaining_ticks:0,pending_strikes:[{index:1,in_ticks:3}],active_strikes:[]};
const frame={tick:20,player:{facing:-1}};
const observation={tick:20,player:{movement:[0,0],weapon_state:[{id:'whip',combat}]}};
test('combat facts preserve the current public rectangular weapon snapshot and distinguish unknown',()=>{
  const x=createCombatContext({observation,frame,providerProcessingCapMs:300});
  assert.ok(validCombatContext(x,20));assert.equal(x.whip.status,'equipped');
  assert.deepEqual(x.whip.range,range);assert.equal(x.whip.cooldown_remaining_ticks,0);
  assert.deepEqual(x.whip.pending_strikes,[{index:1,in_ticks:3}]);assert.equal(x.facing,-1);
  assert.equal(Object.hasOwn(x.whip,'active_strikes'),false);
  const missing=createCombatContext({observation:{tick:20,player:{}},frame});
  const empty=createCombatContext({observation:{tick:20,player:{weapon_state:[]}},frame});
  assert.equal(missing.whip.status,'unknown');assert.equal(empty.whip.status,'not_equipped');
  assert.equal(createCombatContext({observation:{tick:20,player:{weapon_state:[]}},frame:{tick:20,player:{facing:1}}}).facing,null);
  assert.equal(missing.whip.damage,null);assert.equal(empty.whip.damage,null);
  assert.throws(()=>createCombatContext({observation,frame:{...frame,tick:21}}),/same-tick/);
  assert.equal(validCombatContext({...x,tick:21},20),false);
  assert.equal(validCombatContext({...x,whip:{...x.whip,range:{...range,max_half_width:-1}}},20),false);
  assert.equal(validCombatContext({...x,whip:{...x.whip,status:'unknown'}},20),false);
});

test('agent shares one same-frame combat snapshot with upper layers without sending it to micro',async()=>{
  const sent={},png=encodeOpaquePng(Buffer.alloc(480*270*4,255));let calls=0;
  const strategy={observe:()=>null,dispatch:x=>{sent.strategy=x.combat_context;},recordAction(){},async finish(){}};
  const advisor={observe:()=>null,dispatch:x=>{sent.advisor=x.combat_context;},recordAction(){},async finish(){}};
  const model={config:{combat_context_schema:'survivors-combat-context-v1',local_projection_schema:'survivors-local-micro-v4',
      provider_input_profile:'provider-path-micro-local-context-v4'},
    directionObservation:({observation})=>observation,prepareLocalMicro:()=>({local_projection:{}}),
    async decide(args){sent.micro=args;return {action_id:'move:right:hold:100',action_ids:['move:right:hold:100','move:right:hold:100','move:right:hold:400'],
      backend_metadata:{provider:'nace-decisions',upstream_status:200,upstream_nace_evaluation_time_ms:100}};}};
  const clock={snapshot:()=>({terminal:false}),request:x=>x.load()};
  await runAgent({model,advisor,strategy,providerClock:clock,actionProfile:RESEARCH_COVERAGE_SEQUENCE_PROFILE,
    visualProfile:'structured-v1',hitsAtTick:()=>0,onEvent(){},
    observe:async()=>calls++?{terminal:true}:{observation:{...observation,observation_id:'obs-20'},visual_frame:frame,
      candidates:researchCandidates(RESEARCH_COVERAGE_SEQUENCE_PROFILE)},
    prepareImage:()=>({...pngImage(png,20),profile:'structured-v1'}),prepareLocalMicroImage:()=>pngImage(png,20),
    executedMovement:()=>({interval:null,remaining_plan:{status:'idle',as_of_tick:20,segments:[]}}),
    submit:async({action_ids})=>({applied_tick:21,action_ids})});
  assert.deepEqual(sent.strategy,sent.advisor);assert.equal(sent.strategy.tick,20);assert.equal(sent.strategy.facing,-1);
  assert.deepEqual(sent.strategy.whip.range,range);assert.equal(Object.hasOwn(sent.micro,'combat_context'),false);
  assert.deepEqual(sent.micro.observation.player.weapon_state,observation.player.weapon_state);
});

test('combat micro removes the forced immediate return without changing older profiles or choices',()=>{
  const input=schema=>({input:[{role:'user',content:[{type:'input_text',text:JSON.stringify({schema,tick:20,guidance:{heading:'down'},feedback:{},threats:[]})},
    {type:'input_image',image_url:'fixture'},{type:'input_text',text:'fixture'}]}]});
  const profile={phase:1,interval:null,remaining_plan:{status:'idle',as_of_tick:20,segments:[]},recent_micro_processing:null,provider_processing_cap_ms:300};
  const old=drexPathMicroInput(input('survivors-local-micro-v3'),profile,RESEARCH_COVERAGE_SEQUENCE_PROFILE);
  const current=drexPathMicroInput(input('survivors-local-micro-v4'),profile,RESEARCH_COVERAGE_SEQUENCE_PROFILE);
  assert.match(old.questions[0].instructions,/start returning within this plan/);
  assert.doesNotMatch(current.questions[0].instructions,/start returning within this plan/);
  assert.match(current.questions[0].instructions,/One clear short step does not prove the route is open/);
  assert.deepEqual(current.questions[0].choices,old.questions[0].choices);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {drexPathMicroInput,providerDirectionInput} from '../src/client/survivors-research/models/local-path-micro.js';
import {strategyModelInput} from '../src/client/survivors-research/models/action-strategy.js';
import {R160_DIRECTION_PROMPT,R160_MICRO_PROMPT,R160_STRATEGY_PROMPT} from '../src/client/survivors-research/models/r160-prompts.js';
import {R162_DIRECTION_PROMPT,R162_MICRO_PROMPT,R162_STRATEGY_PROMPT} from '../src/client/survivors-research/models/r162-prompts.js';
import {R162_FACTS_VERSION,sharedFacts} from '../src/client/survivors-research/models/r162-shared-facts.js';
const input=guidance=>({input:[{role:'user',content:[{type:'input_text',text:JSON.stringify({schema:'survivors-local-micro-v4',tick:322,guidance,feedback:{},threats:[]})},{type:'input_image',image_url:'fixture'},{type:'input_text',text:'fixture legend'}]}]});
const profile={phase:1,interval:null,remaining_plan:{status:'idle',as_of_tick:322,segments:[]},recent_micro_processing:null,provider_processing_cap_ms:300};
const brief={schema:'survivors-control-brief-v1',strategy_id:'s',source_tick:0,accepted_tick:18,age_ticks:322,approach:'保持右向并短窗观察',phase:'寻找侧面通路',transition:'风险解除后收集'};
test('new micro mode preserves native data and menu across guided and unguided requests while keeping old prompt route',()=>{
 for (const guidance of [null,{heading:'down',remaining_ticks:74,target:null,control_brief:brief}]) {
  const old=drexPathMicroInput(input(guidance),{...profile,brief_mode:'control-brief-v1'},'hold-sequence-coverage-v1');
  const next=drexPathMicroInput(input(guidance),{...profile,brief_mode:'control-brief-v2'},'hold-sequence-coverage-v1');
  assert.equal(old.questions[0].instructions,R160_MICRO_PROMPT);assert.equal(next.questions[0].instructions,R162_MICRO_PROMPT);
  assert.deepEqual(next.input,old.input);assert.deepEqual(next.questions[0].choices,old.questions[0].choices);
  assert.equal(next.questions[0].choices.length,65);assert.deepEqual(JSON.parse(next.input[0].content[0].text).guidance,guidance);
 }
});
test('new direction mode keeps the same menu and old mode keeps R160',()=>{
 const q={name:'guidance',choices:['up','down','left','right'].map(x=>({value:'none:'+x,description:x})),instructions:'legacy'};
 const opts={targetHandoff:true,combatAware:true};
 const old=providerDirectionInput({questions:[q]},0,{...opts,briefMode:'control-brief-v1'});
 const next=providerDirectionInput({questions:[q]},0,{...opts,briefMode:'control-brief-v2'});
 assert.equal(old.questions[0].instructions,R160_DIRECTION_PROMPT);assert.equal(next.questions[0].instructions,R162_DIRECTION_PROMPT);
 assert.deepEqual(next.questions[0].choices,old.questions[0].choices);
});
test('strategic v5 and v4 select distinct prompts with identical public input and generation settings',()=>{
 const chunk=(name,data)=>{const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(name,4);data.copy(out,8);return out;};
 const header=Buffer.alloc(13);header.writeUInt32BE(480,0);header.writeUInt32BE(270,4);
 const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',Buffer.from([0])),chunk('IEND',Buffer.alloc(0))]);
 const observation={schema:'survivors-observation-v1',run_id:'r',observation_id:'o',tick:20,terminal:false,profile:'state-detail-v1',player:{movement:[0,0]}};
 const history={schema:'survivors-strategy-history-v1',run_id:'r',from_tick:20,to_tick:20,coverage_ticks:0,window_ticks:600,displacement:{dx:0,dy:0},hp_delta:0,hits_delta:0,pickups_delta:0,action_counts:{},trajectory:[{tick:20,dx:0,dy:0}]};
 const combat_context={schema:'survivors-combat-context-v1',tick:20,facing:1,whip:{status:'equipped',damage:10,range:null,strikes_per_cycle:1,repeat_ticks:6,direction_mode:'alternating_at_emission',cooldown_remaining_ticks:1,pending_strikes:[]},provider_processing_cap_ms:300};
 const args={observation,history,combat_context,prior_strategy:null,image:{profile:'structured-v1',tick:20,mime_type:'image/png',data_url:'data:image/png;base64,'+png.toString('base64')}};
 const old=strategyModelInput('gpt-6.1-terra',{...args,schema:'survivors-strategy-input-v4'});
 const next=strategyModelInput('gpt-6.1-terra',{...args,schema:'survivors-strategy-input-v5'});
 assert.equal(old.messages[0].content,R160_STRATEGY_PROMPT);assert.equal(next.messages[0].content,R162_STRATEGY_PROMPT);
 assert.deepEqual(next.messages[1],old.messages[1]);assert.deepEqual({...next,messages:undefined},{...old,messages:undefined});
});
test('shared facts are role scoped',()=>{
 assert.equal(R162_FACTS_VERSION,'survivors-shared-facts-v1');assert.equal(sharedFacts('strategy'),sharedFacts('direction'));
 assert.match(sharedFacts('strategy'),/does not supply active-strike facts/);assert.match(sharedFacts('micro'),/ages 1–11 are active/);
 assert.doesNotMatch(sharedFacts('micro'),/does not supply active-strike facts/);assert.throws(()=>sharedFacts('missing'),/Unknown shared facts role/);
});
test('new strategist selects v5 wire without altering the earlier brief-aware v4 mode',async t=>{
 const {createStrategist}=await import('../src/client/survivors-research/models/strategy.js');
 const text=JSON.stringify({schema:'survivors-strategy-v1',approach:'保持进攻',phase:'寻找目标',transition:'危险时撤退',success_signal:'经验增加',failure_signal:'受伤'});
 const bodies=[];
 t.mock.method(globalThis,'fetch',async(_url,request)=>{bodies.push(JSON.parse(request.body));return Response.json({raw_response:JSON.stringify({choices:[{message:{content:text},finish_reason:'stop'}]})});});
 const old=createStrategist({briefAware:true}),next=createStrategist({briefAware:true,sharedFactsAware:true});
 const args={observation:{run_id:'r',tick:20},image:{},history:{},prior_strategy:null,combat_context:{schema:'fixture'},signal:new AbortController().signal};
 await old.advise(args);await next.advise(args);
 assert.equal(old.config.prompt_version,'strategy-v5');assert.equal(next.config.prompt_version,'strategy-v6');
 assert.equal(bodies[0].schema,'survivors-strategy-input-v4');assert.equal(bodies[1].schema,'survivors-strategy-input-v5');
 assert.deepEqual({...bodies[1],schema:bodies[0].schema},bodies[0]);
});

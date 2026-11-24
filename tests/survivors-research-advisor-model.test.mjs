import assert from 'node:assert/strict';
import test from 'node:test';
import {crc32, deflateSync} from 'node:zlib';
import {RESEARCH_SEQUENCE_PROFILE, researchCandidates} from '../src/shared/survivors-research-contract.js';
import {runAgent} from '../src/client/survivors-research/agent-loop.js';
import {advisorQuestion} from '../src/client/survivors-research/models/action-advisor.js';
import {decisionModelInput} from '../src/client/survivors-research/models/decisions.js';
import {createAdvisedDirectionalModel, createDirectionalModel} from '../src/client/survivors-research/models/directional.js';
import {createAdvisorMemory} from '../src/client/survivors-research/advisor-memory.js';

function imageAt(tick) {
  const chunk = (name, contents) => {
    const fields = Buffer.concat([Buffer.from(name), contents]);
    const output = Buffer.alloc(fields.length + 8);
    output.writeUInt32BE(contents.length);
    fields.copy(output, 4);
    output.writeUInt32BE(crc32(fields), output.length - 4);
    return output;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(480);
  header.writeUInt32BE(270, 4);
  header[8] = 8;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(481 * 270))), chunk('IEND', Buffer.alloc(0))]);
  return { profile: 'structured-v1', tick, mime_type: 'image/png', data_url: 'data:image/png;base64,' + png.toString('base64') };
}

const actionProfile = RESEARCH_SEQUENCE_PROFILE;
const candidates = researchCandidates(actionProfile);
function sample(tick, {loot = [], x = 0, runId = 'advisor-fixture', upgrade = null} = {}) {
  const observation = {schema: 'survivors-observation-v1', run_id: runId, observation_id: 'obs-' + tick, tick,
    terminal: false, profile: 'state-detail-v1', sampled_at_ms: tick * 17,
    player: {hp: 120, speed: 3.2, movement: [0, 0]}, loot, upgrade_offer: upgrade,
    coverage: {loot: {visible: loot.length, sent: loot.length, truncated: false}}};
  return {observation, visual_frame: {tick, sampled_at_ms: tick * 17, player: {x, y: 0}, gemsCollected: tick >= 60 ? 3 : 0,
    loot: [{id: 987, dx: 1, dy: 1, kind: 'experience'}]},
  candidates: upgrade ? researchCandidates(actionProfile, upgrade) : candidates};
}
const gem = (id, dx, being_collected = false) => ({id, kind: 'experience', dx, dy: 1, value: 1, being_collected});
const publicRequest = ({observation}) => ({model: 'gpt-6-luna', action_profile: actionProfile,
  candidates, observation: {...observation, direction_context: null}, image: imageAt(observation.tick)});
const response = (wire, choose) => JSON.stringify({answers: wire.questions.map(({name, choices}) => {
  const value = choose(name, choices);
  return {name, type: 'choice', confidence: 1, choice: value,
    probabilities: choices.map(({value: candidate}) => ({value: candidate, probability: Number(candidate === value)}))};
})});

test('advisor validates nonnegative entity IDs and makes at most 45 native choices', () => {
  const current = sample(0, {loot: [gem(0, 1), gem(2, 2), gem(3, 3), gem(4, 4), gem(5, 5)]});
  const memory = createAdvisorMemory();
  assert.equal(memory.observe(current.observation, current.visual_frame, 0), true);
  const context = memory.snapshot();
  const body = publicRequest(current);
  const baseline = decisionModelInput(body.model, body);
  assert.deepEqual(baseline.questions.map(q => q.name), ['threat', 'crystal', 'direction']);
  const native = decisionModelInput(body.model, {...body, advisor_role: 'advisor', advisor_context: context});
  assert.deepEqual(native.questions.map(q => q.name), ['guidance']);
  const values = native.questions[0].choices.map(c => c.value);
  assert.equal(values.length, 45);
  assert.ok(values.includes('loot:0:up-right'));
  assert.ok(values.includes('none:none'));
  assert.ok(values.every(value => !value.includes('987')));
  assert.throws(() => decisionModelInput(body.model, {...body, advisor_role: 'advisor',
    advisor_context: {...context, tick: 1}}), error => error.code === 'invalid_advisor_context');
  assert.throws(() => decisionModelInput(body.model, {...body, advisor_role: 'invalid',
    advisor_context: context}), error => error.code === 'invalid_advisor_context');
  assert.throws(() => decisionModelInput(body.model, {...body, advisor_role: 'advisor',
    advisor_context: context, training_strategy: 'incompatible'}), error => error.code === 'invalid_advisor_context');
  const inactive = structuredClone(context);
  inactive.targets[0].status = 'attracted';
  inactive.targets[1].status = 'reobserved-absent';
  assert.equal(advisorQuestion(inactive).choices.length, 27);
  assert.ok(advisorQuestion(inactive).choices.every(choice => !/^loot:(0|2):/.test(choice.value)));
  const later = sample(20, {loot: [gem(0, 2, true)]});
  assert.equal(memory.accept({guidance_id: 'first', source_tick: 0, target_id: 0, heading: 'none'}), true);
  assert.equal(memory.observe(later.observation, later.visual_frame, 0), true);
  const last = sample(40);
  assert.equal(memory.observe(last.observation, last.visual_frame, 0), true);
  const aged = memory.snapshot();
  assert.equal(aged.targets[0].status, 'attracted');
  assert.equal(aged.targets[0].age_ticks, 20);
  const agedBody = publicRequest(last);
  assert.equal(decisionModelInput(agedBody.model, {...agedBody, advisor_role: 'advisor',
    advisor_context: aged}).questions[0].choices.length, 9);
});

test('actual micro does not wait for advice, uses only a frozen hint, and alone submits', async t => {
  const wires = [];
  const started = [];
  const ended = [];
  const actions = [];
  const aux = [];
  const advisory = [];
  let release;
  let done;
  let aborts = 0;
  t.mock.method(globalThis, 'fetch', async (path, options) => {
    const body = JSON.parse(options.body);
    assert.equal(new Headers(options.headers).get('x-mundi-local-connection'), '1');
    const wire = decisionModelInput(body.model, body);
    if (body.advisor_role === 'advisor') {
      advisory.push({body, wire});
      if (advisory.length === 1) await new Promise(resolve => { release = resolve; });
      else await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
        aborts++;
        reject(options.signal.reason);
      }, {once: true}));
    } else wires.push({body, wire});
    return Response.json({input: wire, raw_response: response(wire, (name, choices) =>
      name === 'direction' ? 'down' : name === 'guidance' ? 'loot:0:up' : choices[0].value)});
  });
  const model = createAdvisedDirectionalModel({memory: createAdvisorMemory()});
  const specimens = [0, 20, 40, 60, 61, 70].map(tick => tick >= 60
    ? sample(tick, {x: 20}) : sample(tick, {loot: [gem(0, 3)]}));
  const loop = runAgent({model, actionProfile, visualProfile: 'structured-v1',
    prepareImage: ({observation}) => imageAt(observation.tick), hitsAtTick: () => 0,
    observe: async () => {
      if (specimens.length) return specimens.shift();
      return new Promise(resolve => {done = () => resolve({terminal: true});});
    },
    submit: async ({action_id, action_ids, observation_id}) => {
      actions.push(action_id);
      const applied_tick = Number(observation_id.slice(4)) + 1;
      if (actions.length === 3) {
        assert.equal(advisory.length, 1);
        assert.equal(aux.filter(row => row.type === 'advisor:published').length, 0);
        release();
        await new Promise(resolve => setImmediate(resolve));
      }
      if (actions.length === 5) return {error: {code: 'rejected-fixture'}};
      return {action_ids, applied_tick};
    },
    compensationMs: 25,
    onRequestStart: async row => started.push(row.decision_id),
    onRequestEnd: async row => ended.push(row.decision_id),
    onAuxiliaryEvent: row => aux.push(row),
  });
  while (!done) await new Promise(resolve => setImmediate(resolve));
  done();
  const result = await loop;
  assert.deepEqual(actions, Array(6).fill('move:down:hold:100'));
  assert.equal(result.applied, 5);
  assert.equal(advisory.length, 2);
  assert.equal(advisory[0].body.advisor_context.player.gems_collected, 0);
  assert.equal(advisory[1].body.advisor_context.player.gems_collected, 3);
  assert.equal(aborts, 1);
  assert.deepEqual(started, ended);
  assert.equal(started.length, 6);
  assert.equal(wires.slice(0, 3).filter(row => row.body.advisor_role).length, 0);
  assert.equal(wires.slice(3).every(row => row.body.advisor_role === 'micro'), true);
  assert.equal(wires[5].body.observation.direction_context.applied_tick, 61);
  assert.deepEqual(wires[3].body.advisor_context.target, {id: 0, status: 'unknown', dx: -17, dy: 1, last_seen_tick: 40});
  assert.equal(wires[3].body.advisor_context.heading, 'up');
  assert.deepEqual(wires[3].wire.questions.map(row => row.choices), wires[0].wire.questions.map(row => row.choices));
  assert.deepEqual(wires[3].wire.questions.slice(0, 2), wires[0].wire.questions.slice(0, 2));
  const advisedInstructions = wires[3].wire.questions.at(-1).instructions;
  assert.match(advisedInstructions, /Follow the current valid advised heading/);
  assert.match(advisedInstructions, /predict where pursuers will move toward you/);
  assert.match(advisedInstructions, /sidestep or retreat briefly, then resume/);
  assert.doesNotMatch(advisedInstructions, /avoids contact first|similar risk|Ignore the advice/);
  assert.match(wires[0].wire.questions.at(-1).instructions, /avoids contact first/);
  assert.deepEqual(aux.filter(row => row.type === 'advisor:attempt').map(row => row.status), ['accepted', 'cancelled']);
  assert.equal(aux.filter(row => row.type === 'advisor:used').length, 3);
  assert.ok(aux.filter(row => row.type === 'advisor:attempt').every(row => row.compensation_receipt === null &&
    row.visual.shared_with_micro && row.input?.questions[0].name === 'guidance' && !Object.hasOwn(row, 'action_id')));
  assert.equal(createDirectionalModel().advisor, undefined);
});

test('three layers run asynchronously and strategy reaches direction only',async t=>{
  const {createStrategicAdvisedModel}=await import('../src/client/survivors-research/models/directional.js');
  const {createStrategyMemory}=await import('../src/client/survivors-research/models/strategy-memory.js');
  const calls=[],events=[],moves=[];let strategyCalls=0;
  const strategist={advise:async ()=>{strategyCalls++;return {content:JSON.stringify({schema:'survivors-strategy-v1',
    approach:'创造机会后回收',phase:'准备',transition:'道路开放时收集',success_signal:'经验增加',failure_signal:'持续受击'})};}};
  const advisor={advise:async input=>{calls.push(input);return {guidance:{target_id:null,heading:'up'}};}};
  t.mock.method(globalThis,'fetch',async (_path,options)=>{
    const b=JSON.parse(options.body); assert.equal(b.advisor_role,'cardinal-micro'); assert.equal(b.strategy_context,undefined);
    const wire=decisionModelInput(b.model,b);
    return Response.json({input:wire,raw_response:response(wire,(_name,choices)=>choices[0].value)});
  });
  const model=createStrategicAdvisedModel({memory:createAdvisorMemory(),strategyMemory:createStrategyMemory(),advisor,strategist});
  const samples=[sample(0),sample(60),sample(80)];
  const run=await runAgent({model,actionProfile,visualProfile:'structured-v1',hitsAtTick:()=>0,
    prepareImage:({observation})=>imageAt(observation.tick),onAuxiliaryEvent:e=>events.push(e),
    observe:async()=>samples.shift()??{terminal:true},
    submit:async ({action_id,action_ids,observation_id})=>{moves.push(action_id);await new Promise(r=>setImmediate(r));
      return {action_ids,applied_tick:Number(observation_id.slice(4))+1};}});
  assert.equal(run.applied,3);assert.equal(strategyCalls,1);assert.equal(moves.length,3);
  assert.equal(calls[0].strategy_context,undefined);assert.equal(calls[1].strategy_context.strategy.phase,'准备');
  assert.equal(events.filter(e=>e.type==='strategy:used').length,1);
  assert.equal(events.filter(e=>e.type==='strategy:published').length,1);
});

test('local micro gets a separate same-tick projection and upper layers retain full images',async t=>{
  const {createLocalMicroStrategicModel}=await import('../src/client/survivors-research/models/directional.js');
  const {createStrategyMemory}=await import('../src/client/survivors-research/models/strategy-memory.js');
  const wires=[],upper=[],events=[],captures=[];
  const advisor={advise:async input=>{upper.push(input);return {guidance:{target_id:null,heading:'up'}};}};
  const strategist={advise:async input=>{upper.push(input);return {content:JSON.stringify({schema:'survivors-strategy-v1',approach:'创造空间',phase:'收集',transition:'空间开放时收集',success_signal:'经验增加',failure_signal:'持续受击'})};}};
  t.mock.method(globalThis,'fetch',async (_path,options)=>{const body=JSON.parse(options.body);wires.push(body);
    const input=decisionModelInput(body.model,body);return Response.json({input,raw_response:response(input,(_name,choices)=>choices[0].value)});});
  const model=createLocalMicroStrategicModel({memory:createAdvisorMemory(),strategyMemory:createStrategyMemory(),advisor,strategist});
  const samples=[sample(0),sample(60),sample(80)];
  const result=await runAgent({model,actionProfile,visualProfile:'structured-v1',hitsAtTick:()=>0,
    prepareImage:({observation})=>imageAt(observation.tick),
    prepareLocalMicroImage:({projection})=>{captures.push(projection);return {...imageAt(projection.tick),profile:'local-micro-v1'};},
    onAuxiliaryEvent:e=>events.push(e),onEvent:e=>events.push(e),observe:async()=>samples.shift()??{terminal:true},
    submit:async ({action_ids,observation_id})=>{await new Promise(r=>setImmediate(r));return {action_ids,applied_tick:Number(observation_id.slice(4))+1};}});
  assert.equal(result.applied,3);assert.equal(wires.length,3);assert.equal(captures.length,3);
  assert.ok(wires.every(w=>w.advisor_role==='local-micro' && w.image.profile==='local-micro-v1'));
  assert.ok(upper.every(w=>w.image.profile==='structured-v1'));
  assert.ok(captures.every(p=>p.schema==='survivors-local-micro-v2' && !JSON.stringify(p).includes('"hp"')));
  assert.ok(events.filter(e=>e.type==='model:attempt' && e.status==='applied').every(e=>e.image.profile==='local-micro-v1'));
});

test('local image failure preserves upper requests and records no micro dispatch',async t=>{
  const {createLocalMicroStrategicModel}=await import('../src/client/survivors-research/models/directional.js');
  const {createStrategyMemory}=await import('../src/client/survivors-research/models/strategy-memory.js');
  const events=[],upper=[];let network=0;
  const advisor={advise:async input=>{upper.push(input);return {guidance:{target_id:null,heading:'up'}};}};
  const strategist={advise:async input=>{upper.push(input);return {content:'{}'};}};
  t.mock.method(globalThis,'fetch',async()=>{network++;throw Error('must not call micro');});
  const model=createLocalMicroStrategicModel({memory:createAdvisorMemory(),strategyMemory:createStrategyMemory(),advisor,strategist});
  const samples=[sample(0)];
  await runAgent({model,actionProfile,visualProfile:'structured-v1',hitsAtTick:()=>0,
    prepareImage:({observation})=>imageAt(observation.tick),prepareLocalMicroImage:()=>{throw Error('render failed');},
    onAuxiliaryEvent:e=>events.push(e),onEvent:e=>events.push(e),observe:async()=>samples.shift()??{terminal:true},
    submit:()=>{throw Error('unexpected action');}});
  assert.equal(upper.length,2);assert.equal(network,0);
  const fail=events.find(e=>e.type==='model:attempt');assert.equal(fail.status,'visual_error');
  assert.equal(fail.backend_metadata.upstream_dispatched,false);assert.equal(fail.decision_timing.model.status,'not_started');
  assert.equal(events.filter(e=>e.type==='model:request').length,0);
});

test('local micro upgrade uses the existing full-image upgrade protocol',async t=>{
 const {createLocalMicroStrategicModel}=await import('../src/client/survivors-research/models/directional.js');
 const {createStrategyMemory}=await import('../src/client/survivors-research/models/strategy-memory.js');
 const events=[],wires=[];let localCaptures=0;
 t.mock.method(globalThis,'fetch',async (_path,options)=>{const body=JSON.parse(options.body);wires.push(body);
   const input=decisionModelInput(body.model,body);return Response.json({input,raw_response:response(input,(_name,choices)=>choices[0].value)});});
 const model=createLocalMicroStrategicModel({memory:createAdvisorMemory(),strategyMemory:createStrategyMemory(),
   advisor:{advise:async()=>({guidance:{target_id:null,heading:'up'}})},strategist:{advise:async()=>({content:'{}'})}});
 const upgrade={offer_id:'level-2',options:[{option_id:'gain-wand',name:'wand',description:'wand'},
   {option_id:'whip-level',name:'whip',description:'whip'}]};const samples=[sample(0,{upgrade})];
 await runAgent({model,actionProfile,visualProfile:'structured-v1',hitsAtTick:()=>0,prepareImage:({observation})=>imageAt(observation.tick),
   prepareLocalMicroImage:()=>{localCaptures++;throw Error('upgrade must not use local image');},onEvent:e=>events.push(e),
   observe:async()=>samples.shift()??{terminal:true},submit:async ({action_ids})=>({action_ids,applied_tick:1})});
 assert.equal(localCaptures,0);assert.equal(wires.length,1);assert.equal(wires[0].image.profile,'structured-v1');
 assert.equal(wires[0].advisor_role,undefined);assert.equal(events.find(e=>e.type==='model:attempt').visual_upgrade_offer,true);
});

test('failed direction refresh preserves the accepted hint only to its original TTL',async()=>{
  const {createAdvisorScheduler}=await import('../src/client/survivors-research/models/advisor-scheduler.js');
  const {ADVISOR_TTL_TICKS}=await import('../src/client/survivors-research/models/action-advisor.js');
  const {ResearchModelError}=await import('../src/client/survivors-research/models/common.js');
  const emitted=[];
  const emit=event=>emitted.push(event);
  const scheduler=createAdvisorScheduler({memory:createAdvisorMemory(),
    restore:{active:{guidance:{target_id:null,heading:'up'},sourceTick:0,acceptedTick:1,id:'accepted-old'}},
    advise:async()=>{throw new ResearchModelError('timeout','Model request timed out');}});
  const loaded=tick=>{
    const {observation,visual_frame:frame}=sample(tick);
    return {observation,frame,hitsTaken:0,emit};
  };
  const refresh=loaded(60);
  assert.equal(scheduler.observe(refresh).expires_tick,ADVISOR_TTL_TICKS);
  scheduler.dispatch({...refresh,candidates,image:imageAt(60),directionObservation:refresh.observation,budget:0});
  await new Promise(setImmediate);
  const stillValid=scheduler.observe(loaded(ADVISOR_TTL_TICKS-1));
  assert.equal(stillValid.guidance_id,'accepted-old');
  assert.equal(stillValid.expires_tick,ADVISOR_TTL_TICKS);
  assert.equal(scheduler.observe(loaded(ADVISOR_TTL_TICKS)),null);
  assert.equal(emitted.find(event=>event.type==='advisor:attempt').status,'timeout');
  assert.equal(emitted.some(event=>event.type==='advisor:published'),false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {ResearchWorld, resumeInitialState, validateConfig} from '../src/client/survivors-research/sim-world.js';
import {buildResearchNode, replayResearch} from '../src/client/survivors-research/sim-replay.js';
import {ResearchRun} from '../src/client/survivors-research/sim-run.js';
import {attachResearchWorker} from '../src/client/survivors-research/simulation.worker.js';
import {RESEARCH_SCHEMA, RESEARCH_ENGINE, RESEARCH_RULES, RESEARCH_SEQUENCE_PROFILE, RESEARCH_PRESSURE,
  RESEARCH_CLOSED_PLAN_HISTORY_FEEDBACK, RESEARCH_ACTUAL_TRAIL_MODE, RESEARCH_SLOTS_PROFILE, TICK_MS}
  from '../src/shared/survivors-research-contract.js';

const resultFor = (world,run_id) => ({schema:RESEARCH_SCHEMA,engine:RESEARCH_ENGINE,rules:RESEARCH_RULES,status:'ended',
  run_id,...world.performanceResult()});
const right = 'move:right:hold:100';
const down = 'move:down:hold:100';
const up = 'move:up:hold:100';
const sourceConfig = validateConfig({max_ticks:900,seed:11,pressure_profile:RESEARCH_PRESSURE,action_profile:RESEARCH_SEQUENCE_PROFILE,
  visual_trail:RESEARCH_ACTUAL_TRAIL_MODE,movement_feedback:RESEARCH_CLOSED_PLAN_HISTORY_FEEDBACK});
const observationAt = tick => ({tick,observation_id:'obs-'+tick,sampled_at_ms:12345+tick});
const makeSource = () => {
  const world = new ResearchWorld(sourceConfig);
  const initial_state = world.initialState();
  const actions = [{applied_tick:1,action_id:right,action_ids:[right,down]}, {applied_tick:25,action_id:up,action_ids:[up]}];
  for (let tick=1;tick<=40;tick++) {
    const action = actions.find(row=>row.applied_tick===tick);
    world.advance(action?.action_id,action?.action_ids);
  }
  world.finish('stopped');
  return {run_id:'source',config:sourceConfig,initial_state,actions,result:resultFor(world,'source')};
};

test('worker gets reusable node with exact first frame and inherited plan, and starts an isolated branch', async () => {
  const request = makeSource();
  const responses = new Map();
  let listener;
  attachResearchWorker({addEventListener(type,callback){listener=callback;},postMessage(data){responses.get(data.request_id)?.(data);}});
  let id = 0;
  const send = (type, run_id, fields={}) => new Promise(resolve=>{
    const request_id = ++id;
    responses.set(request_id,resolve);
    void listener({data:{type,run_id,request_id,...fields}});
  });
  const build = await send('research:build_node','source',{...request,tick:7,observations:[0,4,7].map(observationAt)});
  assert.equal(build.consistent,true);
  assert.equal(build.base_tick,7);
  assert.deepEqual(build.context_samples.map(row=>row.observation.tick),[0,4,7]);
  assert.deepEqual(build.movement.plan.action_ids,[right,down]);
  assert.equal(build.movement.remaining_ticks,5);
  assert.ok(build.snapshot.enemies.some(row=>Number.isFinite(row.vx)));
  const copied = JSON.parse(JSON.stringify(build.node_state));
  const created = await send('research:create','branch',{node_state:copied,duration_ticks:2});
  assert.deepEqual(created.snapshot,build.snapshot);
  assert.equal(created.config.max_ticks,900);
  assert.equal(created.limit_tick,9);
  const started = await send('research:start','branch',{include_initial_visual_frame:true});
  assert.equal(started.initial_sample.observation.tick,7);
  assert.equal(started.initial_sample.observation.run_id,'branch');
  assert.equal(started.initial_sample.visual_frame.tick,7);
  assert.deepEqual(started.initial_sample.observation.enemies,build.context_samples.at(-1).observation.enemies);
  let observation = started.initial_sample;
  while (!observation.terminal) {
    observation = await send('research:observe','branch',{after_tick:observation.observation.tick});
  }
  const terminal = await send('research:result','branch');
  assert.equal(terminal.result.reason,'segment-limit');
  assert.equal(terminal.result.tick,9);
  assert.deepEqual(terminal.actions,[]);
  assert.equal(terminal.result.trace.length,2);
  const replay = await send('research:replay','branch',{config:created.config,
    initial_state:created.initial_state,actions:terminal.actions,result:terminal.result});
  assert.equal(replay.consistent,true);
  const again = await send('research:build_node','branch',{config:created.config,initial_state:created.initial_state,
    actions:terminal.actions,result:terminal.result,tick:9,observations:[7,8,9].map(observationAt)});
  assert.equal(again.consistent,true);
  const longer = await send('research:create','longer',{node_state:again.node_state});
  assert.equal(longer.limit_tick,609);
  const tampered = {...copied,base_tick:8};
  assert.equal((await send('research:stop','longer')).result.tick,9);
  assert.equal(longer.snapshot.done,false);
  assert.equal(again.movement.remaining_ticks,3);
  assert.deepEqual(again.context_samples.map(({observation})=>observation.tick),[7,8,9]);
  assert.deepEqual(again.context_samples.map(({frame})=>frame.tick),[7,8,9]);
  assert.deepEqual(again.context_samples[0].observation.player,started.initial_sample.observation.player);
  assert.deepEqual(again.context_samples.at(-1).frame.player,{x:again.snapshot.player.x,y:again.snapshot.player.y});
  assert.equal((await send('research:create','invalid',{node_state:tampered})).error.code,'invalid-resume-node');
});

test('JSON continuation reproduces the uninterrupted suffix, including velocity and movement history', async () => {
  const source = makeSource();
  const built = await buildResearchNode({...source,tick:7,observations:[7].map(observationAt)});
  assert.equal(built.consistent,true);
  const sourceWorld = new ResearchWorld(source.config,source.initial_state);
  sourceWorld.advance(right,[right,down]);
  for(let tick=2;tick<=7;tick++) sourceWorld.advance();
  const world = new ResearchWorld(source.config,JSON.parse(JSON.stringify(resumeInitialState(built.node_state))));
  assert.deepEqual(world.snapshot(),sourceWorld.snapshot());
  for(let tick=8;tick<=37;tick++) {
    const action=source.actions.find(row=>row.applied_tick===tick);
    assert.deepEqual(world.advance(action?.action_id,action?.action_ids),sourceWorld.advance(action?.action_id,action?.action_ids));
    assert.equal(world.trace.at(-1),sourceWorld.trace.at(-1));
    assert.deepEqual(world.snapshot(),sourceWorld.snapshot());
    assert.deepEqual(world.actualTrail(),sourceWorld.actualTrail());
    assert.deepEqual(world.movementHistory(),sourceWorld.movementHistory());
  }
  world.finish('stopped');
  const replay = await replayResearch({config:source.config,initial_state:world.initialState(),actions:[source.actions[1]],
    result:resultFor(world,'branch'),include_positions:true});
  assert.equal(replay.consistent,true);
  assert.equal(replay.positions.length,31);
  await assert.rejects(buildResearchNode({...source,tick:7,observations:[observationAt(8)]}),{code:'invalid-resume-node'});
  const invalid = await buildResearchNode({...source,result:{...source.result,trace:undefined,state_hash:'0000000000000000'},tick:7});
  assert.equal(invalid.consistent,false);
  assert.equal(invalid.node_state,undefined);
});

test('a restored pending upgrade pauses a slots branch from its first sample', async () => {
  const config = validateConfig({action_profile:RESEARCH_SLOTS_PROFILE,pause_for_upgrade:true,fixture:'pending-upgrade'});
  const source = new ResearchWorld(config);
  source.advance();

  const run = new ResearchRun({config,nodeState:source.resumeNode('original'),durationTicks:2,runId:'branch',send(){},now:()=>1000,
    schedule(){throw Error('a pending upgrade must wait without advancing the clock');}});
  const initial = run.start(true).initial_sample;
  assert.equal(initial.observation.tick,1);
  assert.ok(initial.observation.upgrade_offer);
  assert.equal(run.clockSnapshot().upgrade_pause_active,true);
  run.finish();
});

test('a node before source death can continue beyond that death, while the death frame cannot resume', async () => {
  const config = validateConfig({action_profile:RESEARCH_SEQUENCE_PROFILE,max_ticks:1000,fixture:'pending-upgrade'});
  const world = new ResearchWorld(config);
  const initial_state = world.initialState();
  const state = initial_state.checkpoint.state;
  state.player.hp = 1;
  const source = new ResearchWorld(config,initial_state);
  source.advance();
  assert.equal(source.reason,'death');
  const request = {run_id:'dead-source',config,initial_state,actions:[],result:resultFor(source,'dead-source')};
  await assert.rejects(buildResearchNode({...request,tick:1}),{code:'invalid-resume-node'});
  const result = await replayResearch(request);
  assert.equal(result.can_resume,false);
  const before = await buildResearchNode({...request,tick:0});
  assert.equal(before.consistent,true);
  const branch = new ResearchWorld(config,resumeInitialState(before.node_state));
  assert.equal(branch.limitTick,600);
  assert.equal(branch.snapshot().player.hp,1);
});

test('manual stop at the same tick can be reopened without discarding the active plan', async () => {
  const source = makeSource();
  const world = new ResearchWorld(source.config,source.initial_state);
  world.advance(right,[right,down]);
  world.advance();
  world.finish('interrupted');
  const request = {...source,actions:[source.actions[0]],result:resultFor(world,'source')};
  assert.equal((await replayResearch(request)).can_resume,true);
  const resumed = await buildResearchNode({...request,tick:2});
  assert.equal(resumed.consistent,true);
  assert.equal(resumed.movement.remaining_ticks,4);
  assert.deepEqual(resumed.movement.plan.action_ids,[right,down]);
  assert.equal(resumed.snapshot.done,false);
  assert.equal(new ResearchWorld(source.config,resumeInitialState(resumed.node_state,1000)).limitTick,source.config.max_ticks);
});

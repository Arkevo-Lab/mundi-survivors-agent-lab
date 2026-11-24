import assert from 'node:assert/strict';
import test from 'node:test';
import {BAT_CRYSTAL_BANDS as scene} from '../public/games/survivors-lab-research-v1/src/bat-crystal-bands.mjs';
import {createSurvivorsGame, REAPER_TICK} from '../public/games/survivors-lab-research-v1/src/sim.mjs';
import {FOREST_EVENTS} from '../public/games/survivors-lab-0.61.0/src/stage.mjs';
import {projectObservation} from '../src/client/survivors-research/sim-observation.js';
import {replayResearch} from '../src/client/survivors-research/sim-replay.js';
import {ResearchWorld, resumeConfig, resumeInitialState, validateConfig} from '../src/client/survivors-research/sim-world.js';
import {RESEARCH_ENGINE, RESEARCH_PRESSURE, RESEARCH_RULES, RESEARCH_SCHEMA} from '../src/shared/survivors-research-contract.js';

const config = validateConfig({scenario:scene.id,max_ticks:3600,observation_profile:'state-detail-v1'});
const coords = ({x,y}) => ({x,y});
const ids = rows => rows.map(({id}) => id);
const fixtureEngine = () => createSurvivorsGame({scenario:scene.id,seed:scene.seed,maxTicks:REAPER_TICK+1});
const assertOriginalRoster = ({enemies,kills}) => {
  assert.equal(enemies.length+kills,scene.initialEnemyIds.length);
  assert.ok(enemies.every(({id,kind,boss,eventType}) =>
    scene.initialEnemyIds.includes(id)&&kind===scene.enemyKind&&!boss&&eventType===undefined));
};

test('fixed research opening stacks two bands in view and freezes its initial roster and loot IDs',()=>{
  const world = new ResearchWorld(config);
  const initial = world.initialState();
  const {state} = initial.checkpoint;
  assert.equal(initial.checkpoint.scenario,scene.id);
  assert.deepEqual([state.seed,state.player.x,state.player.y,state.player.hp,state.player.maxHp,state.player.level],
    [154,0,0,120,120,1]);
  assert.equal(state.whip.level,1);
  assert.equal(state.whip.nextTick,1);
  assertOriginalRoster(state);
  assert.equal(state.enemies.length,24);
  assert.deepEqual(ids(state.enemies),scene.initialEnemyIds);
  assert.deepEqual(state.enemies.map(coords),scene.enemyPositions);
  assert.equal(state.gems.length,60);
  assert.deepEqual(ids(state.gems),scene.initialGemIds);
  assert.deepEqual(state.gems.map(coords),scene.gemPositions);
  assert.ok(state.gems.every(gem => gem.value===1&&gem.attraction===undefined));
  // The 480×270 structured view draws 8 px diamonds at 15 px/unit; the
  // bottom 28 px are reserved for the HUD. Staggered rows leave all edges clear.
  for (const [index, gem] of state.gems.entries()) {
    assert.ok(135 + gem.y*15+8 < 242);
    assert.ok(state.gems.slice(index+1).every(other =>
      (Math.abs(gem.x-other.x)+Math.abs(gem.y-other.y))*15>16));
    assert.ok(state.enemies.every(bat => Math.hypot(gem.x-bat.x,gem.y-bat.y) > bat.radius+8/15));
  }
  assert.deepEqual([state.breakables,state.pickups,state.chests],[[],[],[]]);
  const {observation} = projectObservation({snapshot:world.snapshot(),config,runId:'fixed-opening',
    movement:world.movementVector(),sampledAt:0,now:()=>0});
  assert.deepEqual(observation.coverage.enemies,{visible:24,sent:24,truncated:false});
  assert.deepEqual(observation.coverage.loot,{visible:60,sent:60,truncated:false});
  assert.ok(observation.loot.every(item => item.kind==='experience'&&item.value===1&&!item.being_collected));
  assert.deepEqual(new Set(ids(observation.loot)),new Set(scene.initialGemIds));
  const dense = new ResearchWorld({...config,pressure_profile:RESEARCH_PRESSURE});
  assert.deepEqual(dense.initialState(),initial);
});

test('scenario stays bound on replay and resume, while the original bats move toward the player',async()=>{
  const world = new ResearchWorld(config);
  const initial = world.initialState();
  const first = world.snapshot().enemies[0];
  for (let i=0;i<31;i++) world.advance();
  const after = world.snapshot().enemies.find(({id})=>id===first.id);
  assert.ok(Math.hypot(after.x,after.y)<Math.hypot(first.x,first.y));
  assertOriginalRoster(world.snapshot());
  const node = world.resumeNode('bands-source');
  assert.equal(node.config.scenario,scene.id);
  assert.equal(node.engine_state.checkpoint.scenario,scene.id);
  assert.throws(()=>resumeConfig(node,{scenario:'other'}),/scenario/);
  const resumed = new ResearchWorld(resumeConfig(node),resumeInitialState(node,100));
  assert.deepEqual(resumed.checkpoint(),world.checkpoint());
  for (let i=0;i<9;i++) {
    world.advance();
    resumed.advance();
  }
  assert.deepEqual(resumed.checkpoint(),world.checkpoint());
  assertOriginalRoster(resumed.snapshot());
  world.finish('stopped');
  const replay = await replayResearch({config,initial_state:initial,actions:[],result:{
    schema:RESEARCH_SCHEMA,rules:RESEARCH_RULES,engine:RESEARCH_ENGINE,status:'ended',...world.performanceResult(),
  }});
  assert.equal(replay.consistent,true);
  assert.equal(replay.result.state_hash,world.performanceResult().state_hash);
  const normalConfig = validateConfig({seed:scene.seed,max_ticks:config.max_ticks});
  const ordinary = new ResearchWorld(normalConfig);
  assert.equal(Object.hasOwn(ordinary.initialState().checkpoint,'scenario'),false);
  assert.throws(()=>new ResearchWorld(normalConfig,initial),/scenario differs/);
  assert.throws(()=>new ResearchWorld(config,ordinary.initialState()),/scenario differs/);
  assert.throws(()=>validateConfig({scenario:scene.id,seed:11}),/scenario/);
  assert.throws(()=>validateConfig({scenario:scene.id,character:'imelda'}),/scenario/);
  assert.throws(()=>validateConfig({scenario:scene.id,fixture:'pending-upgrade'}),/scenario/);
});

test('ordinary timer, minute boss, event formation and Reaper boundaries cannot add enemies or props',()=>{
  const boundaries = [30,60,3600,FOREST_EVENTS[0].tick,REAPER_TICK];
  const engine = fixtureEngine();
  for (const boundary of boundaries) {
    const checkpoint = fixtureEngine().exportState();
    const {state} = checkpoint;
    state.tick = boundary-1;
    state.waveMinute = Math.floor(state.tick/3600);
    state.nextSpawnTick = boundary;
    state.nextBreakableTick = boundary;
    state.player.x = 100;
    state.whip.nextTick = boundary+1;
    engine.restoreState(checkpoint);
    engine.advance();
    const snapshot = engine.snapshot();
    assert.equal(snapshot.tick,boundary);
    assertOriginalRoster(snapshot);
    assert.deepEqual(ids(snapshot.enemies),scene.initialEnemyIds,`preserve offscreen bats at tick ${boundary}`);
    assert.ok(snapshot.enemies[0].x>state.enemies[0].x);
    assert.deepEqual([snapshot.stageEventsTriggered,snapshot.breakables.length,snapshot.pickups.length],[0,0,0]);
  }
});

test('a controlled combat fixture retains actual damage, whip kills and normal XP drop IDs',()=>{
  const engine = fixtureEngine();
  const checkpoint = engine.exportState();
  const {state} = checkpoint;
  state.rng = 0x12345678;
  Object.assign(state.enemies[0],{x:1.5,y:-0.53});
  Object.assign(state.enemies[1],{x:-0.1,y:0});
  engine.restoreState(checkpoint);
  for (let i=0;i<3;i++) engine.advance();
  const snapshot = engine.snapshot();
  assert.ok(snapshot.player.hp<120);
  assert.equal(snapshot.kills,1);
  assertOriginalRoster(snapshot);
  assert.ok(!ids(snapshot.enemies).includes(scene.initialEnemyIds[0]));
  const dropped = snapshot.gems.filter(gem => !scene.initialGemIds.includes(gem.id));
  assert.equal(dropped.length,1);
  assert.equal(dropped[0].value,1);
  assert.equal(snapshot.gems.length,61);
});

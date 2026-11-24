import assert from 'node:assert/strict';
import test from 'node:test';
import {projectTrainingIntent, publicTrainingGoalIds, validTrainingGoalId}
  from '../src/client/survivors-research/training-goal-memory.js';
import {ResearchRun} from '../src/client/survivors-research/sim-run.js';
import {replayResearch} from '../src/client/survivors-research/sim-replay.js';
import {RESEARCH_SLOTS_COUNT, RESEARCH_SLOTS_PROFILE, TICK_MS} from '../src/shared/survivors-research-contract.js';

const memory = 'goal-memory-v1';
const stateless = 'goal-stateless-v1';
const gem = (id, being_collected = false) => ({id, kind: 'experience', being_collected});

test('goal choices derive only from bounded public entity lists and compass directions', () => {
  const ids = publicTrainingGoalIds({loot: [gem(1, true), {id: 2, kind: 'coin'},
    ...Array.from({length: 8}, (_, i) => gem(i + 3))], enemies: Array.from({length: 6}, (_, i) => ({id: i + 20}))});
  assert.deepEqual(ids, ['loot:3', 'loot:4', 'loot:5', 'loot:6', 'loot:7', 'loot:8', 'enemy:20', 'enemy:21',
    'enemy:22', 'enemy:23', 'space:up', 'space:up-right', 'space:right', 'space:down-right', 'space:down',
    'space:down-left', 'space:left', 'space:up-left']);
  assert.ok(ids.every(validTrainingGoalId));
  assert.ok(!['loot:0', 'enemy:01', 'loot:9007199254740992', 'retain', 'space:wait'].some(validTrainingGoalId));
});

test('intent reports actual signed feedback and treats a missing target as unknown', () => {
  const observed = {tick: 10, x: 2, y: 3, hp: 120};
  const current = {tick: 25, x: 1.25, y: 3.5, hp: 116};
  const committed = {goal_id: 'loot:5', observed, applied_tick: 14, plan_end: {started_tick: 14, executed_ticks: 3}};
  const observation = {tick: 25, loot: [gem(5, true)], score: {gems_collected: 4}};
  const intent = projectTrainingIntent(memory, observation, current, committed);
  assert.deepEqual(intent, {mode: memory, prior: {goal_id: 'loot:5', observed_tick: 10,
    dx: -0.75, dy: 0.5, hp_delta: -4, executed_ticks: 3, target_status: 'attracted'}});
  assert.equal(projectTrainingIntent(memory, {...observation, loot: []}, current, committed).prior.target_status, 'unknown');
  assert.equal(projectTrainingIntent(memory, observation, current, {...committed, plan_end: null}).prior.executed_ticks, 12);
  assert.equal(projectTrainingIntent(memory, observation, current, {...committed, goal_id: 'space:right'}).prior.target_status, 'none');
  assert.equal(projectTrainingIntent(memory, observation, current, {...committed, goal_id: 'enemy:5'}).prior.target_status, 'unknown');
  assert.deepEqual(projectTrainingIntent(stateless, observation, current, committed), {mode: stateless, prior: null});
  assert.deepEqual(projectTrainingIntent(memory, observation, current), {mode: memory, prior: null});
  assert.throws(() => projectTrainingIntent(memory, {...observation, upgrade_offer: {}}, current, committed), /movement observation/);
});

test('replacement uses authoritative executed ticks and projection leaves replay unchanged', async () => {
  let now = 100_000;
  const events = [];
  const run = new ResearchRun({runId: 'goal-memory-replay', config: {action_profile: RESEARCH_SLOTS_PROFILE},
    now: () => now, schedule: () => 1, cancel() {}, send: message => events.push(message.event)});
  const initial_state = run.world.initialState();
  const {started_at_ms: started} = run.start();
  const read = () => {
    const {observation} = run.observe();
    const {tick, player: {x, y, hp}} = run.world.snapshot();
    return {observation, anchor: {tick, x, y, hp}};
  };
  const advance = tick => {now = started + tick * TICK_MS;run.pump();};
  const submit = (observation, action_id, decision_id) => run.submit({observation_id: observation.observation_id,
    decision_id, action_id, action_ids: Array(RESEARCH_SLOTS_COUNT).fill(action_id)});
  const first = read();
  const east = submit(first.observation, 'move:right:hold:50', 'east');
  advance(1);
  const applied = await east;
  advance(4);
  const replacement = read();
  const west = submit(replacement.observation, 'move:left:hold:50', 'west');
  advance(5);
  await west;
  advance(7);
  const {observation, anchor} = read();
  const before = run.world.checkpoint();
  const plan_end = events.find(event => event?.type === 'movement_plan_ended' && event.started_tick === applied.applied_tick);
  const feedback = projectTrainingIntent(memory, observation, anchor, {goal_id: 'space:right',
    observed: first.anchor, applied_tick: applied.applied_tick, plan_end});
  assert.equal(feedback.prior.executed_ticks, 4);
  assert.equal(feedback.prior.dx, 0.0533);
  assert.deepEqual(run.world.checkpoint(), before);
  const outcome = run.finish();
  const replay = await replayResearch({config: run.config, initial_state, ...outcome});
  assert.equal(replay.consistent, true);
});

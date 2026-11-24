import assert from 'node:assert/strict';
import {MessageChannel} from 'node:worker_threads';
import test from 'node:test';
import {createSurvivorsGame as createBaseline} from '../public/games/survivors-lab-0.61.0/src/sim.mjs';
import {createSurvivorsGame} from '../public/games/survivors-lab-research-v1/src/sim.mjs';
import {MAX_RESEARCH_LATENCY_COMPENSATION_MS, RESEARCH_CLOSED_PLAN_FEEDBACK, RESEARCH_EXECUTED_PLAN_FEEDBACK,
  RESEARCH_ACTUAL_TRAIL_MODE,
  RESEARCH_CLOSED_PLAN_HISTORY_FEEDBACK,
  RESEARCH_FINE_HOLD_DURATIONS_MS, RESEARCH_FINE_HOLD_PROFILE,
  RESEARCH_MOVEMENT_RECEIPT_LIMIT,
  RESEARCH_PRESSURE, RESEARCH_SEQUENCE_PROFILE, RESEARCH_SLOT_TICKS, RESEARCH_SLOT_WAIT_ID,
  RESEARCH_SLOTS_COUNT, RESEARCH_SLOTS_MAX_TICKS, RESEARCH_SLOTS_PROFILE, TICK_HZ, TICK_MS,
  researchCandidates, researchMovement, validResearchActionSequence, validResearchSlotPlan} from '../src/shared/survivors-research-contract.js';
import {INFORMATION_PRESETS} from '../src/client/survivors-research/information-presets.js';
import {validActionContext} from '../src/client/survivors-research/models/action-observation.js';
import {projectObservation} from '../src/client/survivors-research/sim-observation.js';
import {replayResearch} from '../src/client/survivors-research/sim-replay.js';
import {ResearchRun} from '../src/client/survivors-research/sim-run.js';
import {VISUAL_FRAME_SCHEMA, projectVisualFrame} from '../src/client/survivors-research/sim-visual-frame.js';
import {ResearchWorld, validateConfig} from '../src/client/survivors-research/sim-world.js';
import {attachResearchWorker} from '../src/client/survivors-research/simulation.worker.js';

function harness(config = {}) {
  let now = 100_000;
  const messages = [];
  const run = new ResearchRun({
    runId: 'simulation-test', config, send: message => messages.push(message),
    now: () => now, schedule: () => 1, cancel: () => {},
  });
  const initial_state = run.world.initialState();
  const {started_at_ms: started} = run.start();
  const advance = count => {
    const until = run.world.tick + count;
    while (run.world.tick < until && run.status === 'running') {
      now = started + (run.world.tick + 1) * TICK_MS;
      run.pump();
    }
  };
  const submit = (id, action_id, observation = run.observe().observation) =>
    run.submit({observation_id: observation.observation_id, decision_id: id, action_id});
  const events = type => messages.filter(message => message.event?.type === type).map(message => message.event);
  return {run, advance, submit, initial_state, events, shiftClock: ms => { now += ms; }, messages};
}

function scheduledHarness(config) {
  let now = 100_000;
  let nextTimer = 0;
  const timers = new Map();
  const messages = [];
  const run = new ResearchRun({
    runId: 'latency-test', config, now: () => now, send: message => messages.push(message),
    schedule: (callback, delay) => {
      timers.set(++nextTimer, {at: now + delay, callback});
      return nextTimer;
    },
    cancel: id => timers.delete(id),
  });
  const initial_state = run.world.initialState();
  run.start();

  function advance(ms, processTimers = true) {
    const end = now + ms;
    while (processTimers && timers.size) {
      assert.equal(timers.size, 1);
      const [id, timer] = timers.entries().next().value;
      if (timer.at > end) break;
      now = Math.max(now, timer.at);
      timers.delete(id);
      timer.callback();
    }
    now = end;
  }

  const events = type => messages.filter(message => message.event?.type === type).map(message => message.event);
  return {run, advance, events, timers, initial_state};
}

const executedPlanConfig = {
  action_profile: RESEARCH_SEQUENCE_PROFILE,
  observation_profile: 'state-detail-v1',
  movement_feedback: RESEARCH_EXECUTED_PLAN_FEEDBACK,
};
const rightHold = 'move:right:hold:100', upHold = 'move:up:hold:100', leftHold = 'move:left:hold:100';

test('executed-plan feedback uses applied ticks and ages on the simulation clock', async () => {
  const config = {...executedPlanConfig, latency_compensation_ms: 80};
  const reference = scheduledHarness({...config, movement_feedback: 'none'});
  const feedback = scheduledHarness(config);
  const runs = [reference, feedback];
  const snapshotCounts = [0, 0];
  for (const [index, {run}] of runs.entries()) {
    const snapshot = run.world.snapshot.bind(run.world);
    run.world.snapshot = () => {
      snapshotCounts[index]++;
      return snapshot();
    };
  }
  const observe = () => {
    const samples = runs.map(({run}) => run.observe(-1, true));
    const [base, next] = samples;
    const {previous_movement: motion, ...player} = next.observation.player;
    assert.deepEqual({...next.observation, player}, base.observation);
    const serializedExtra = motion ? Buffer.byteLength(`,"previous_movement":${JSON.stringify(motion)}`) : 0;
    assert.equal(Buffer.byteLength(JSON.stringify(next.observation)) -
      Buffer.byteLength(JSON.stringify(base.observation)), serializedExtra);
    assert.deepEqual(next.visual_frame, base.visual_frame);
    assert.equal(snapshotCounts[1], snapshotCounts[0]);
    return motion;
  };
  const assertClockParity = () => {
    assert.deepEqual(feedback.run.clockSnapshot(), reference.run.clockSnapshot());
    assert.deepEqual(feedback.run.world.checkpoint(), reference.run.world.checkpoint());
    assert.deepEqual(feedback.run.world.movementInfo(), reference.run.world.movementInfo());
    assert.deepEqual(feedback.run.actions, reference.run.actions);
  };
  const advance = ms => {
    for (const run of runs) run.advance(ms);
    assertClockParity();
  };
  const submit = (id, ids) => runs.map(({run}) => run.submit({
    observation_id: run.observe().observation.observation_id, decision_id: id,
    action_id: ids[0], action_ids: ids,
  }));
  const point = () => {
    const {x, y, hp} = reference.run.world.engine.snapshot().player;
    return {x, y, hp};
  };
  const round = value => Math.round(value * 10_000) / 10_000 || 0;
  const expected = (from, to, executed_ticks, age_ticks) => ({
    dx: round(to.x - from.x), dy: round(to.y - from.y),
    executed_ticks, hp_delta: to.hp - from.hp, age_ticks,
  });

  assert.equal(observe(), undefined);
  const start = point();
  const initial = submit('initial', [rightHold, upHold, leftHold]);
  assert.equal(observe(), undefined);
  advance(TICK_MS * 6 + 1);
  assert.deepEqual(await initial[0], await initial[1]);
  const first = point();
  assert.equal(feedback.run.world.tick, 6);
  assert.equal(feedback.run.world.movementInfo().plan.index, 1);
  assert.deepEqual(observe(), expected(start, first, 6, 0));
  assert.deepEqual(observe(), expected(start, first, 6, 0));

  const stopped = submit('stop-before-second-segment', ['stop']);
  advance(TICK_MS);
  assert.deepEqual(await stopped[0], await stopped[1]);
  assert.equal(feedback.run.world.tick, 7);
  assert.deepEqual(observe(), expected(start, first, 6, 1));

  const startAgain = point();
  const next = submit('next', [upHold, rightHold, rightHold]);
  advance(TICK_MS * 3);
  assert.deepEqual(await next[0], await next[1]);
  const partial = point();
  assert.deepEqual(observe(), expected(startAgain, partial, 3, 0));

  for (const {run} of runs) run.beginLatency('refusal');
  advance(60);
  assert.deepEqual(observe(), expected(startAgain, partial, 3, 0));
  advance(20 + TICK_MS * 4);
  for (const {run} of runs) assert.equal(run.endLatency('refusal').latency_compensation.paused_ms, 80);
  assert.equal(feedback.run.actions.length, 3);
  assert.deepEqual(observe(), expected(startAgain, point(), 7, 0));

  advance(TICK_MS * 11);
  const completed = point();
  assert.deepEqual(observe(), expected(startAgain, completed, 18, 0));
  advance(TICK_MS);
  assert.deepEqual(observe(), expected(startAgain, completed, 18, 1));
  advance(TICK_MS * 17);
  assert.deepEqual(observe(), expected(startAgain, completed, 18, 18));
  advance(TICK_MS);
  assert.equal(observe(), undefined);

  const [oldOutcome, outcome] = runs.map(({run}) => run.finish());
  assert.deepEqual(outcome, oldOutcome);
  assert.equal(observe(), undefined);
  assert.ok(snapshotCounts[0] > 0);
});

test('executed-plan feedback reports signed hit and healing and honors observation visibility', () => {
  assert.throws(() => validateConfig({movement_feedback: RESEARCH_EXECUTED_PLAN_FEEDBACK}), {code: 'invalid-config'});
  assert.throws(() => validateConfig({...executedPlanConfig, action_profile: RESEARCH_SLOTS_PROFILE}), {code: 'invalid-config'});
  assert.throws(() => validateConfig({...executedPlanConfig, movement_feedback: 'receipts'}), {code: 'invalid-config'});
  const config = validateConfig(executedPlanConfig);
  const fresh = new ResearchWorld(config).initialState();
  fresh.checkpoint.state.player.hp = 80;
  fresh.checkpoint.state.pummarolaLevel = 1;
  fresh.checkpoint.state.enemies[0].x = 0.05;
  fresh.checkpoint.state.enemies[0].y = 0.05;
  const world = new ResearchWorld(config, fresh);
  const view = (overrides = {}, snapshot = world.snapshot(), previousMovement = world.previousMovement()) =>
    projectObservation({snapshot, config: {...config, ...overrides}, previousMovement, runId: 'execution', movement: [0, 0],
      sampledAt: 0, now: () => 0}).observation;
  const startHp = world.snapshot().player.hp;
  const events = world.advance(rightHold, [rightHold]);
  const hitHp = world.snapshot().player.hp;
  assert.ok(events.some(event => event.type === 'player_hit'));
  assert.ok(hitHp < startHp);
  assert.equal(view().player.previous_movement.hp_delta, hitHp - startHp);
  for (let i = 2; i < 60; i++) world.advance(rightHold, [rightHold]);
  const beforeHeal = world.snapshot().player.hp;
  world.advance(rightHold, [rightHold]);
  const afterHeal = world.snapshot().player.hp;
  assert.ok(afterHeal > beforeHeal);
  const receipt = view().player.previous_movement;
  assert.deepEqual(Object.keys(receipt), ['dx', 'dy', 'executed_ticks', 'hp_delta', 'age_ticks']);
  assert.equal(receipt.hp_delta, afterHeal - beforeHeal);
  assert.equal(receipt.executed_ticks, 1);
  for (const observation_fields of [[], ['health'], ['movement']]) {
    assert.equal(view({observation_fields}).player.previous_movement, undefined);
    assert.equal(new ResearchWorld({...config, observation_fields}).executedPlanFeedback, false);
  }
  assert.deepEqual(view({observation_fields: ['movement', 'health']}).player.previous_movement, receipt);
  assert.equal(view({movement_feedback: 'none'}).player.previous_movement, undefined);
  const upgradeWorld = new ResearchWorld(validateConfig({...executedPlanConfig, fixture: 'pending-upgrade'}));
  upgradeWorld.advance(rightHold, [rightHold]);
  const upgrade = view({}, upgradeWorld.snapshot(), upgradeWorld.previousMovement());
  assert.ok(upgrade.upgrade_offer);
  assert.equal(upgrade.player.previous_movement, undefined);
  const {offer_id, options} = upgrade.upgrade_offer;
  const beforeUpgrade = upgradeWorld.previousMovement();
  upgradeWorld.advance(`choose:${offer_id}:${options[0].option_id}`);
  assert.deepEqual(upgradeWorld.previousMovement(), {...beforeUpgrade, age_ticks: 1});
  world.finish('interrupted');
  assert.equal(view().player.previous_movement, undefined);
});

test('closed-plan feedback preserves the prior actual prefix after a replacement ACK', async () => {
  const modes = ['none', RESEARCH_EXECUTED_PLAN_FEEDBACK, RESEARCH_CLOSED_PLAN_FEEDBACK];
  const runs = modes.map(movement_feedback => scheduledHarness({
    ...executedPlanConfig, movement_feedback, latency_compensation_ms: 80,
  }));
  const snapshotCounts = [0, 0, 0];
  for (const [index, {run}] of runs.entries()) {
    const snapshot = run.world.snapshot.bind(run.world);
    run.world.snapshot = () => {
      snapshotCounts[index]++;
      return snapshot();
    };
  }
  const state = () => runs[0].run.world.engine.snapshot().player;
  const round = value => Math.round(value * 10_000) / 10_000 || 0;
  const receipt = (from, to, executed_ticks, age_ticks) => ({
    dx: round(to.x - from.x), dy: round(to.y - from.y),
    executed_ticks, hp_delta: to.hp - from.hp, age_ticks,
  });
  const read = (latest, closed) => {
    const [baseline, ...samples] = runs.map(({run}) => run.observe(-1, true));
    for (const [index, sample] of samples.entries()) {
      const {previous_movement, ...player} = sample.observation.player;
      assert.deepEqual(previous_movement, [latest, closed][index]);
      assert.deepEqual({...sample.observation, player}, baseline.observation);
      assert.deepEqual(sample.visual_frame, baseline.visual_frame);
      const bytes = previous_movement ? Buffer.byteLength(`,"previous_movement":${JSON.stringify(previous_movement)}`) : 0;
      assert.equal(Buffer.byteLength(JSON.stringify(sample.observation)) -
        Buffer.byteLength(JSON.stringify(baseline.observation)), bytes);
    }
    assert.deepEqual(snapshotCounts, Array(3).fill(snapshotCounts[0]));
  };
  const advance = (ms, tick) => {
    for (const run of runs) run.advance(ms);
    const [baseline, ...others] = runs.map(({run}) => run);
    assert.equal(baseline.world.tick, tick);
    for (const other of others) {
      assert.deepEqual(other.world.checkpoint(), baseline.world.checkpoint());
      assert.deepEqual(other.clockSnapshot(), baseline.clockSnapshot());
      assert.deepEqual(other.actions, baseline.actions);
    }
  };
  const submit = (id, ids) => runs.map(({run}) => run.submit({
    observation_id: run.observe().observation.observation_id, decision_id: id,
    action_id: ids[0], action_ids: ids,
  }));
  const verifyAcks = async (pending, tick) => {
    const [first, ...rest] = await Promise.all(pending);
    assert.equal(first.applied_tick, tick);
    for (const ack of rest) assert.deepEqual(ack, first);
  };

  read(undefined, undefined);
  const start = state();
  const first = submit('first', [rightHold, upHold, leftHold]);
  advance(6 * TICK_MS + 1, 6);
  await verifyAcks(first, 1);
  const afterFirst = state();
  const firstPrefix = receipt(start, afterFirst, 6, 0);
  read(firstPrefix, undefined);

  const second = submit('second', [upHold, rightHold, leftHold]);
  advance(TICK_MS, 7);
  await verifyAcks(second, 7);
  const newFirstTick = receipt(afterFirst, state(), 1, 0);
  read(newFirstTick, {...firstPrefix, age_ticks: 1});
  for (const {run} of runs) run.beginLatency('refused');
  advance(60, 7);
  read(newFirstTick, {...firstPrefix, age_ticks: 1});
  advance(20 + TICK_MS * 5, 12);
  for (const {run} of runs) assert.equal(run.endLatency('refused').latency_compensation.paused_ms, 80);
  assert.equal(runs[0].run.actions.length, 2);
  read(receipt(afterFirst, state(), 6, 0), {...firstPrefix, age_ticks: 6});
  advance(12 * TICK_MS, 24);
  const completed = receipt(afterFirst, state(), 18, 0);
  read(completed, completed);
  advance(18 * TICK_MS, 42);
  const lastFresh = {...completed, age_ticks: 18};
  read(lastFresh, lastFresh);
  advance(TICK_MS, 43);
  read(undefined, undefined);
  const [baseline, ...others] = runs.map(({run}) => run.finish());
  for (const result of others) assert.deepEqual(result, baseline);
  read(undefined, undefined);
});

test('closed-plan history rolls back failed movement and excludes upgrade tick HP', () => {
  const config = validateConfig({...executedPlanConfig, movement_feedback: RESEARCH_CLOSED_PLAN_FEEDBACK,
    fixture: 'pending-upgrade'});
  const baseline = new ResearchWorld({...config, movement_feedback: 'none'});
  const world = new ResearchWorld(config);
  const sample = (configOverride = config) => projectObservation({
    snapshot: world.snapshot(), config: configOverride, previousMovement: world.previousMovement(),
    runId: 'closed-plan', movement: [0, 0], sampledAt: 0, now: () => 0,
  }).observation;
  const step = (action, ids) => {
    assert.deepEqual(world.advance(action, ids), baseline.advance(action, ids));
    assert.deepEqual(world.checkpoint(), baseline.checkpoint());
  };
  const start = baseline.snapshot().player;
  step(rightHold, [rightHold, upHold]);
  assert.equal(world.previousMovement(), undefined);
  const finish = baseline.snapshot().player;
  const engine = world.engine;
  const error = new Error('advance rejected by test fixture');
  world.engine = {...engine, advance: () => { throw error; }};
  const before = world.checkpoint();
  assert.throws(() => world.advance(upHold, [upHold]), error);
  assert.deepEqual(world.checkpoint(), before);
  assert.equal(world.previousMovement(), undefined);
  world.engine = engine;
  const observation = sample();
  assert.ok(observation.upgrade_offer);
  const {offer_id, options} = observation.upgrade_offer;
  step(`choose:${offer_id}:${options[0].option_id}`);
  const previous = world.previousMovement();
  assert.deepEqual(previous, {dx: Math.round((finish.x - start.x) * 10_000) / 10_000, dy: 0,
    executed_ticks: 1, hp_delta: finish.hp - start.hp, age_ticks: 1});
  assert.deepEqual(sample().player.previous_movement, previous);
  for (const observation_fields of [['movement'], ['health']]) {
    const filtered = {...config, observation_fields};
    assert.equal(sample(filtered).player.previous_movement, undefined);
    assert.equal(new ResearchWorld(filtered).closedPlanFeedback, false);
  }
  assert.throws(() => validateConfig({...config, action_profile: RESEARCH_SLOTS_PROFILE}), {code: 'invalid-config'});
});

const historyConfig = {...executedPlanConfig, movement_feedback: RESEARCH_CLOSED_PLAN_HISTORY_FEEDBACK};
const historyRow = (from, to, executed_ticks, age_ticks) => {
  const signed = value => Math.round(value * 10_000) / 10_000 || 0;
  return {dx: signed(to.x - from.x), dy: signed(to.y - from.y),
    executed_ticks, hp_delta: to.hp - from.hp, age_ticks};
};

test('closed plan history reaches only the observation, keeping clock, ACK, visual and replay parity', async () => {
  const config = {...historyConfig, latency_compensation_ms: 80};
  const baseline = scheduledHarness({...config, movement_feedback: 'none'});
  const experiment = scheduledHarness(config);
  const pair = [baseline, experiment];
  const read = expected => {
    const [base, next] = pair.map(({run}) => run.observe(-1, true));
    const {movement_history, ...player} = next.observation.player;
    assert.deepEqual(movement_history, expected);
    assert.deepEqual({...next.observation, player}, base.observation);
    assert.deepEqual(next.visual_frame, base.visual_frame);
  };
  const advance = (ms, tick) => {
    for (const {advance} of pair) advance(ms);
    assert.equal(experiment.run.world.tick, tick);
    assert.deepEqual(experiment.run.clockSnapshot(), baseline.run.clockSnapshot());
    assert.deepEqual(experiment.run.world.checkpoint(), baseline.run.world.checkpoint());
    assert.deepEqual(experiment.run.world.trace, baseline.run.world.trace);
    assert.deepEqual(experiment.run.actions, baseline.run.actions);
  };
  const submit = (decision_id, action_ids) => pair.map(({run}) => run.submit({
    decision_id, action_id: action_ids[0], action_ids, observation_id: run.observe().observation.observation_id,
  }));
  const state = () => baseline.run.world.snapshot().player;
  const start = state();
  const first = submit('first', [rightHold, upHold, leftHold]);
  read(undefined);
  advance(6 * TICK_MS + 1, 6);
  const [firstAck, otherFirstAck] = await Promise.all(first);
  assert.equal(firstAck.applied_tick, 1);
  assert.deepEqual(firstAck, otherFirstAck);
  read(undefined);
  const atReplacement = state();
  const next = submit('second', [upHold, rightHold, leftHold]);
  advance(TICK_MS, 7);
  const [secondAck, otherSecondAck] = await Promise.all(next);
  assert.equal(secondAck.applied_tick, 7);
  assert.deepEqual(secondAck, otherSecondAck);
  read([historyRow(start, atReplacement, 6, 1)]);
  for (const {run} of pair) run.beginLatency('refused');
  advance(60, 7);
  read([historyRow(start, atReplacement, 6, 1)]);
  for (const {run} of pair) {
    assert.equal(run.endLatency('refused').latency_compensation.paused_ms, 60);
  }
  advance(17 * TICK_MS, 24);
  const end = state();
  read([historyRow(start, atReplacement, 6, 18), historyRow(atReplacement, end, 18, 0)]);
  advance(102 * TICK_MS, 126);
  read([historyRow(start, atReplacement, 6, 120), historyRow(atReplacement, end, 18, 102)]);
  advance(TICK_MS, 127);
  read([historyRow(atReplacement, end, 18, 103)]);
  advance(18 * TICK_MS, 145);
  read(undefined);
  const rejected = submit('never-executed', [rightHold, upHold]);
  const pendingRejections = rejected.map(promise => assert.rejects(promise, {code: 'terminal'}));
  read(undefined);
  const [baseResult, result] = pair.map(({run}) => run.finish('interrupted'));
  await Promise.all(pendingRejections);
  assert.deepEqual(result, baseResult);
  assert.equal(result.actions.length, 2);
  read(undefined);
  const replay = await replayResearch({config: experiment.run.config, initial_state: experiment.initial_state,
    actions: result.actions, result: result.result});
  assert.equal(replay.consistent, true);
});

test('closed plan history keeps four positive-length closures and clears terminal state', () => {
  const config = validateConfig({...historyConfig, max_ticks: 220});
  assert.throws(() => validateConfig({...config, action_profile: RESEARCH_SLOTS_PROFILE}), {code: 'invalid-config'});
  const world = new ResearchWorld(config);
  const expected = [];
  for (const hold of [upHold, rightHold, leftHold, rightHold, upHold]) {
    const start = world.snapshot().player;
    world.advance(hold, [hold]);
    assert.deepEqual(world.movementHistory(), expected.length ? expected.slice(-4).map(({tick, row}) =>
      ({...row, age_ticks: world.tick - tick})) : undefined);
    for (let step = 1; step < 6; step++) world.advance();
    expected.push({tick: world.tick, row: historyRow(start, world.snapshot().player, 6, 0)});
    assert.deepEqual(world.movementHistory(), expected.slice(-4).map(({tick, row}) =>
      ({...row, age_ticks: world.tick - tick})));
    assert.equal(world.previousMovement(), undefined);
  }
  const receipt = world.movementHistory();
  receipt[0].dx = 123;
  assert.notEqual(world.movementHistory()[0].dx, 123);
  world.finish('interrupted');
  assert.equal(world.movementHistory(), undefined);
  assert.equal(world.closedPlanHistory.length, 0);
  assert.equal(new ResearchWorld(config).movementHistory(), undefined);
});

test('closed plan history isolates failed replacement, damage, upgrade and visibility', () => {
  const config = validateConfig({...historyConfig, fixture: 'pending-upgrade'});
  const world = new ResearchWorld(config);
  const baseline = new ResearchWorld({...config, movement_feedback: 'none'});
  const read = (configOverride = config) => projectObservation({
    snapshot: world.snapshot(), config: configOverride, runId: 'history', movement: world.movementVector(),
    sampledAt: 0, now: () => 0, movementHistory: world.movementHistory(),
  }).observation;
  const step = (action, ids) => {
    assert.deepEqual(world.advance(action, ids), baseline.advance(action, ids));
    assert.deepEqual(world.checkpoint(), baseline.checkpoint());
  };
  const start = baseline.snapshot().player;
  step(rightHold, [rightHold, upHold]);
  const hit = baseline.snapshot().player;
  assert.ok(hit.hp < start.hp);
  const offer = read().upgrade_offer;
  assert.ok(offer);
  assert.equal(read().player.movement_history, undefined);
  const engine = world.engine;
  world.engine = {...engine, advance() { throw new Error('failed replacement'); }};
  const initialHistory = world.closedPlanHistory;
  assert.throws(() => world.advance(upHold, [upHold]), /failed replacement/);
  assert.equal(world.closedPlanHistory, initialHistory);
  assert.deepEqual(world.checkpoint(), baseline.checkpoint());
  world.engine = engine;
  for (const fixture of [world, baseline]) {
    const checkpoint = fixture.engine.exportState();
    checkpoint.state.pickups.push({id: checkpoint.state.nextId++, kind: 'roast', x: fixture.x, y: fixture.y});
    fixture.engine.restoreState(checkpoint);
  }
  step(`choose:${offer.offer_id}:${offer.options[0].option_id}`);
  assert.ok(baseline.snapshot().player.hp > hit.hp);
  const outcome = historyRow(start, hit, 1, 1);
  assert.deepEqual(read().player.movement_history, [outcome]);
  for (const fields of [['health'], ['movement']]) {
    assert.equal(read({...config, observation_fields: fields}).player.movement_history, undefined);
    assert.equal(new ResearchWorld({...config, observation_fields: fields}).closedPlanHistoryFeedback, false);
  }
  assert.equal(read({...config, movement_feedback: RESEARCH_CLOSED_PLAN_FEEDBACK}).player.movement_history, undefined);
});

test('closed plan history drops existing records when the player dies', () => {
  const world = new ResearchWorld(validateConfig(historyConfig));
  world.advance(rightHold, [rightHold]);
  for (let tick = 2; tick <= 6; tick++) world.advance();
  assert.equal(world.movementHistory().length, 1);
  const checkpoint = world.engine.exportState();
  checkpoint.state.player.hp = 1;
  checkpoint.state.player.invulnerableUntil = 0;
  checkpoint.state.whip.nextTick = 80;
  checkpoint.state.whipStrikes = [];
  checkpoint.state.pendingWhips = [];
  for (const enemy of checkpoint.state.enemies.slice(0, 3)) {
    Object.assign(enemy, {x: world.x, y: world.y + 0.15, frozenUntil: 0});
  }
  world.engine.restoreState(checkpoint);
  world.advance(upHold, [upHold]);
  assert.equal(world.reason, 'death');
  assert.equal(world.movementHistory(), undefined);
  assert.equal(world.closedPlanHistory.length, 0);
});

const trailConfig = {...historyConfig, visual_trail: RESEARCH_ACTUAL_TRAIL_MODE, max_ticks: 240};
const trailPoint = world => ({tick: world.tick, x: world.x, y: world.y});

test('actual trail records only committed ticks and wraps at 121 positions', () => {
  assert.throws(() => validateConfig({...trailConfig, visual_trail: 'unknown'}), {code: 'invalid-config'});
  const world = new ResearchWorld(validateConfig(trailConfig));
  const baseline = new ResearchWorld(validateConfig({...historyConfig, max_ticks: 240}));
  const initial = world.actualTrail();
  const expected = [trailPoint(baseline)];
  assert.deepEqual(initial, expected);
  assert.equal(baseline.actualTrail(), undefined);
  assert.equal(Object.hasOwn(baseline.config, 'visual_trail'), false);
  for (let tick = 1; tick <= 146; tick++) {
    const ids = tick === 2 ? [rightHold, upHold, leftHold] : tick === 9 ? [leftHold, rightHold, upHold] : undefined;
    assert.deepEqual(world.advance(ids?.[0], ids), baseline.advance(ids?.[0], ids));
    expected.push(trailPoint(baseline));
    assert.deepEqual(world.actualTrail(), expected.slice(-121));
  }
  assert.deepEqual(world.trace, baseline.trace);
  assert.deepEqual(world.checkpoint(), baseline.checkpoint());
  assert.deepEqual(initial, expected.slice(0, 1));
  assert.ok(Object.isFrozen(initial) && Object.isFrozen(initial[0]));
  assert.deepEqual({x: expected[145].x, y: expected[145].y}, {x: expected[146].x, y: expected[146].y});
  const before = world.actualTrail();
  const engine = world.engine;
  world.engine = {...engine, advance() { throw new Error('failed advance'); }};
  assert.throws(() => world.advance(rightHold, [rightHold]), /failed advance/);
  assert.deepEqual(world.actualTrail(), before);
  world.engine = engine;
  world.finish('interrupted');
  assert.equal(world.actualTrail(), undefined);
  assert.equal(before.at(-1).tick, 146);
  assert.deepEqual(new ResearchWorld(validateConfig(trailConfig)).actualTrail(), initial);
});

test('a JSON-only sample binds its exact trail before lazy visual projection', async () => {
  const baseline = scheduledHarness({...historyConfig, max_ticks: 240, latency_compensation_ms: 80});
  const trail = scheduledHarness({...trailConfig, latency_compensation_ms: 80});
  const observations = [baseline, trail].map(({run}) => run.observe());
  assert.deepEqual(observations[1].observation, observations[0].observation);
  assert.equal(Object.hasOwn(observations[1], 'visual_frame'), false);
  let copies = 0;
  const readTrail = trail.run.world.actualTrail.bind(trail.run.world);
  trail.run.world.actualTrail = () => { copies++; return readTrail(); };
  const submit = ({run}) => run.submit({decision_id:'movement', action_id:rightHold, action_ids:[rightHold],
    observation_id:run.observe().observation.observation_id});
  const acks = [baseline, trail].map(submit);
  for (const pair of [baseline, trail]) pair.advance(TICK_MS * 6 + 1);
  const [baseAck, trailAck] = await Promise.all(acks);
  assert.deepEqual(trailAck, baseAck);
  const baseSample = baseline.run.observe();
  const sample = trail.run.observe();
  assert.deepEqual(sample.observation, baseSample.observation);
  assert.equal(copies, 1);
  for (const pair of [baseline, trail]) {
    pair.run.beginLatency('no-action');
    pair.advance(60);
    pair.run.endLatency('no-action');
  }
  assert.deepEqual(trail.run.clockSnapshot(), baseline.run.clockSnapshot());
  // Advance the underlying ring directly, bypassing the normal sample invalidation.
  // A lazy projection must still use the immutable sampled points.
  const points = readTrail();
  for (let tick = 0; tick < 122; tick++) trail.run.world.advance();
  const {actual_trail, ...frame} = trail.run.observe(-1, true).visual_frame;
  assert.deepEqual(frame, baseline.run.observe(-1, true).visual_frame);
  assert.deepEqual(actual_trail, points);
  assert.deepEqual(actual_trail.at(-1), {tick: sample.observation.tick, x: frame.player.x, y: frame.player.y});
  assert.equal(copies, 1);
});

test('actual trail copy timing belongs only to the observer that populated the cache', () => {
  const baseline = harness({...historyConfig, max_ticks: 240});
  const trail = harness(trailConfig);
  const startKey = 'actual_trail_capture_started_at_ms';
  const finishKey = 'actual_trail_capture_finished_at_ms';
  function traceClock(run) {
    const read = run.now;
    let calls = 0;
    run.now = () => { calls++; return read(); };
    return () => calls;
  }
  const baselineCalls = traceClock(baseline.run);
  const trailCalls = traceClock(trail.run);
  const copyTrail = trail.run.world.actualTrail.bind(trail.run.world);
  trail.run.world.actualTrail = () => { trail.shiftClock(3); return copyTrail(); };

  const untracked = baseline.run.observe().observation_timing;
  const text = trail.run.observe().observation_timing;
  assert.equal(Object.hasOwn(untracked, startKey), false);
  assert.equal(Object.hasOwn(untracked, finishKey), false);
  assert.equal(trailCalls() - baselineCalls(), 2);
  assert.equal(text.snapshot_cache_hit, false);
  assert.ok(text[startKey] >= text.observation_project_finished_at_ms);
  assert.equal(text[finishKey] - text[startKey], 3);
  assert.equal(text.visual_project_started_at_ms, null);

  trail.shiftClock(20);
  const lazy = trail.run.observe(-1, true).observation_timing;
  assert.ok(lazy.visual_project_started_at_ms > text[finishKey]);
  for (const sample of [lazy, trail.run.observe().observation_timing, trail.run.observe(-1, true).observation_timing]) {
    assert.equal(sample.snapshot_cache_hit, true);
    assert.equal(sample[startKey], null);
    assert.equal(sample[finishKey], null);
  }
  trail.advance(1);
  const freshVisual = trail.run.observe(-1, true).observation_timing;
  assert.equal(freshVisual.snapshot_cache_hit, false);
  assert.ok(freshVisual[startKey] >= freshVisual.observation_project_finished_at_ms);
  assert.equal(freshVisual[finishKey] - freshVisual[startKey], 3);
  assert.ok(freshVisual.visual_project_started_at_ms >= freshVisual[finishKey]);
});

test('actual trail hides upgrade and limited views while retaining the committed upgrade tick', () => {
  const config = validateConfig({...trailConfig, fixture: 'pending-upgrade'});
  const world = new ResearchWorld(config);
  const view = fields => projectVisualFrame(world.snapshot(), world.movementVector(), 0, () => 0,
    fields, world.actualTrail());
  assert.equal(view(['health']).actual_trail, undefined);
  world.advance(rightHold, [rightHold]);
  const offer = view().pendingUpgrade;
  assert.ok(offer?.length);
  assert.equal(view().actual_trail, undefined);
  world.advance(`choose:${world.offerId}:${offer[0].id}`);
  assert.equal(view().pendingUpgrade, null);
  assert.deepEqual(view().actual_trail.at(-1), trailPoint(world));
  assert.deepEqual(view().actual_trail.map(point => point.tick), [0, 1, 2]);
  world.finish('interrupted');
  assert.equal(view().actual_trail, undefined);
});

test('actual trail is suppressed at a natural terminal tick and does not change replay', async () => {
  const base = harness({...historyConfig, max_ticks: 4});
  const trial = harness({...trailConfig, max_ticks: 4});
  for (const {run, advance} of [base, trial]) {
    const pending = run.submit({decision_id: 'terminal-plan', action_id: rightHold, action_ids: [rightHold],
      observation_id: run.observe().observation.observation_id});
    advance(3);
    assert.equal((await pending).applied_tick, 1);
  }
  assert.deepEqual(trial.run.observe(-1, true).visual_frame.actual_trail.map(point => point.tick), [0, 1, 2, 3]);
  for (const {advance} of [base, trial]) advance(1);
  const terminal = trial.run.result();
  assert.equal(terminal.result.reason, 'time-limit');
  assert.deepEqual(terminal, base.run.result());
  assert.equal(trial.run.observe(-1, true).visual_frame.actual_trail, undefined);
  const replay = await replayResearch({config: trial.run.config, initial_state: trial.initial_state, ...terminal});
  assert.equal(replay.consistent, true);
});

test('calibrated compensation defaults off and validates fractional finite budgets', () => {
  assert.equal(validateConfig().latency_compensation_ms, 0);
  for (const budget of [0, 42.125, MAX_RESEARCH_LATENCY_COMPENSATION_MS]) {
    assert.equal(validateConfig({latency_compensation_ms: budget}).latency_compensation_ms, budget);
  }
  for (const budget of [-1, 1000.01, Infinity, NaN, '180', null]) {
    assert.throws(() => validateConfig({latency_compensation_ms: budget}), {code: 'invalid-config'});
  }
});

test('compensation charges short requests only until end and resumes automatically for long requests', async () => {
  // 180 is a test input, not the runtime default or a measured calibration.
  for (const [budget, duration, expectedPause] of [[0, 200, 0], [180, 50, 50],
    [180, 200, 180], [180, 500, 180], [82.5, 200, 82.5]]) {
    const {run, advance, events} = scheduledHarness({latency_compensation_ms: budget});
    const {observation} = run.observe();
    const {latency_compensation: begin} = run.beginLatency('decision');
    assert.equal(begin.active, budget > 0);
    if (budget > 0) {
      advance(Math.min(budget, duration));
      assert.equal(run.world.tick, 0);
      advance(duration - Math.min(budget, duration));
    } else advance(duration);
    const expectedTick = Math.floor((duration - expectedPause) / TICK_MS + 1e-6);
    assert.equal(run.world.tick, expectedTick);
    const {latency_compensation: receipt} = run.endLatency('decision');
    assert.equal(receipt.paused_ms, expectedPause);
    assert.equal(receipt.reason, !budget ? 'disabled' : duration < budget ? 'request-ended' : 'budget-expired');
    assert.deepEqual(run.endLatency('decision').latency_compensation, receipt);
    const action = run.submit({observation_id: observation.observation_id, decision_id: 'decision', action_id: 'stop'});
    advance(TICK_MS);
    const ack = await action;
    assert.equal(ack.latency_compensated_ms, expectedPause);
    assert.ok(Math.abs(ack.adjusted_observation_age_ms - (ack.observation_age_ms - expectedPause)) < 1e-8);
    const result = run.finish().result;
    assert.equal(result.latency_compensated_ms, expectedPause);
    assert.equal(result.effective_elapsed_ms, result.elapsed_ms - expectedPause);
    assert.equal(result.environment_valid, true);
    assert.equal(events('latency_compensation_started').length, budget ? 1 : 0);
    assert.equal(events('latency_compensation_ended').length, budget ? 1 : 0);
  }
});

test('late resume exposes clock drift and never credits a blocked Worker past the deadline', () => {
  const {run, advance, events} = scheduledHarness({latency_compensation_ms: 180});
  const {latency_compensation: begin} = run.beginLatency('late');
  advance(1600, false);
  const live = run.result().result;
  assert.equal(live.latency_compensated_ms, 180);
  assert.equal(live.effective_elapsed_ms, 1420);
  assert.equal(live.clock.latency_pause_active, false);
  advance(0);
  const receipt = run.endLatency('late').latency_compensation;
  assert.equal(receipt.ended_at_ms, begin.deadline_at_ms);
  assert.equal(receipt.paused_ms, 180);
  assert.equal(events('latency_compensation_ended').length, 1);
  const {result} = run.finish();
  assert.equal(result.environment_valid, false);
  assert.ok(result.environment_reasons.includes('clock-lag'));
  assert.ok(result.clock.max_backlog_ticks > 60);
});

test('duplicate and out-of-order latency messages do not reopen or end another round', () => {
  const {run, advance} = scheduledHarness({latency_compensation_ms: 35});
  const first = run.beginLatency('first').latency_compensation;
  assert.deepEqual(run.beginLatency('first').latency_compensation, first);
  assert.throws(() => run.beginLatency('second'), {code: 'latency-in-flight'});
  assert.throws(() => run.endLatency('unknown'), {code: 'unknown-decision'});
  advance(36);
  assert.throws(() => run.beginLatency('second'), {code: 'latency-in-flight'});
  const closed = run.endLatency('first').latency_compensation;
  run.beginLatency('second');
  assert.deepEqual(run.beginLatency('first').latency_compensation, closed);
  assert.deepEqual(run.endLatency('first').latency_compensation, closed);
  advance(10);
  assert.equal(run.clockSnapshot().latency_pause_active, true);
  assert.equal(run.endLatency('second').latency_compensation.paused_ms, 10);
  assert.equal(run.finish().result.latency_compensated_ms, 45);
  assert.throws(() => run.beginLatency('third'), {code: 'terminal'});
});

test('failed or disconnected requests can release early or after expiry without applying actions', async () => {
  const {run, advance, events} = scheduledHarness({latency_compensation_ms: 95});
  run.beginLatency('failed-before-budget');
  advance(23);
  assert.equal(run.endLatency('failed-before-budget').latency_compensation.paused_ms, 23);
  advance(TICK_MS);
  assert.equal(run.world.tick, 1);

  run.beginLatency('timed-out-after-budget');
  advance(200);
  assert.equal(run.world.tick, 7);
  const expired = run.endLatency('timed-out-after-budget').latency_compensation;
  assert.equal(expired.paused_ms, 95);
  assert.equal(expired.reason, 'budget-expired');
  assert.equal(run.result().actions.length, 0);
  assert.equal(events('latency_compensation_ended').length, 2);
  assert.equal(run.finish().result.latency_compensated_ms, 118);
});

test('stop and lifecycle changes release a window and keep invalid runs invalid', () => {
  const stopped = scheduledHarness({latency_compensation_ms: 125});
  stopped.run.beginLatency('stopped');
  stopped.advance(31);
  const {result} = stopped.run.finish('interrupted');
  assert.equal(stopped.timers.size, 0);
  assert.equal(result.elapsed_ms, 31);
  assert.equal(result.effective_elapsed_ms, 0);
  assert.equal(result.latency_compensated_ms, 31);
  assert.equal(result.environment_valid, false);
  assert.equal(stopped.run.endLatency('stopped').latency_compensation.reason, 'run-ended');

  for (const state of ['hidden', 'pagehide', 'freeze']) {
    const {run, advance} = scheduledHarness({latency_compensation_ms: 125});
    run.beginLatency(state);
    advance(31);
    run.lifecycle(state);
    const receipt = run.endLatency(state).latency_compensation;
    assert.equal(receipt.paused_ms, 31);
    assert.equal(receipt.reason, state === 'hidden' ? 'page-hidden' : state);
    assert.equal(run.beginLatency('after').latency_compensation.reason, 'environment-invalid');
    assert.equal(run.endLatency('after').latency_compensation.paused_ms, 0);
    advance(50);
    assert.equal(run.world.tick, 3);
    const final = run.finish().result;
    assert.equal(final.latency_compensated_ms, 31);
    assert.ok(final.environment_reasons.includes(`page-${state}`));
  }
});

test('compensation preserves raw observation age limits and replays with historical config', async () => {
  const {run, advance, initial_state} = scheduledHarness({latency_compensation_ms: 82.5, max_observation_age_ms: 40});
  const {observation} = run.observe();
  run.beginLatency('stale');
  advance(50);
  run.endLatency('stale');
  await assert.rejects(run.submit({
    observation_id: observation.observation_id, decision_id: 'stale', action_id: 'stop',
  }), {code: 'observation-expired'});

  advance(TICK_MS);
  const fresh = run.observe().observation;
  run.beginLatency('fresh');
  advance(10);
  run.endLatency('fresh');
  const action = run.submit({
    observation_id: fresh.observation_id, decision_id: 'fresh', action_id: 'move:right:hold:100',
  });
  advance(TICK_MS);
  assert.equal((await action).latency_compensated_ms, 10);
  advance(50);
  const outcome = run.finish();
  const withCompensation = await replayResearch({config: run.config, initial_state, ...outcome});
  const {latency_compensation_ms, ...historicalConfig} = run.config;
  const historical = await replayResearch({config: historicalConfig, initial_state, ...outcome});
  assert.equal(withCompensation.consistent, true);
  assert.equal(historical.consistent, true);
  assert.equal(withCompensation.result.state_hash, historical.result.state_hash);
});

test('the dense one-minute opening adds visible enemies and replays the same hits', async () => {
  const config = validateConfig({seed: 11, max_ticks: 3600, pressure_profile: RESEARCH_PRESSURE});
  const {pressure_profile, ...legacyConfig} = config;
  const legacy = new ResearchWorld(legacyConfig);
  const dense = new ResearchWorld(config);
  assert.ok(dense.snapshot().enemies.length >= legacy.snapshot().enemies.length * 2);
  assert.ok(dense.snapshot().enemies.some(({x, y}) => Math.abs(x) <= 16 && Math.abs(y) <= 9));
  const initial_state = dense.initialState();
  const hits = [];
  while (!dense.done) hits.push(...dense.advance().filter(event => event.type === 'player_hit'));
  const stats = dense.performanceResult();
  assert.ok(hits.length > 0);
  assert.equal(stats.hits_taken, hits.length);
  assert.equal(stats.damage_taken, hits.reduce((total, hit) => total + hit.damage, 0));
  const result = {...stats, status: 'ended', schema: initial_state.schema, rules: initial_state.rules, engine: initial_state.engine};
  const replay = await replayResearch({config, initial_state, result, actions: []});
  assert.equal(replay.consistent, true);
  assert.equal(replay.result.hits_taken, stats.hits_taken);
  assert.equal(stats.gems_collected, dense.snapshot().player.gemsCollected);
  assert.equal(replay.result.gems_collected, stats.gems_collected);
  assert.throws(() => validateConfig({pressure_profile: 'invalid'}), {code: 'invalid-config'});
});

test('simulation advances during 50, 200, 500 and 2000ms model waits and reads the newest tick', async () => {
  const {run, advance, submit, events} = harness({seed: 11});
  for (const [index, ms] of [50, 200, 500, 2000].entries()) {
    const sample = run.observe().observation;
    const next = run.observe(sample.tick);
    advance(Math.floor(ms / TICK_MS + 1e-4));
    assert.equal((await next).observation.tick, sample.tick + 1);
    assert.ok(run.observe().observation.tick > sample.tick);
    const accepted = submit(`delay-${ms}`, 'stop', sample);
    const applied = run.world.tick + 1;
    advance(1);
    const ack = await accepted;
    assert.equal(ack.applied_tick, applied);
    assert.equal(ack.observation_tick, sample.tick);
    assert.ok(ack.observation_age_ms >= ms - 1e-8);
    assert.equal(run.result().result.decisions, index + 1);
  }
  assert.equal(events('action_applied').length, 4);
  assert.equal(run.finish().result.environment_valid, true);
});

test('hold executes precisely 12 0.61 ticks, then stops without a second decision', async () => {
  const {run, advance, submit, events} = harness();
  const baseline = createBaseline({seed: 1});
  const accepted = submit('hold', 'move:up-right:hold:200');
  advance(1);
  assert.equal((await accepted).applied_tick, 1);
  advance(11);
  for (let i = 0; i < 12; i++) baseline.step({moveX: 1, moveY: -1}, 1);
  assert.equal(run.world.x, baseline.snapshot().player.x);
  assert.equal(run.world.y, baseline.snapshot().player.y);
  assert.equal(run.world.movementInfo().action_id, 'stop');
  const x = run.world.x;
  advance(120);
  assert.equal(run.world.x, x);
  assert.equal(events('movement_ended')[0].reason, 'hold-expired');
  assert.equal(events('movement_ended')[0].tick, 12);
  assert.equal(run.result().result.decisions, 1);
});

test('fine holds expose 49 unique actions and preserve upgrades and legacy holds', () => {
  const expectedDirections = ['up', 'up-right', 'right', 'down-right', 'down', 'down-left', 'left', 'up-left'];
  const candidates = researchCandidates(RESEARCH_FINE_HOLD_PROFILE);
  assert.deepEqual(candidates.map(({id}) => id), ['stop', ...expectedDirections.flatMap(direction =>
    [50, 100, 150, 200, 250, 300].map(ms => `move:${direction}:hold:${ms}`))]);
  assert.equal(new Set(candidates.map(({id}) => id)).size, 49);
  const config = validateConfig({action_profile: RESEARCH_FINE_HOLD_PROFILE, fixture: 'pending-upgrade'});
  const world = new ResearchWorld(config);
  world.advance();
  const sample = projectObservation({snapshot: world.snapshot(), config, runId: 'fine-hold',
    movement: [0, 0], sampledAt: 0, now: () => 0});
  assert.equal(validActionContext(sample), true);
  assert.deepEqual(sample.candidates.slice(0, 49), candidates);
  const offer = sample.observation.upgrade_offer;
  assert.ok(offer?.options.length > 0);
  assert.deepEqual(sample.candidates.slice(49).map(({id}) => id),
    offer.options.map(({option_id}) => `choose:${offer.offer_id}:${option_id}`));
  assert.equal(researchMovement(RESEARCH_FINE_HOLD_PROFILE, 'move:right:hold:1000'), undefined);
  assert.equal(researchMovement('hold-v1', 'move:right:hold:1000').amount, 1000);
  assert.equal(validateConfig().action_profile, 'hold-v1');
});

test('each hold travels exactly its quantized number of ticks and then stops', () => {
  const cases = RESEARCH_FINE_HOLD_DURATIONS_MS.map((ms, index) => [RESEARCH_FINE_HOLD_PROFILE, ms, 3 * (index + 1)]);
  cases.push(['hold-v1', 1000, 60]);
  for (const [action_profile, ms, ticks] of cases) {
    const world = new ResearchWorld(validateConfig({action_profile}));
    const baseline = createBaseline({seed: 1});
    const action = `move:right:hold:${ms}`;
    for (let tick = 1; tick <= ticks; tick++) {
      const events = world.advance(tick === 1 ? action : null);
      baseline.step({moveX: 1, moveY: 0}, 1);
      assert.equal(world.x, baseline.snapshot().player.x);
      assert.equal(world.movementInfo().remaining_ticks, ticks - tick);
      assert.deepEqual(events.filter(({type}) => type === 'movement_ended').map(event => [event.reason, event.tick]),
        tick === ticks ? [['hold-expired', ticks]] : []);
    }
    assert.ok(world.x > 0);
    assert.equal(world.movementInfo().action_id, 'stop');
    const {x, y} = world;
    world.advance();
    assert.deepEqual([world.x, world.y], [x, y]);
  }
});

test('fine holds can be replaced and stopped, and the applied sequence replays identically', async () => {
  const {run, advance, submit, initial_state, events} = harness({action_profile: RESEARCH_FINE_HOLD_PROFILE});
  const first = submit('right', 'move:right:hold:300');
  advance(3);
  assert.equal((await first).applied_tick, 1);
  const x = run.world.x;
  const second = submit('up', 'move:up:hold:150');
  advance(2);
  assert.equal((await second).applied_tick, 4);
  assert.equal(run.world.x, x);
  assert.ok(run.world.y < 0);
  const y = run.world.y;
  const stopped = submit('stopped', 'stop');
  advance(12);
  assert.equal((await stopped).applied_tick, 6);
  assert.deepEqual([run.world.x, run.world.y], [x, y]);
  assert.deepEqual(events('movement_ended').map(event => [event.action_id, event.reason, event.tick]), [
    ['move:right:hold:300', 'replaced', 4], ['move:up:hold:150', 'stopped', 6],
  ]);
  const outcome = run.finish();
  const replay = await replayResearch({config: run.config, initial_state, ...outcome});
  assert.equal(replay.consistent, true);
  assert.equal(replay.result.state_hash, outcome.result.state_hash);
  assert.deepEqual(replay.result.trace, outcome.result.trace);
});

test('sequence repeats single-tick moves in order and preserves normalized direct diagonals', () => {
  const config = validateConfig({action_profile: RESEARCH_SEQUENCE_PROFILE, fixture: 'pending-upgrade'});
  const candidates = researchCandidates(RESEARCH_SEQUENCE_PROFILE);
  assert.equal(candidates.length, 57);
  assert.equal(new Set(candidates.map(({id}) => id)).size, 57);
  assert.equal(candidates.filter(({id}) => id.endsWith(':ticks:1')).length, 8);
  const world = new ResearchWorld(config);
  const direct = new ResearchWorld(config);
  const actions = ['move:left:ticks:1', 'move:up:ticks:1'];
  const sequence = [...actions, ...actions, ...actions];
  const diagonal = 'move:up-left:ticks:1';
  const ended = [];
  for (let i = 0; i < sequence.length; i++) {
    const {x, y} = world;
    const events = world.advance(i === 0 ? sequence[0] : null, i === 0 ? sequence : undefined);
    ended.push(...events.filter(({type}) => type === 'movement_ended'));
    assert.ok(i % 2 === 0 ? world.x < x && world.y === y : world.y < y && world.x === x);
    if (i < sequence.length - 1) assert.equal(world.movementInfo().plan.index, i + 1);
    direct.advance(diagonal);
  }
  assert.equal(world.x, world.y);
  assert.equal(direct.x, direct.y);
  assert.ok(Math.abs(direct.x) > Math.abs(world.x));
  assert.ok(Math.abs(Math.hypot(direct.x, direct.y) - world.distance) < 0.001);
  assert.deepEqual(ended.map(event => [event.action_id, event.tick]), sequence.map((id, index) => [id, index + 1]));
  assert.equal(world.movementInfo().action_id, 'stop');
  const {x, y} = world;
  world.advance();
  assert.deepEqual([world.x, world.y], [x, y]);

  const sample = projectObservation({snapshot: world.snapshot(), config, runId: 'sequence-candidates',
    movement: [0, 0], sampledAt: 0, now: () => 0});
  assert.ok(sample.candidates.length > 57 && sample.candidates.length <= 61);
  assert.equal(validActionContext(sample), true);
});

test('sequence truncates its tail at 18 ticks, preserves the chosen sequence, and replays', async () => {
  const {run, advance, events, initial_state} = harness({action_profile: RESEARCH_SEQUENCE_PROFILE});
  const action_ids = ['move:right:hold:250', 'move:up:hold:100', 'move:left:hold:300'];
  const request = {observation_id: run.observe().observation.observation_id,
    decision_id: 'sequence', action_id: action_ids[0], action_ids};
  const result = run.submit(request);
  assert.equal(run.submit({...request, action_ids: [...action_ids]}), result);
  await assert.rejects(run.submit({...request, action_ids: [action_ids[0], action_ids[2]]}), {code: 'decision-conflict'});
  advance(15);
  const ack = await result;
  assert.equal(ack.applied_tick, 1);
  assert.deepEqual(ack.action_ids, action_ids);
  assert.deepEqual(events('action_accepted')[0].action_ids, action_ids);
  assert.deepEqual(events('action_applied')[0].action_ids, action_ids);
  const x = run.world.x;
  assert.equal(run.world.y, 0);
  advance(3);
  const y = run.world.y;
  assert.equal(run.world.x, x);
  assert.ok(y < 0);
  assert.equal(run.world.movementInfo().action_id, 'stop');
  assert.deepEqual(events('movement_plan_truncated').map(({tick, requested_ticks, scheduled_ticks}) =>
    [tick, requested_ticks, scheduled_ticks]), [[1, 39, 18]]);
  assert.deepEqual(events('movement_plan_ended').map(({tick, reason, executed_ticks}) =>
    [tick, reason, executed_ticks]), [[18, 'completed', 18]]);
  advance(10);
  assert.deepEqual([run.world.x, run.world.y], [x, y]);
  const outcome = run.finish();
  assert.equal(outcome.result.decisions, 1);
  assert.deepEqual(outcome.actions[0].action_ids, action_ids);
  assert.equal(run.submit({...request, action_ids: [...action_ids]}), result);
  const replay = await replayResearch({config: run.config, initial_state, ...outcome});
  assert.equal(replay.consistent, true);
  assert.equal(replay.result.state_hash, outcome.result.state_hash);
  assert.deepEqual(replay.result.trace, outcome.result.trace);
  const changed = [action_ids[0], 'move:down:hold:100', action_ids[2]];
  const tampered = await replayResearch({config: run.config, initial_state, ...outcome,
    actions: [{...outcome.actions[0], action_ids: changed}]});
  assert.equal(tampered.consistent, false);
  const truncatedTail = [action_ids[0], action_ids[1], 'move:down:hold:300'];
  const tamperedTail = await replayResearch({config: run.config, initial_state, ...outcome,
    actions: [{...outcome.actions[0], action_ids: truncatedTail}]});
  assert.equal(tamperedTail.first_divergent_tick, 1);
  await assert.rejects(replayResearch({config: run.config, initial_state, ...outcome,
    actions: [{...outcome.actions[0], action_ids: undefined}]}), {code: 'invalid-replay'});
});

test('a new movement, stop or upgrade replaces a sequence and malformed sequences cannot apply', async () => {
  const {run, advance, events} = harness({action_profile: RESEARCH_SEQUENCE_PROFILE, fixture: 'pending-upgrade'});
  const submitSequence = (id, ids, first = ids[0]) => run.submit({
    observation_id: run.observe().observation.observation_id, decision_id: id, action_id: first, action_ids: ids,
  });
  const right = 'move:right:hold:100', left = 'move:left:hold:100', up = 'move:up:hold:100';
  for (const sequence of [[], [right, 'END'], [right, 'stop'], [right, 'move:up:hold:1000'], Array(7).fill(right)]) {
    assert.equal(validResearchActionSequence(right, sequence), false);
    await assert.rejects(submitSequence('invalid', sequence, right), {code: 'invalid-action-sequence'});
  }
  advance(1);
  const offer = run.observe().observation.upgrade_offer;
  const upgrade = `choose:${offer.offer_id}:${offer.options[0].option_id}`;
  await assert.rejects(submitSequence('mixed', [upgrade, up]), {code: 'invalid-action-sequence'});
  await assert.rejects(submitSequence('stale', ['choose:level-99:whip-level']), {code: 'stale-offer'});
  const first = submitSequence('first', [right, left]);
  advance(1);
  await first;
  const x = run.world.x;
  const second = submitSequence('second', [up, left]);
  advance(1);
  await second;
  assert.equal(run.world.x, x);
  const stop = submitSequence('stop', ['stop']);
  advance(12);
  assert.deepEqual((await stop).action_ids, ['stop']);
  assert.equal(run.world.x, x);
  const third = submitSequence('third', [right, left]);
  advance(1);
  await third;
  const beforeUpgrade = run.world.x;
  const choice = submitSequence('choice', [upgrade]);
  advance(16);
  assert.deepEqual((await choice).action_ids, [upgrade]);
  assert.equal(events('upgrade_selected').length, 1);
  assert.equal(run.world.x, beforeUpgrade);
  assert.equal(run.world.movementInfo().action_id, 'stop');
  assert.deepEqual(events('movement_plan_ended').map(({reason, executed_ticks}) => [reason, executed_ticks]),
    [['replaced', 1], ['stopped', 1], ['replaced', 1]]);
});

const slotLeft = 'move:left:hold:50';
const slotUp = 'move:up:hold:50';
const slotRight = 'move:right:hold:50';
const slotPlan = (...head) => [...head, ...Array(RESEARCH_SLOTS_COUNT - head.length).fill(RESEARCH_SLOT_WAIT_ID)];

function submitSlots(run, decision_id, action_ids) {
  return run.submit({observation_id: run.observe().observation.observation_id,
    decision_id, action_id: action_ids[0], action_ids});
}

test('ten fixed slots apply left, wait, up and advance the world for exactly 30 ticks', async () => {
  const {run, advance, events, initial_state} = harness({action_profile: RESEARCH_SLOTS_PROFILE});
  const candidates = run.observe().candidates;
  assert.equal(candidates.length, 9);
  assert.equal(new Set(candidates.map(({id}) => id)).size, 9);
  assert.equal(candidates.filter(({id}) => id.startsWith('move:') && id.endsWith(':hold:50')).length, 8);
  assert.ok(candidates.some(({id}) => id === RESEARCH_SLOT_WAIT_ID));
  const actions = slotPlan(slotLeft, RESEARCH_SLOT_WAIT_ID, slotUp);
  const ack = submitSlots(run, 'slots', actions);
  const baseline = createBaseline({seed: 1});
  advance(RESEARCH_SLOT_TICKS);
  for (let i = 0; i < 3; i++) baseline.step({moveX: -1, moveY: 0}, 1);
  assert.equal((await ack).applied_tick, 1);
  assert.deepEqual((await ack).action_ids, actions);
  assert.equal(run.world.x, baseline.snapshot().player.x);
  assert.equal(run.world.movementInfo().plan.index, 1);
  const {x, y} = run.world;
  const enemy = run.world.snapshot().enemies[0];
  advance(RESEARCH_SLOT_TICKS);
  assert.deepEqual([run.world.x, run.world.y], [x, y]);
  assert.equal(run.world.tick, 6);
  const currentEnemy = run.world.snapshot().enemies.find(({id}) => id === enemy.id);
  assert.notDeepEqual([currentEnemy.x, currentEnemy.y], [enemy.x, enemy.y]);
  assert.equal(run.world.movementInfo().plan.index, 2);
  advance(RESEARCH_SLOT_TICKS);
  assert.equal(run.world.x, x);
  assert.ok(run.world.y < y);
  const stoppedPosition = [run.world.x, run.world.y];
  advance(RESEARCH_SLOTS_MAX_TICKS - run.world.tick);
  assert.equal(run.world.tick, 30);
  assert.equal(run.world.movementInfo().action_id, 'stop');
  assert.equal(run.world.movementInfo().plan, undefined);
  assert.deepEqual(events('movement_plan_ended').map(({reason, executed_ticks, scheduled_segments}) =>
    [reason, executed_ticks, scheduled_segments]), [['completed', 30, 10]]);
  assert.deepEqual(events('movement_ended').map(({action_id, started_tick, tick}) => [action_id, started_tick, tick]),
    actions.map((id, index) => [id, index * 3 + 1, (index + 1) * 3]));
  advance(1);
  assert.deepEqual([run.world.x, run.world.y], stoppedPosition);
  const outcome = run.finish();
  assert.equal(outcome.result.decisions, 1);
  assert.deepEqual(outcome.actions[0].action_ids, actions);
  const replay = await replayResearch({config: run.config, initial_state, ...outcome});
  assert.equal(replay.consistent, true);
  assert.equal(replay.result.state_hash, outcome.result.state_hash);
  assert.deepEqual(replay.result.trace, outcome.result.trace);
});

test('fixed slots can be replaced during wait and keep upgrades and invalid plans separate', async () => {
  const {run, advance, events, initial_state} = harness({action_profile: RESEARCH_SLOTS_PROFILE, fixture: 'pending-upgrade'});
  for (const actions of [[slotLeft], slotPlan('stop'), slotPlan('END'), slotPlan('move:left:hold:100')]) {
    assert.equal(validResearchSlotPlan(actions[0], actions), false);
    await assert.rejects(submitSlots(run, 'invalid', actions), {code: 'invalid-action-sequence'});
  }
  const first = submitSlots(run, 'first', slotPlan(RESEARCH_SLOT_WAIT_ID, slotLeft));
  advance(1);
  await first;
  const {observation, candidates} = run.observe();
  assert.ok(observation.upgrade_offer);
  assert.ok(candidates.length > 0 && candidates.every(({id}) => id.startsWith('choose:')));
  await assert.rejects(submitSlots(run, 'bad-move', slotPlan(slotLeft)), {code: 'unknown-candidate'});
  await assert.rejects(submitSlots(run, 'mixed', slotPlan(candidates[0].id)), {code: 'invalid-action-sequence'});
  const upgrade = submitSlots(run, 'upgrade', [candidates[0].id]);
  advance(1);
  await upgrade;
  assert.equal(events('upgrade_selected').length, 1);
  assert.equal(run.world.movementInfo().plan, undefined);
  assert.equal(run.world.x, 0);
  assert.deepEqual(events('movement_plan_ended').map(({reason, executed_ticks}) => [reason, executed_ticks]),
    [['replaced', 1]]);
  const outcome = run.finish();
  assert.equal((await replayResearch({config: run.config, initial_state, ...outcome})).consistent, true);

  const movement = harness({action_profile: RESEARCH_SLOTS_PROFILE});
  const old = submitSlots(movement.run, 'old', slotPlan(RESEARCH_SLOT_WAIT_ID, slotLeft));
  movement.advance(1);
  await old;
  const replacement = submitSlots(movement.run, 'replacement', slotPlan(slotRight));
  movement.advance(4);
  assert.equal((await replacement).applied_tick, 2);
  assert.ok(movement.run.world.x > 0);
  assert.deepEqual(movement.events('movement_plan_ended').map(({reason, executed_ticks}) => [reason, executed_ticks]),
    [['replaced', 1]]);
  const moved = movement.run.finish();
  assert.equal((await replayResearch({config: movement.run.config, initial_state: movement.initial_state, ...moved})).consistent, true);
});

test('slot movement scale reflects current speed and respects the movement information boundary', () => {
  const config = validateConfig({action_profile: RESEARCH_SLOTS_PROFILE});
  const world = new ResearchWorld(config);
  const snapshot = world.snapshot();
  const input = {snapshot, runId: 'scale', movement: [0, 0], sampledAt: 0, now: () => 0};
  const scale = () => projectObservation({...input, config}).observation.player.movement_distance;
  const estimates = scale();
  assert.deepEqual(Object.values(estimates).map(value => value.toFixed(6)),
    [0.05, 0.1, 0.5].map(seconds => (snapshot.player.speed * seconds).toFixed(6)));
  const fullRight = Array(RESEARCH_SLOTS_COUNT).fill(slotRight);
  for (let tick = 1; tick <= RESEARCH_SLOTS_MAX_TICKS; tick++) {
    world.advance(tick === 1 ? slotRight : null, tick === 1 ? fullRight : undefined);
    if (tick === 3) assert.ok(Math.abs(world.x - estimates.unobstructed_50_ms) < 0.001);
    if (tick === 6) assert.ok(Math.abs(world.x - estimates.unobstructed_100_ms) < 0.001);
  }
  assert.ok(Math.abs(world.x - estimates.unobstructed_500_ms) < 0.002);
  snapshot.player.speed *= 1.2;
  assert.ok(scale().unobstructed_500_ms > estimates.unobstructed_500_ms);
  const filtered = projectObservation({...input, config: {...config, observation_fields: ['enemies']}}).observation;
  assert.equal(filtered.player.movement_distance, undefined);
  const legacy = projectObservation({...input, config: {...config, action_profile: RESEARCH_SEQUENCE_PROFILE}}).observation;
  assert.equal(legacy.player.movement_distance, undefined);
});

test('slot feedback reports closed waits and signed partial moves without crossing boundaries', async () => {
  const {run, advance, events, initial_state} = harness({
    action_profile: RESEARCH_SLOTS_PROFILE, movement_feedback: 'receipts',
  });
  assert.equal(run.observe().observation.player.movement_receipts, undefined);
  const original = submitSlots(run, 'first', slotPlan(slotLeft, RESEARCH_SLOT_WAIT_ID, slotUp));
  advance(3);
  await original;
  const complete = {action_id: slotLeft, started_tick: 1, executed_ticks: 3, dx: -0.1599, dy: 0, reason: 'completed'};
  const firstObservation = run.observe().observation;
  assert.deepEqual(firstObservation.player.movement_receipts, [complete]);
  assert.equal(firstObservation.player.movement_receipt_offset, undefined);
  const beforeWait = run.world.x;
  advance(1);
  assert.equal(run.world.x, beforeWait);
  assert.deepEqual(run.observe().observation.player.movement_receipts, [complete]);
  assert.equal(run.observe().observation.player.movement_receipt_offset, undefined);
  const replacement = submitSlots(run, 'second', slotPlan(slotUp, slotRight));
  advance(1);
  assert.equal((await replacement).applied_tick, 5);
  const wait = {action_id: RESEARCH_SLOT_WAIT_ID, started_tick: 4, executed_ticks: 1, dx: 0, dy: 0, reason: 'replaced'};
  const active = run.observe().observation.player;
  assert.deepEqual(active.movement_receipts, [complete, wait]);
  assert.deepEqual(active.movement_receipt_offset, {dx: 0, dy: -0.0533});
  assert.deepEqual(run.world.movementInfo().receipt_offset, active.movement_receipt_offset);
  const boundary = submitSlots(run, 'third', slotPlan(slotRight, slotUp));
  advance(1);
  await boundary;
  const partial = {action_id: slotUp, started_tick: 5, executed_ticks: 1, dx: 0, dy: -0.0533, reason: 'replaced'};
  assert.deepEqual(run.observe().observation.player.movement_receipts, [complete, wait, partial]);
  assert.deepEqual(run.observe().observation.player.movement_receipt_offset, {dx: 0.0533, dy: 0});
  advance(2);
  const exactBoundary = submitSlots(run, 'fourth', slotPlan(RESEARCH_SLOT_WAIT_ID));
  advance(1);
  await exactBoundary;
  assert.deepEqual(run.observe().observation.player.movement_receipts.map(row => row.started_tick), [1, 4, 5, 6]);
  assert.deepEqual(firstObservation.player.movement_receipts, [complete]);
  const outcome = run.finish();
  const terminalReceipt = events('movement_ended').at(-1).receipt;
  assert.deepEqual(terminalReceipt,
    {action_id: RESEARCH_SLOT_WAIT_ID, started_tick: 9, executed_ticks: 1, dx: 0, dy: 0, reason: 'run-ended'});
  const replay = await replayResearch({config: run.config, initial_state, ...outcome});
  assert.equal(replay.consistent, true);
  assert.deepEqual(replay.movement.receipts, run.world.movementInfo().receipts);
  const replayDuring = await replayResearch({config: run.config, initial_state, ...outcome, tick: 5});
  assert.equal(replayDuring.consistent, true);
  assert.deepEqual(replayDuring.movement.receipt_offset, active.movement_receipt_offset);
  const oldReplay = await replayResearch({
    config: {...run.config, movement_feedback: 'none'}, initial_state, ...outcome,
  });
  assert.equal(oldReplay.consistent, true);
  assert.equal(oldReplay.movement.receipts, undefined);
});

test('slot feedback retains six closed slots, is identical for text and PNG modes, and honors field filters', async () => {
  async function runFeedback(movement_feedback, observation_fields) {
    const {run, advance} = harness({action_profile: RESEARCH_SLOTS_PROFILE, movement_feedback, observation_fields});
    const accepted = submitSlots(run, 'slot-plan', Array(RESEARCH_SLOTS_COUNT).fill(slotRight));
    advance(RESEARCH_SLOTS_MAX_TICKS);
    await accepted;
    return run;
  }
  const text = await runFeedback('receipts', ['movement']);
  const png = await runFeedback('trajectory', ['movement']);
  const none = await runFeedback('none', ['movement']);
  const filtered = await runFeedback('receipts', ['enemies']);
  const expected = text.observe().observation.player.movement_receipts;
  assert.equal(expected.length, RESEARCH_MOVEMENT_RECEIPT_LIMIT);
  assert.deepEqual(expected.map(row => row.started_tick), [13, 16, 19, 22, 25, 28]);
  assert.deepEqual(png.observe().observation.player.movement_receipts, expected);
  assert.equal(none.observe().observation.player.movement_receipts, undefined);
  assert.equal(filtered.observe().observation.player.movement_receipts, undefined);
  assert.equal(filtered.world.movementInfo().receipts, undefined);
  assert.equal(filtered.world.movementInfo().receipt_offset, undefined);
  assert.deepEqual(text.finish().result.trace, none.finish().result.trace);
  assert.equal(text.result().result.state_hash, none.result().result.state_hash);
  assert.throws(() => validateConfig({movement_feedback: 'trajectory'}), {code: 'invalid-config'});
  assert.throws(() => validateConfig({action_profile: RESEARCH_SLOTS_PROFILE, movement_feedback: 'other'}), {code: 'invalid-config'});
});

test('distance uses actual length, handles replacement, and stops within one movement tick', async () => {
  const {run, advance, submit, events} = harness({action_profile: 'distance-v1'});
  const old = submit('right', 'move:right:distance:4');
  advance(5);
  await old;
  const x = run.world.x;
  assert.ok(x > 0 && x < 0.3);
  const next = submit('down', 'move:down:distance:0.5');
  advance(20);
  await next;
  assert.equal(run.world.x, x);
  const [replaced, reached] = events('movement_ended');
  assert.equal(replaced.reason, 'replaced');
  assert.equal(replaced.tick, 6);
  assert.ok(Math.abs(replaced.travelled - x) < 1e-9);
  assert.equal(reached.reason, 'distance-reached');
  assert.ok(reached.travelled >= 0.5 && reached.travelled <= 0.5 + run.world.snapshot().player.speed / TICK_HZ + 1e-6);
  assert.equal(run.world.y, reached.travelled);
  assert.equal(run.world.movementInfo().action_id, 'stop');
});

test('blocked distance times out at 300 ticks and same-boundary replacement takes priority', () => {
  const config = validateConfig({action_profile: 'distance-v1', max_ticks: 500});
  const world = new ResearchWorld(config);
  const initial = world.initialState();
  initial.checkpoint.state.player.speed = 0;
  const blocked = new ResearchWorld(config, initial);
  blocked.advance('move:right:distance:1');
  for (let tick = 2; tick < 300; tick++) blocked.advance();
  assert.equal(blocked.movementInfo().remaining_ticks, 1);
  const replaced = blocked.advance('move:up:distance:4');
  assert.equal(replaced[0].reason, 'replaced');
  assert.equal(replaced[0].travelled, 0);

  const another = new ResearchWorld(config, initial);
  another.advance('move:right:distance:1');
  for (let tick = 2; tick < 300; tick++) another.advance();
  const timeout = another.advance();
  assert.equal(timeout[0].tick, 300);
  assert.equal(timeout[0].reason, 'distance-timeout');
  assert.equal(another.movementInfo().action_id, 'stop');
});

test('duplicate decision is idempotent, with explicit rejection for stale, conflicting or invalid requests', async () => {
  const {run, advance, submit, events} = harness();
  const sample = run.observe().observation;
  const original = submit('first', 'move:right:hold:1000', sample);
  assert.equal(submit('first', 'move:right:hold:1000', sample), original);
  await assert.rejects(submit('first', 'stop', sample), {code: 'decision-conflict'});
  await assert.rejects(submit('parallel', 'stop', sample), {code: 'action-in-flight'});
  advance(1);
  assert.deepEqual(await submit('first', 'move:right:hold:1000', sample), await original);
  await assert.rejects(submit('old', 'stop', sample), {code: 'out-of-order'});
  await assert.rejects(submit('invalid', 'move:right:distance:4'), {code: 'unknown-candidate'});
  await assert.rejects(submit('offer', 'choose:level-2:whip-level'), {code: 'stale-offer'});
  await assert.rejects(run.submit({decision_id: 'unknown', observation_id: 'obs-9999', action_id: 'stop'}), {code: 'unknown-observation'});
  advance(60);
  assert.equal(events('movement_ended').at(-1).reason, 'hold-expired');
  assert.equal(run.result().result.decisions, 1);
  assert.equal(run.finish().actions.length, 1);
  assert.deepEqual(await submit('first', 'move:right:hold:1000', sample), await original);
  await assert.rejects(submit('ended', 'stop', sample), {code: 'terminal'});
});

test('actions whose samples expire before the boundary are rejected; terminal releases waiting callers', async () => {
  const {run, advance, submit} = harness({max_observation_age_ms: 10});
  const accepted = submit('too-slow', 'stop');
  const expired = assert.rejects(accepted, {code: 'observation-expired'});
  advance(1);
  await expired;
  const waiting = run.observe(1);
  const pending = assert.rejects(submit('stop-before-tick', 'stop'), {code: 'terminal'});
  assert.equal(run.finish().result.decisions, 0);
  await pending;
  assert.equal((await waiting).observation.terminal, true);
});

test('pending upgrade keeps options and XP while ordinary loot, treasure, damage and movement continue', async () => {
  const {run, advance, submit, events} = harness({fixture: 'pending-upgrade'});
  advance(1);
  const first = run.observe().observation;
  assert.equal(first.upgrade_offer.offer_id, 'level-2');
  assert.ok(first.player.hp < first.player.max_hp);
  assert.equal(run.result().result.damage_taken, first.player.max_hp - first.player.hp);
  assert.equal(run.result().result.max_hp, first.player.max_hp);
  const east = submit('move', 'move:right:hold:1000');
  advance(13);
  await east;
  const before = run.observe().observation;
  assert.deepEqual(before.upgrade_offer, first.upgrade_offer);
  assert.ok(before.player.xp >= first.player.xp);
  assert.equal(run.world.snapshot().pickupsCollected, 1);
  assert.equal(run.world.snapshot().chestsOpened, 1);
  assert.equal(events('treasure').length, 1);
  assert.ok(run.world.x > 0);
  const choice = `choose:level-2:${before.upgrade_offer.options[0].option_id}`;
  const chosen = submit('choose', choice);
  advance(1);
  assert.equal((await chosen).applied_tick, 15);
  assert.equal(run.world.movementInfo().action_id, 'move:right:hold:1000');
  assert.equal(run.observe().observation.upgrade_offer, null);
  advance(1);
  assert.equal(run.observe().observation.upgrade_offer.offer_id, 'level-3');
  await assert.rejects(submit('choose-again', choice), {code: 'stale-offer'});
  const checkpoint = run.world.engine.exportState().state;
  assert.equal(checkpoint.progression.receipts.filter(receipt => receipt.kind === 'upgrade').length, 1);
  assert.equal(checkpoint.progression.receipts.find(receipt => receipt.kind === 'upgrade').tick, 15);
  assert.equal(checkpoint.progression.receipts.filter(receipt => receipt.kind === 'treasure').length, 1);
});

test('human upgrade pause stops overdue ticks, applies one choice and can pause again', async () => {
  const {run, advance, events, timers, initial_state} = scheduledHarness({
    action_profile: RESEARCH_SLOTS_PROFILE, fixture: 'pending-upgrade', pause_for_upgrade: true,
  });
  const beforeOffer = run.observe().observation;
  const nextObservation = run.observe(0);
  advance(100, false);
  advance(0);
  assert.equal(run.world.tick, 1);
  assert.equal(timers.size, 0);
  const {observation, candidates} = await nextObservation;
  assert.equal(observation.tick, 1);
  assert.equal(observation.upgrade_offer.offer_id, 'level-2');
  const frozen = run.world.snapshot();
  const hash = run.world.checkpoint().state_hash;
  const movement = run.world.movementInfo();
  advance(5000);
  assert.deepEqual(run.world.snapshot(), frozen);
  assert.deepEqual(run.world.movementInfo(), movement);
  assert.equal(run.world.checkpoint().state_hash, hash);
  assert.ok(Math.abs(run.result().result.effective_elapsed_ms - TICK_MS) < 1e-8);
  assert.ok(run.result().result.upgrade_paused_ms > 5000);
  assert.equal(run.result().result.latency_compensated_ms, 0);
  assert.equal(run.result().result.clock.upgrade_pause_active, true);
  assert.throws(() => run.beginLatency('latency', 10), {code: 'invalid-latency-budget'});
  await assert.rejects(run.submit({observation_id: beforeOffer.observation_id,
    decision_id: 'late-move', action_id: slotLeft, action_ids: slotPlan(slotLeft)}), {code: 'unknown-candidate'});
  await assert.rejects(submitSlots(run, 'wrong-offer', ['choose:level-99:whip-level']), {code: 'stale-offer'});
  assert.equal(timers.size, 0);
  const action = {observation_id: observation.observation_id, decision_id: 'selected', action_id: candidates[0].id,
    action_ids: [candidates[0].id]};
  const selected = run.submit(action);
  assert.equal(run.submit(action), selected);
  assert.equal(run.world.tick, 1);
  assert.equal(events('upgrade_pause_ended').length, 0);
  advance(1.1 * TICK_MS);
  assert.equal((await selected).applied_tick, 2);
  assert.equal(events('upgrade_selected').length, 1);
  assert.equal(events('upgrade_pause_ended').at(-1).reason, 'selected');
  advance(TICK_MS);
  assert.equal(run.world.tick, 3);
  assert.equal(run.observe().observation.upgrade_offer.offer_id, 'level-3');
  assert.equal(timers.size, 0);
  const waiter = run.observe(3);
  advance(2500);
  const outcome = run.finish();
  assert.equal((await waiter).terminal, true);
  assert.equal(outcome.result.tick, 3);
  assert.equal(outcome.result.reason, 'stopped');
  assert.equal(outcome.result.clock.upgrade_pause_active, false);
  assert.ok(outcome.result.upgrade_paused_ms > 7500);
  assert.ok(Math.abs(outcome.result.effective_elapsed_ms - 3 * TICK_MS) < 1e-8);
  assert.ok(!outcome.result.environment_reasons.includes('clock-drift'));
  assert.deepEqual(events('upgrade_pause_started').map(event => event.tick), [1, 3]);
  assert.deepEqual(events('upgrade_pause_ended').map(({tick, reason}) => [tick, reason]), [[2, 'selected'], [3, 'run-ended']]);
  const replay = await replayResearch({config: run.config, initial_state, ...outcome});
  assert.equal(replay.consistent, true);
  assert.equal(replay.result.state_hash, outcome.result.state_hash);
});

test('stopping before an accepted human upgrade applies preserves the pending offer', async () => {
  const {run, advance, events, timers} = scheduledHarness({
    action_profile: RESEARCH_SLOTS_PROFILE, fixture: 'pending-upgrade', pause_for_upgrade: true,
  });
  advance(1.1 * TICK_MS);
  const {candidates} = run.observe();
  advance(1000);
  const accepted = assert.rejects(submitSlots(run, 'selected', [candidates[0].id]), {code: 'terminal'});
  assert.equal(timers.size, 1);
  const {result, actions} = run.finish();
  await accepted;
  assert.equal(result.tick, 1);
  assert.deepEqual(actions, []);
  assert.equal(timers.size, 0);
  assert.equal(events('upgrade_selected').length, 0);
  assert.equal(events('upgrade_pause_ended').at(-1).reason, 'run-ended');
});

test('upgrade pause requires unexpired fixed slot observations and no network compensation', () => {
  assert.equal(validateConfig().pause_for_upgrade, undefined);
  assert.equal(validateConfig({pause_for_upgrade: false}).pause_for_upgrade, undefined);
  const slots = {action_profile: RESEARCH_SLOTS_PROFILE, pause_for_upgrade: true};
  assert.equal(validateConfig(slots).pause_for_upgrade, true);
  for (const config of [{pause_for_upgrade: true}, {...slots, pause_for_upgrade: 'true'},
    {...slots, latency_compensation_ms: 10}, {...slots, max_observation_age_ms: 100}]) {
    assert.throws(() => validateConfig(config), {code: 'invalid-config'});
  }
});

test('XP collected while an upgrade waits is retained without replacing the offer', () => {
  const game = createSurvivorsGame({seed: 11});
  const initial = game.exportState();
  const state = initial.state;
  state.player.xp = state.player.xpToNext;
  state.player.xpEarned = state.player.xp;
  state.gems.push({id: state.nextId++, x: 0, y: 0, value: 80});
  game.restoreState(initial);
  const first = game.step();
  assert.equal(first.player.level, 2);
  for (let i = 0; i < 30; i++) game.step();
  const waiting = game.snapshot();
  assert.deepEqual(waiting.pendingUpgrade, first.pendingUpgrade);
  assert.equal(waiting.player.xp, 80);
  assert.equal(waiting.player.gemsCollected, 1);
  assert.equal(waiting.player.level, 2);
  assert.throws(() => game.step({reroll: true}), /reroll unavailable/);
});

test('view projection filters before truncation, tie-breaks IDs, rounds and hides internal fields', () => {
  const snapshot = createSurvivorsGame().snapshot();
  snapshot.enemies = [
    {id: 100, kind: 'bat', x: 16.00001, y: 0, radius: 2},
    {id: 101, kind: 'bat', x: 0, y: 9.00001, radius: 2},
    ...Array.from({length: 25}, (_, i) => ({id: 26 - i, kind: 'bat', x: 1.234,
      y: -0.076, radius: 0.23, hp: 3, vx: 0.12, vy: 0.13})),
    {id: 104, kind: 'bat', x: 16, y: 9, radius: 0.4},
  ];
  snapshot.gems = [
    {id: 105, x: -16, y: -9, value: 3, attraction: {startTick: 0, startX: -16, startY: -9}},
    {id: 106, x: 0, y: -9.01, value: 9},
  ];
  snapshot.projectiles = [{id: 107, kind: 'wand', x: 1, y: 2, radius: 0.15, vx: 2, vy: 0, ttl: 19}];
  const params = {snapshot, runId: 'view', movement: [0, 0], sampledAt: 1, now: () => 2};
  const compact = projectObservation({...params, config: validateConfig()}).observation;
  const detail = projectObservation({...params, config: validateConfig({observation_profile: 'state-detail-v1'})}).observation;
  assert.deepEqual(compact.coverage.enemies, {visible: 26, sent: 24, truncated: true});
  assert.deepEqual(detail.coverage.enemies, {visible: 26, sent: 26, truncated: false});
  assert.equal(compact.enemies[0].id, 2);
  assert.equal(compact.enemies[0].dx, 1.2);
  assert.equal(compact.enemies[0].dy, -0.1);
  assert.equal(detail.enemies[0].dx, 1.23);
  assert.equal(detail.enemies[0].dy, -0.08);
  assert.deepEqual(detail.enemies[0].velocity, [0.12, 0.13]);
  assert.equal(detail.enemies[0].hp, 3);
  assert.equal(compact.enemies[0].hp, undefined);
  assert.equal(detail.enemies.at(-1).id, 104);
  assert.equal(compact.player.gem_pickup_radius, snapshot.player.magnet);
  assert.deepEqual(compact.loot, [{id: 105, kind: 'experience', dx: -16, dy: -9, being_collected: true}]);
  assert.deepEqual(detail.loot, [{...compact.loot[0], value: 3}]);
  assert.deepEqual(detail.hazards[0], {id: 107, kind: 'wand', dx: 1, dy: 2, hostile: false,
    velocity: [2, 0], shape: 'circle', radius: 0.15, remaining_ticks: 19});
  assert.equal(detail.rng, undefined);
  assert.equal(detail.evolutionRecipes, undefined);
  assert.equal(detail.sampled_at_ms, 1);
  assert.equal(detail.projected_at_ms, 2);
});

test('replay restores the initial state, reproduces choices and movement, and identifies first divergent tick', async () => {
  const {run, advance, initial_state, submit} = harness({fixture: 'pending-upgrade'});
  advance(1);
  const move = submit('move', 'move:right:hold:1000');
  advance(1);
  await move;
  const {upgrade_offer} = run.observe().observation;
  const choose = submit('upgrade', `choose:${upgrade_offer.offer_id}:${upgrade_offer.options[0].option_id}`);
  advance(1);
  await choose;
  advance(9);
  const replace = submit('replace', 'move:down-left:hold:100');
  advance(75);
  await replace;
  const evidence = run.finish();
  const input = {config: run.config, initial_state, ...evidence};
  const replay = await replayResearch(JSON.parse(JSON.stringify(input)));
  assert.equal(replay.consistent, true);
  assert.deepEqual(replay.snapshot, run.world.snapshot());
  assert.equal(replay.result.state_hash, evidence.result.state_hash);
  assert.equal(replay.result.damage_taken, evidence.result.damage_taken);
  const otherProfile = await replayResearch({...input, config: {...run.config, observation_profile: 'state-detail-v1'}});
  assert.equal(otherProfile.result.state_hash, evidence.result.state_hash);
  const prefix = await replayResearch({...input, tick: 60});
  assert.equal(prefix.snapshot.tick, 60);
  assert.equal(prefix.consistent, true);
  const [first, ...rest] = input.actions;
  const diverged = await replayResearch({...input, actions: [{...first, action_id: 'move:left:hold:1000'}, ...rest]});
  assert.equal(diverged.consistent, false);
  assert.equal(diverged.first_divergent_tick, first.applied_tick);
  await assert.rejects(replayResearch({...input, actions: [first, first]}), {code: 'invalid-replay'});
});

test('a killing tick applies the boundary action and replays the terminal outcome', async () => {
  const {run, initial_state, advance, submit} = harness({fixture: 'pending-upgrade'});
  initial_state.checkpoint.state.player.hp = 1;
  run.world = new ResearchWorld(run.config, initial_state);
  const stop = submit('last', 'stop');
  advance(1);
  assert.equal((await stop).applied_tick, 1);
  const result = run.result();
  assert.equal(result.result.reason, 'death');
  assert.equal(result.result.decisions, 1);
  const replay = await replayResearch({config: run.config, initial_state, ...result});
  assert.equal(replay.consistent, true);
  assert.equal(replay.snapshot.player.hp, 0);
});

test('clock backlog is bounded and lifecycle and evidence interruptions invalidate the run', () => {
  const {run, advance, shiftClock, events} = harness();
  advance(5);
  shiftClock(1300);
  run.pump();
  assert.equal(run.world.tick, 11);
  assert.equal(events('clock_backlog').length, 1);
  assert.ok(run.result().result.clock.max_backlog_ticks > 70);
  for (let i = 0; i < 13; i++) run.pump();
  assert.equal(run.world.tick, 83);
  run.lifecycle('hidden');
  const {result} = run.finish('evidence-error');
  assert.equal(result.environment_valid, false);
  assert.deepEqual(result.environment_reasons.sort(), ['clock-lag', 'evidence-error', 'page-hidden']);
  assert.equal(result.clock.lag_bucket_counts.reduce((sum, n) => sum + n, 0), result.clock.pump_count);
});

test('opt-in visual and text waiters share one snapshot and do not change prior samples', async () => {
  const {run, advance, submit, events} = harness({fixture: 'pending-upgrade', max_ticks: 6});
  const snapshot = run.world.snapshot.bind(run.world);
  let snapshots = 0;
  run.world.snapshot = () => { snapshots++; return snapshot(); };

  const textWaiter = run.observe(0, false);
  const visualWaiter = run.observe(0, true);
  advance(1);
  const {observation_timing: textTiming, ...plain} = await textWaiter;
  const {visual_frame: frame, observation_timing: visualTiming, ...textFromVisual} = await visualWaiter;
  assert.deepEqual(textFromVisual, plain);
  assert.equal(textTiming.waited_for_new_tick, true);
  assert.ok(textTiming.sample_started_at_ms > textTiming.request_received_at_ms);
  assert.equal(textTiming.snapshot_cache_hit, false);
  assert.equal(textTiming.observation_cache_hit, false);
  assert.equal(textTiming.visual_cache_hit, null);
  assert.equal(textTiming.visual_project_started_at_ms, null);
  assert.equal(textTiming.visual_project_finished_at_ms, null);
  assert.equal(visualTiming.waited_for_new_tick, true);
  assert.equal(visualTiming.snapshot_cache_hit, true);
  assert.equal(visualTiming.observation_cache_hit, true);
  for (const key of ['snapshot_started_at_ms', 'snapshot_finished_at_ms',
    'observation_project_started_at_ms', 'observation_project_finished_at_ms']) {
    assert.equal(visualTiming[key], null, key);
  }
  assert.equal(visualTiming.visual_cache_hit, false);
  assert.ok(visualTiming.visual_project_started_at_ms >= visualTiming.sample_started_at_ms);
  assert.equal(visualTiming.visual_project_finished_at_ms, frame.projected_at_ms);
  assert.equal(textTiming.response_post_started_at_ms, null);
  assert.equal(plain.observation.observation_timing, undefined);
  assert.equal(snapshots, 1);
  assert.equal(events('observation_sampled').length, 1);
  assert.equal(frame.schema, VISUAL_FRAME_SCHEMA);
  assert.equal(frame.tick, plain.observation.tick);
  assert.equal(frame.sampled_at_ms, plain.observation.sampled_at_ms);
  assert.equal(frame.player.hp, plain.observation.player.hp);
  assert.deepEqual(frame.pendingUpgrade.map(option => option.id),
    plain.observation.upgrade_offer.options.map(option => option.option_id));
  const cachedText = run.observe();
  const cachedVisual = run.observe(-1, true);
  assert.equal(cachedText.visual_frame, undefined);
  assert.equal(cachedText.observation_timing.waited_for_new_tick, false);
  assert.equal(cachedText.observation_timing.visual_cache_hit, null);
  assert.equal(cachedVisual.visual_frame, frame);
  assert.equal(cachedVisual.observation_timing.visual_cache_hit, true);
  assert.equal(cachedVisual.observation_timing.visual_project_started_at_ms, null);
  assert.equal(cachedVisual.observation_timing.visual_project_finished_at_ms, null);
  assert.notEqual(cachedVisual.observation_timing, visualTiming);
  assert.equal(snapshots, 1);
  assert.throws(() => run.observe(-1, 'true'), {code: 'invalid-visual-frame-option'});

  const before = structuredClone(frame);
  const command = submit('move', 'move:right:hold:100');
  advance(1);
  await command;
  const nextPlain = run.observe(-1, false);
  assert.equal(run.lastSample.visualFrame, undefined);
  const nextFrame = run.observe(-1, true).visual_frame;
  assert.equal(nextFrame.tick, nextPlain.observation.tick);
  assert.equal(snapshots, 2);
  assert.ok(nextFrame.player.x > frame.player.x);
  assert.deepEqual(frame, before);
  const waitingAtStop = run.observe(nextFrame.tick, true);
  run.finish();
  const ended = await waitingAtStop;
  assert.equal(ended.terminal, true);
  assert.equal(ended.visual_frame.done, true);
  assert.equal(ended.visual_frame.tick, ended.observation.tick);
  assert.equal(ended.visual_frame.pendingUpgrade, null);
  assert.equal(ended.observation_timing.waited_for_new_tick, true);
  assert.equal(ended.observation_timing.snapshot_cache_hit, false);
  assert.equal(ended.observation_timing.visual_cache_hit, false);
  assert.equal(run.observe(-1, true).observation_timing.visual_cache_hit, true);
});

test('first visual observation reports disjoint Worker copy and projection phases', () => {
  let time = 100_000;
  const run = new ResearchRun({runId: 'timing-test', send: () => {}, now: () => time += 0.125});
  const first = run.observe(-1, true);
  const {observation_timing: timing} = first;
  const times = [
    timing.request_received_at_ms, timing.sample_started_at_ms,
    timing.snapshot_started_at_ms, timing.snapshot_finished_at_ms,
    timing.observation_project_started_at_ms, timing.observation_project_finished_at_ms,
    timing.visual_project_started_at_ms, timing.visual_project_finished_at_ms,
  ];
  assert.ok(times.every((value, index) => index === 0 || value > times[index - 1]));
  assert.equal(timing.snapshot_started_at_ms, first.observation.sampled_at_ms);
  assert.equal(timing.observation_project_finished_at_ms, first.observation.projected_at_ms);
  assert.equal(timing.visual_project_finished_at_ms, first.visual_frame.projected_at_ms);
  assert.equal(timing.snapshot_cache_hit, false);
  assert.equal(timing.observation_cache_hit, false);
  assert.equal(timing.visual_cache_hit, false);
  assert.equal(timing.waited_for_new_tick, false);
});

test('information presets change actual observations and full includes the entire visible set', () => {
  const snapshot = createSurvivorsGame().snapshot();
  snapshot.enemies = Array.from({length: 140}, (_, i) => ({
    id: i + 1, kind: 'bat', x: 2 + i / 100, y: 1, radius: .3, hp: 5, vx: 0, vy: 0, frozenUntil: 0,
  }));
  snapshot.enemies.push({id: 200, kind: 'ghost', x: 40, y: 0});
  const input = {snapshot, runId: 'info-test', movement: [0, 0], sampledAt: 100, now: () => 101};
  const profiles = INFORMATION_PRESETS.map(preset => {
    const config = validateConfig({observation_profile: preset.observation,
      ...(preset.fields && {observation_fields: preset.fields})});
    const payload = projectObservation({...input, config});
    assert.equal(validActionContext(payload), true);
    return payload.observation;
  });
  assert.deepEqual(Object.keys(profiles[0].player), ['hp', 'max_hp']);
  assert.equal(profiles[0].loot, undefined);
  assert.equal(profiles[1].enemies.length, 24);
  assert.equal(profiles[2].enemies.length, 128);
  assert.equal(profiles[6].enemies.length, 140);
  assert.equal(profiles[6].coverage.enemies.truncated, false);
  assert.deepEqual(profiles[6].score, {gems_collected: snapshot.player.gemsCollected, wave: snapshot.waveMinute + 1});
  assert.throws(() => validateConfig({observation_fields: ['invalid']}), {code: 'invalid-config'});
});

test('a custom image excludes disabled world objects and player information', () => {
  const snapshot = createSurvivorsGame().snapshot();
  snapshot.gems = [{id: 900, x: 1, y: 0, value: 1}];
  snapshot.enemies = [{id: 901, x: 2, y: 0, kind: 'bat'}];
  snapshot.projectiles = [{id: 902, x: 2, y: 0, kind: 'knife'}];
  const frame = projectVisualFrame(snapshot, [1, 0], 100, () => 101, ['loot']);
  assert.deepEqual(frame.gems.map(item => item.id), [900]);
  assert.deepEqual(frame.enemies, []);
  assert.deepEqual(frame.projectiles, []);
  assert.deepEqual(frame.equipment, []);
  assert.equal(frame.player.hp, undefined);
  assert.equal(frame.player.level, undefined);
  assert.equal(frame.gemsCollected, undefined);
  assert.deepEqual(frame.movement, [0, 0]);
});

test('visual frame clips to the canvas and allowlists public renderer fields', () => {
  const snapshot = createSurvivorsGame().snapshot();
  Object.assign(snapshot.player, {x: 10, y: -3});
  snapshot.enemies = [
    {id: 1, x: 26, y: 6, kind: 'bat', hp: 5, maxHp: 7, loot: 'secret'},
    {id: 2, x: 26.00001, y: 6, kind: 'bat'},
    {id: 3, x: 10, y: -12.00001, kind: 'boss'},
    {id: 4, x: -6, y: -12, kind: 'boss', boss: true, hp: 3, maxHp: 10, xp: 99},
  ];
  snapshot.gems = [{id: 5, x: 10, y: -3, value: 3, rawValue: 100,
    attraction: {startX: 20, startY: 20, startTick: 1}}];
  snapshot.chests = [{id: 6, x: 10, y: -3, tier: 2, sourceEncounterId: 30, sourceMinute: 1}];
  snapshot.projectiles = [{id: 7, x: 11, y: -2, kind: 'knife', radius: 0.5, vx: 1, vy: 1,
    hitIds: [2, 3], targetEnemyId: 3, ttl: 100}];
  snapshot.birdRays = [{id: 8, slot: 'peachone', phase: 'flight', x: 9, y: -2, radius: 0.4,
    targetX: 50, targetY: 50, impactTick: 10, hitIds: []}];
  snapshot.bibleOrbs = [{x: 11, y: -4, radius: 0.5}];
  snapshot.whip.nextTick = 99;
  snapshot.rng = 123;
  const projected = projectVisualFrame(snapshot, [0, 0], 1, () => 2);
  assert.deepEqual(projected.enemies, [
    {id: 1, x: 26, y: 6, kind: 'bat'},
    {id: 4, x: -6, y: -12, kind: 'boss', boss: true, hp: 3, maxHp: 10},
  ]);
  assert.deepEqual(projected.gems, [{id: 5, x: 10, y: -3, value: 3}]);
  assert.deepEqual(projected.chests, [{id: 6, x: 10, y: -3, tier: 2}]);
  assert.deepEqual(projected.projectiles, [{id: 7, x: 11, y: -2, kind: 'knife', radius: 0.5, vx: 1, vy: 1}]);
  assert.deepEqual(projected.birdRays, [{id: 8, slot: 'peachone', phase: 'flight', x: 9, y: -2, radius: 0.4}]);
  assert.deepEqual(projected.bibleOrbs, [{x: 11, y: -4, radius: 0.5}]);
  assert.equal(projected.whip.nextTick, undefined);
  assert.equal(projected.rng, undefined);
  assert.equal(projected.seed, undefined);
  assert.equal(projected.pendingWhips, undefined);
  assert.equal(projected.projected_at_ms, 2);
});

test('visual frame capture leaves the same fixed action trajectory and replay', async () => {
  async function drive(config, includeFrame) {
    const {run, advance, submit, initial_state} = harness({seed: 11, max_ticks: 240, ...config});
    for (let decision = 0; decision < 4; decision++) {
      const sample = run.observe(-1, includeFrame);
      if (includeFrame) assert.equal(sample.visual_frame.tick, sample.observation.tick);
      const command = submit(`move-${decision}`, 'move:right:hold:1000', sample.observation);
      advance(60);
      await command;
    }
    return {config: run.config, initial_state, ...run.result()};
  }
  const none = await drive({observation_profile: 'state-compact-v1'}, false);
  const visual = await drive({observation_profile: 'state-detail-v1'}, true);
  assert.deepEqual(visual.actions, none.actions);
  assert.equal(visual.result.state_hash, none.result.state_hash);
  assert.deepEqual(visual.result.trace, none.result.trace);
  const replay = await replayResearch(visual);
  assert.equal(replay.consistent, true);
  assert.equal(replay.result.state_hash, none.result.state_hash);
});

test('worker envelope preserves IDs and rejects an old run after creating its successor', async () => {
  const {port1, port2} = new MessageChannel();
  attachResearchWorker(port1);
  port1.start();
  let requestId = 0;
  async function ask(type, run_id, payload = {}) {
    const request_id = ++requestId;
    const response = await new Promise(resolve => {
      function onMessage(message) {
        if (message.request_id !== request_id) return;
        port2.off('message', onMessage);
        resolve(message);
      }
      port2.on('message', onMessage);
      port2.postMessage({type, run_id, request_id, ...payload});
    });
    assert.equal(response.type, type);
    assert.equal(response.run_id, run_id);
    return response;
  }
  try {
    assert.equal((await ask('research:create', 'first', {config: {max_ticks: 12}})).snapshot.tick, 0);
    assert.equal((await ask('research:create', 'another')).error.code, 'run-active');
    await ask('research:start', 'first');
    const first = await ask('research:observe', 'first', {after_tick: 0});
    assert.ok(first.observation.tick >= 1);
    assert.equal(first.visual_frame, undefined);
    assert.ok(first.observation_timing.sample_started_at_ms >= first.observation_timing.request_received_at_ms);
    assert.ok(first.observation_timing.response_post_started_at_ms >= first.observation_timing.observation_project_finished_at_ms);
    assert.equal(first.observation_timing.visual_cache_hit, null);
    const withVisual = await ask('research:observe', 'first', {after_tick: -1, include_visual_frame: true});
    assert.equal(withVisual.visual_frame.tick, withVisual.observation.tick);
    assert.equal(withVisual.visual_frame.sampled_at_ms, withVisual.observation.sampled_at_ms);
    assert.equal(withVisual.observation_timing.visual_cache_hit, false);
    assert.ok(withVisual.observation_timing.response_post_started_at_ms >= withVisual.visual_frame.projected_at_ms);
    const action = await ask('research:action', 'first',
      {decision_id: 'action-1', observation_id: first.observation.observation_id, action_id: 'stop'});
    assert.ok(action.applied_tick > first.observation.tick);
    await ask('research:stop', 'first');
    const another = await ask('research:create', 'another', {config: {latency_compensation_ms: 1000}});
    assert.equal(another.config.latency_compensation_ms, 1000);
    assert.equal((await ask('research:observe', 'first')).error.code, 'unknown-run');
    const decision = {decision_id: 'new-run-decision'};
    await ask('research:start', 'another');
    const begin = await ask('research:latency_begin', 'another', decision);
    assert.equal(begin.latency_compensation.active, true);
    assert.equal((await ask('research:latency_end', 'first', decision)).error.code, 'unknown-run');
    assert.equal((await ask('research:result', 'another')).result.clock.latency_pause_active, true);
    const stopped = await ask('research:stop', 'another');
    const ended = await ask('research:latency_end', 'another', decision);
    assert.equal(ended.latency_compensation.paused_ms, stopped.result.latency_compensated_ms);
    assert.equal(ended.latency_compensation.reason, 'run-ended');
    assert.equal((await ask('research:create', 'first')).error.code, 'run-id-reused');

    const sequence = await ask('research:create', 'sequence', {config: {action_profile: RESEARCH_SEQUENCE_PROFILE}});
    await ask('research:start', 'sequence');
    const sample = await ask('research:observe', 'sequence', {after_tick: -1});
    const action_ids = ['move:left:ticks:1', 'move:left:ticks:1', 'move:up:ticks:1'];
    const plan = await ask('research:action', 'sequence', {decision_id: 'plan',
      observation_id: sample.observation.observation_id, action_id: action_ids[0], action_ids});
    assert.deepEqual(plan.action_ids, action_ids);
    const outcome = await ask('research:stop', 'sequence');
    assert.equal(outcome.result.decisions, 1);
    assert.deepEqual(outcome.actions[0].action_ids, action_ids);
    const replay = await ask('research:replay', 'sequence', {config: sequence.config,
      initial_state: sequence.initial_state, actions: outcome.actions, result: outcome.result});
    assert.equal(replay.consistent, true);
    assert.equal(replay.result.state_hash, outcome.result.state_hash);

    const slots = await ask('research:create', 'slots', {config: {action_profile: RESEARCH_SLOTS_PROFILE}});
    await ask('research:start', 'slots');
    const slotSample = await ask('research:observe', 'slots', {after_tick: -1});
    const slotIds = slotPlan(slotLeft, RESEARCH_SLOT_WAIT_ID, slotUp);
    const slotAck = await ask('research:action', 'slots', {decision_id: 'slot-plan',
      observation_id: slotSample.observation.observation_id, action_id: slotIds[0], action_ids: slotIds});
    assert.deepEqual(slotAck.action_ids, slotIds);
    const slotOutcome = await ask('research:stop', 'slots');
    assert.equal(slotOutcome.result.decisions, 1);
    assert.deepEqual(slotOutcome.actions[0].action_ids, slotIds);
    const slotReplay = await ask('research:replay', 'slots', {config: slots.config,
      initial_state: slots.initial_state, actions: slotOutcome.actions, result: slotOutcome.result});
    assert.equal(slotReplay.consistent, true);
  } finally {
    port1.close();
    port2.close();
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {createAdvisorMemory} from '../src/client/survivors-research/advisor-memory.js';

const gem = (id, dx, dy = 0, being_collected = false) =>
  ({id, dx, dy, being_collected, kind: 'experience', value: 1});
const enemy = (id, dx, dy = 0) => ({id, dx, dy, radius: 0.5});
function sample(memory, tick, options = {}) {
  const {x = 51, y = 98, loot = [], enemies = [], hp = 120, hits = 0, count = null, hudCount,
    run = 'current', truncated = false, terminal = false, frameTick = tick, frameTime = tick * 2} = options;
  return memory.observe({
    run_id: run, tick, sampled_at_ms: tick * 2, terminal, loot, enemies, player: {hp},
    ...(count !== null && {score: {gems_collected: count}}),
    coverage: {loot: {visible: loot.length + Number(truncated), sent: loot.length, truncated}},
  }, {tick: frameTick, sampled_at_ms: frameTime, player: {x, y}, gemsCollected: hudCount, gems: [{id: 999, x, y}],
    enemies: [{id: 999, x, y}]}, hits);
}
const accept = (memory, id, tick, target = null, heading = 'none') =>
  memory.accept({guidance_id: id, source_tick: tick, target_id: target, heading});
const action = (memory, id, tick, direction = 'left') =>
  memory.recordAction({decision_id: id, applied_tick: tick, action_id: 'move:' + direction + ':hold:100'});

test('uses same-sample self position, public IDs and bounded, stable nearest choices', () => {
  const memory = createAdvisorMemory();
  assert.equal(memory.snapshot(), null);
  assert.equal(sample(memory, 0, {frameTick: 2}), false);
  assert.equal(sample(memory, 0, {frameTime: 2}), false);
  assert.equal(sample(memory, 0, {loot: [gem(5, 3), gem(3, -3), gem(1, 9), gem(2, 2), gem(4, 1),
    gem(9, 0, 0, true), gem(8, 17)], enemies: [enemy(10, 3), enemy(44, 18)]}), true);
  const first = memory.snapshot();
  assert.deepEqual(first.player, {x: 0, y: 0, hp: 120, hits_taken: 0, gems_collected: null});
  assert.deepEqual(first.targets.map(({id}) => id), [4, 2, 3, 5]);
  assert.deepEqual(first.enemies.map(({id}) => id), [10]);
  assert.equal(first.enemies[0].previous, null);
  assert.equal(accept(memory, 'a', 0, 4, 'right'), true);

  assert.equal(sample(memory, 20, {x: 54, y: 97, loot: [gem(4, -2, 1)], enemies: [enemy(10, 2, 1)]}), true);
  const moved = memory.snapshot();
  assert.deepEqual(moved.player, {x: 3, y: -1, hp: 120, hits_taken: 0, gems_collected: null});
  assert.deepEqual(moved.targets, [{id: 4, x: 1, y: 0, status: 'visible', value: 1, last_seen_tick: 20, age_ticks: 0}]);
  assert.deepEqual(moved.enemies, [{id: 10, x: 5, y: 0, radius: 0.5, last_seen_tick: 20, age_ticks: 0, previous: {x: 3, y: 0, tick: 0}}]);
  assert.deepEqual(moved.ongoing.displacement, {dx: 3, dy: -1});
  assert.deepEqual(moved.ongoing.enemy_changes, [{id: 10, dx: 2, dy: 0}]);
  assert.throws(() => { moved.enemies[0].previous.x = 6; }, TypeError);
  assert.throws(() => { moved.ongoing.target.to.status = 'collected'; }, TypeError);
  assert.equal(first.targets[0].last_seen_tick, 0);
});

test('a pinned gem remains a goal offscreen or truncated and cannot be counted through absence', () => {
  const memory = createAdvisorMemory();
  sample(memory, 0, {loot: [gem(7, 4)], count: 1});
  assert.equal(accept(memory, 'a', 0, 7, 'right'), true);
  sample(memory, 60, {x: 90, count: 2});
  let view = memory.snapshot();
  assert.equal(view.targets[0].status, 'unknown');
  assert.equal(view.targets[0].x, 4);
  assert.equal(view.targets[0].last_seen_tick, 0);
  assert.equal(view.ongoing.pickups_delta, 1);
  assert.equal(accept(memory, 'b', 60, 7, 'left'), true);

  sample(memory, 65, {count: 2, truncated: true});
  assert.equal(memory.snapshot().targets[0].status, 'unknown');
  sample(memory, 67, {count: 3});
  view = memory.snapshot();
  assert.equal(view.targets[0].status, 'reobserved-absent');
  assert.equal(view.ongoing.pickups_delta, 1);
  assert.equal(accept(memory, 'c', 67, 7, 'left'), false);

  sample(memory, 68, {x: 92});
  assert.equal(memory.snapshot().targets[0].status, 'reobserved-absent');
  assert.equal(accept(memory, 'c', 68, 7, 'left'), false);
  sample(memory, 69, {loot: [gem(7, 2, 0, true)]});
  assert.equal(memory.snapshot().targets[0].status, 'attracted');
  sample(memory, 70, {x: 92});
  assert.equal(memory.snapshot().targets[0].status, 'attracted');
  assert.equal(memory.snapshot().targets[0].age_ticks, 1);
  assert.equal(accept(memory, 'c', 70, 7, 'left'), false);
  sample(memory, 71, {loot: [gem(7, 4)]});
  assert.equal(memory.snapshot().targets[0].status, 'visible');
});

test('recent last-known goals can be selected after leaving view before or after dispatch', () => {
  const memory = createAdvisorMemory();
  sample(memory, 0, {loot: [gem(7, 3), gem(9, 4), gem(10, 6)]});
  assert.equal(accept(memory, 'first', 0, 7, 'right'), true);
  sample(memory, 60, {x: 73, loot: [gem(11, 3)]});
  assert.deepEqual(memory.snapshot().targets.map(({id, status}) => [id, status]),
    [[7, 'unknown'], [11, 'visible'], [10, 'unknown'], [9, 'unknown']]);
  // The result was based on a public observation before the target moved out of view.
  assert.equal(accept(memory, 'look-back', 1, 9, 'left'), true);
  assert.equal(memory.snapshot().ongoing.target.from.status, 'unknown');
  sample(memory, 600, {x: 73, loot: [gem(11, 3)]});
  assert.ok(memory.snapshot().targets.some(row => row.id === 10));
  sample(memory, 601, {x: 73, loot: [gem(11, 3)]});
  assert.deepEqual(memory.snapshot().targets.map(({id}) => id), [9, 11]);
});

test('keeps a bounded immutable history of actual net samples and confirmed actions', () => {
  const memory = createAdvisorMemory();
  sample(memory, 0, {loot: [gem(7, 2)], enemies: [enemy(1, 3)], hp: 100, count: 2});
  assert.equal(action(memory, 'before', 1), false);
  assert.equal(accept(memory, 'a', 0, 7, 'left'), true);
  assert.equal(action(memory, 'first', 1), true);
  assert.equal(action(memory, 'first', 1), false);
  assert.equal(action(memory, 'late-duplicate', 1), false);
  assert.equal(memory.recordAction({decision_id: 'upgrade', applied_tick: 2, action_id: 'choose:level-1:whip'}), false);
  assert.equal(action(memory, 'future', 62), true);
  assert.equal(memory.snapshot().ongoing.actions.count, 0);
  sample(memory, 60, {x: 54, hp: 91, hits: 2, count: 3, loot: [gem(7, -1)], enemies: [enemy(1, 1)]});
  const live = memory.snapshot();
  assert.equal(live.ongoing.actions.count, 1);
  assert.equal(live.ongoing.actions.last[0].decision_id, 'first');
  assert.deepEqual(live.ongoing.displacement, {dx: 3, dy: 0});
  assert.equal(live.ongoing.hp_delta, -9);
  assert.equal(live.ongoing.hits_delta, 2);
  assert.equal(live.ongoing.pickups_delta, 1);
  assert.deepEqual(live.ongoing.enemy_changes, [{id: 1, dx: 1, dy: 0}]);
  assert.equal(accept(memory, 'b', 60, 7, 'right'), true);
  assert.equal(action(memory, 'late-before-acceptance', 59), false);
  assert.equal(action(memory, 'late-on-acceptance', 60), false);
  assert.deepEqual(memory.snapshot().history[0], live.ongoing);
  sample(memory, 65);
  assert.equal(memory.snapshot().ongoing.actions.last[0].decision_id, 'future');
  assert.equal(memory.snapshot().ongoing.pickups_delta, null);
  const first = memory.snapshot().history[0];
  assert.deepEqual(first, live.ongoing);
  assert.throws(() => { first.actions.last.push({}); }, TypeError);
  for (let index = 1; index <= 5; index++) {
    const tick = 65 + index * 60;
    sample(memory, tick);
    assert.equal(accept(memory, 'c-' + index, tick), true);
  }
  assert.deepEqual(memory.snapshot().history.map(row => row.guidance_id), ['c-1', 'c-2', 'c-3', 'c-4']);
  assert.equal(memory.snapshot().ongoing.actions.count, 0);
  assert.equal(first.to_tick, 60);
});

test('rejects stale, fabricated, duplicate or foreign inputs and resets for reused IDs', () => {
  const memory = createAdvisorMemory();
  sample(memory, 0, {loot: [gem(7, 2)], enemies: [enemy(1, 2)]});
  accept(memory, 'a', 0, 7, 'right');
  assert.equal(sample(memory, 61, {x: 123, run: 'other'}), false);
  assert.equal(sample(memory, 0), false);
  assert.equal(sample(memory, 1, {terminal: true}), false);
  assert.equal(sample(memory, 120, {x: 70, loot: [gem(5, 2)]}), true);
  assert.equal(memory.snapshot().enemies[0].age_ticks, 120);
  assert.equal(memory.snapshot().targets[0].id, 7);
  assert.equal(accept(memory, 'b', 0, 7, 'left'), false);
  assert.equal(accept(memory, 'b', 121, 7, 'left'), false);
  assert.equal(accept(memory, 'b', 119, 5, 'right'), false);
  assert.equal(accept(memory, 'b', 120, 999, 'right'), false);
  assert.equal(accept(memory, 'b', 120, 5, 'north'), false);
  assert.equal(accept(memory, 'a', 120, 7, 'left'), false);
  assert.equal(accept(memory, 'b', 120, 7, 'left'), true);

  sample(memory, 121, {x: 70});
  assert.equal(memory.snapshot().enemies.length, 0);
  memory.reset();
  assert.equal(memory.snapshot(), null);
  assert.equal(accept(memory, 'old', 120, 7, 'left'), false);
  assert.equal(sample(memory, 0, {run: 'other', x: 99, loot: [gem(7, -2)]}), true);
  assert.equal(memory.snapshot().player.x, 0);
  assert.equal(memory.snapshot().targets[0].x, -2);
  assert.deepEqual(memory.snapshot().history, []);
  assert.equal(memory.snapshot().ongoing, null);
});

test('pins the prior goal as the bounded memory evicts old entities', () => {
  const memory = createAdvisorMemory();
  sample(memory, 0, {loot: [gem(1, 5)]});
  accept(memory, 'a', 0, 1, 'right');
  for (let i = 1; i <= 4; i++) {
    const loot = Array.from({length: 64}, (_, index) => gem(i * 64 + index, 1));
    const enemies = Array.from({length: 128}, (_, index) => enemy(i * 128 + index, 2));
    sample(memory, i, {x: 51 + i * 20, loot, enemies});
  }
  const view = memory.snapshot();
  assert.equal(view.targets.length, 4);
  assert.equal(view.targets[0].id, 1);
  assert.deepEqual(view.targets.slice(1).map(row => row.id), [256, 257, 258]);
  assert.equal(view.enemies.length, 128);
  assert.ok(view.enemies.every(row => row.last_seen_tick === 4));
  assert.equal(accept(memory, 'b', 4, 65, 'none'), false);
});


test('uses same-sample HUD pickup total when public JSON omits it', () => {
  const memory = createAdvisorMemory();
  assert.equal(sample(memory, 0, {hudCount: 10, frameTime: 1}), false);
  assert.equal(sample(memory, 0, {hudCount: 4}), true);
  assert.equal(memory.snapshot().player.gems_collected, 4);
  assert.equal(accept(memory, 'a', 0), true);
  assert.equal(sample(memory, 60, {hudCount: 6}), true);
  assert.equal(memory.snapshot().ongoing.pickups_delta, 2);
  assert.equal(accept(memory, 'b', 60), true);
  assert.equal(sample(memory, 120, {hudCount: 100, count: 7}), true);
  assert.equal(memory.snapshot().player.gems_collected, 7);
  assert.equal(memory.snapshot().ongoing.pickups_delta, 1);
  assert.equal(sample(memory, 121, {hudCount: -1}), true);
  assert.equal(memory.snapshot().player.gems_collected, null);
  assert.equal(memory.snapshot().ongoing.pickups_delta, null);
});

test('cardinal memory rebases current targets and keeps only observed route progress facts', () => {
  const memory = createAdvisorMemory();
  assert.equal(memory.cardinalSnapshot(), null);
  sample(memory, 0, {loot: [gem(7, 2, 2)], enemies: [enemy(1, 3)], hp: 120, count: 0});
  const initial = memory.cardinalSnapshot();
  assert.deepEqual(initial, {schema: 'survivors-cardinal-memory-v2', coordinate_frame: 'current-player-relative',
    run_id: 'current', tick: 0, player: {hp: 120, hits_taken: 0, gems_collected: 0}, active_target_id: null,
    targets: [{id: 7, dx: 2, dy: 2, value: 1, status: 'visible', last_seen_tick: 0, age_ticks: 0}],
    history: [], ongoing: null});
  assert.equal(accept(memory, 'route1', 0, 7, 'right'), true);
  assert.equal(action(memory, 'actual1', 2, 'right'), true);
  assert.equal(action(memory, 'actual2', 3, 'down'), true);
  sample(memory, 20, {x: 54, y: 100, loot: [gem(7, -1, 0)], enemies: [enemy(1, 1, -2)], hp: 116, hits: 1, count: 2});
  const corner = memory.cardinalSnapshot();
  assert.equal(corner.active_target_id, 7);
  assert.deepEqual(corner.targets[0], {id: 7, dx: -1, dy: 0, value: 1, status: 'visible', last_seen_tick: 20, age_ticks: 0});
  assert.deepEqual(corner.ongoing, {from_tick: 0, to_tick: 20, displacement: {dx: 3, dy: 2},
    hp_delta: -4, hits_delta: 1, pickups_delta: 2, applied_action_count: 2,
    target: {id: 7, status_start: 'visible', status_end: 'visible', range_start: Math.hypot(2, 2),
      range_end: 1, range_delta: 1 - Math.hypot(2, 2)},
    enemy_changes: [{id: 1, dx: 1, dy: 0}]});
  assert.equal(accept(memory, 'route2', 20, 7, 'left'), true);
  sample(memory, 25, {x: 90, y: 100, count: 2});
  const outside = memory.cardinalSnapshot();
  assert.equal(outside.targets[0].dx, -37);
  assert.equal(outside.targets[0].status, 'unknown');
  assert.equal(outside.targets[0].age_ticks, 5);
  assert.deepEqual(outside.ongoing.target, {id: 7, status_start: 'visible', status_end: 'unknown',
    range_start: 1, range_end: null, range_delta: null});
  assert.deepEqual(outside.history, [corner.ongoing]);
  sample(memory, 30, {x: 54, y: 100, loot: [gem(7, -1, 0, true)], count: 2});
  assert.equal(memory.cardinalSnapshot().ongoing.target.range_end, 1);
  sample(memory, 31, {x: 54, y: 100, count: 3});
  assert.deepEqual(memory.cardinalSnapshot().ongoing.target, {id: 7, status_start: 'visible', status_end: 'attracted',
    range_start: 1, range_end: null, range_delta: null});
  assert.equal(memory.cardinalSnapshot().ongoing.pickups_delta, 1);
  assert.throws(() => { outside.history[0].target.range_start = 0; }, TypeError);
});

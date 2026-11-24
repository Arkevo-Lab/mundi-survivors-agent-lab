import assert from 'node:assert/strict';
import test from 'node:test';
import {projectTrainingTactics} from '../src/client/survivors-research/training-tactics.js';
import {ResearchRun} from '../src/client/survivors-research/sim-run.js';
import {RESEARCH_SLOTS_PROFILE} from '../src/shared/survivors-research-contract.js';

function initialObservation() {
  const run = new ResearchRun({runId: 'training-tactics', send() {}, config: {
    action_profile: RESEARCH_SLOTS_PROFILE, observation_profile: 'state-detail-v1',
  }});
  return {snapshot: run.world.snapshot(), observation: run.observe().observation};
}

test('tactical context reports the actual initial whip and no unobserved entities', () => {
  const {snapshot, observation} = initialObservation();
  const copy = structuredClone(snapshot);
  assert.equal(observation.training_tactics, undefined);
  const tactics = projectTrainingTactics(snapshot, {...observation, loot: undefined, enemies: undefined});
  assert.equal(tactics.facing, 'right');
  assert.deepEqual(tactics.primary_whip, {next_ticks: 1, left: [-3.3, -1.78, 0.3, 0.72], right: [-0.3, -1.78, 3.3, 0.72]});
  assert.equal(tactics.headings.length, 9);
  assert.ok(tactics.headings.every(({gem_approach, enemy_clearance}) => gem_approach === null && enemy_clearance === null));
  assert.deepEqual(snapshot, copy);
  const noWhip = projectTrainingTactics({...snapshot, whip: null}, observation);
  assert.equal(noWhip.primary_whip, null);
  assert.throws(() => projectTrainingTactics(snapshot, {...observation, tick: observation.tick + 1}), /same-tick/);
});

test('tactical geometry follows mirrored public loot and path clearance', () => {
  const {snapshot, observation} = initialObservation();
  const loot = [
    {kind: 'experience', dx: 1.2, dy: 0},
    {kind: 'experience', dx: -1.5, dy: 0, being_collected: true},
    {kind: 'coin', dx: -1.6, dy: 0},
  ];
  const enemies = [{dx: 0.8, dy: 0.05, radius: 0.3}];
  const tactics = projectTrainingTactics(snapshot, {...observation, loot, enemies});
  const byHeading = Object.fromEntries(tactics.headings.map(row => [row.direction, row]));
  assert.deepEqual(byHeading.right, {direction: 'right', gem_approach: 1.2, enemy_clearance: -0.25});
  assert.deepEqual(byHeading.left, {direction: 'left', gem_approach: 0, enemy_clearance: 0.5});
  assert.deepEqual(byHeading.wait, {direction: 'wait', gem_approach: 0, enemy_clearance: 0.5});
  const flip = ({dx, ...row}) => ({...row, dx: -dx});
  const mirrored = projectTrainingTactics({...snapshot, player: {...snapshot.player, facing: -1},
    whip: {...snapshot.whip, nextTick: 31}}, {...observation, loot: loot.map(flip), enemies: enemies.map(flip)});
  assert.equal(mirrored.facing, 'left');
  assert.equal(mirrored.primary_whip.next_ticks, 31);
  for (const row of mirrored.headings) {
    const originalDirection = row.direction.replace(/left|right/g, side => side === 'left' ? 'right' : 'left');
    assert.deepEqual(row, {...byHeading[originalDirection], direction: row.direction});
  }
});

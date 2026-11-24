import {RESEARCH_SLOTS_MAX_TICKS, RESEARCH_SLOTS_PROFILE, RESEARCH_SLOT_WAIT_ID, researchCandidates}
  from '../../shared/survivors-research-contract.js';

export const TRAINING_GOAL_MODES = Object.freeze(['goal-stateless-v1', 'goal-memory-v1']);
const spaceIds = researchCandidates(RESEARCH_SLOTS_PROFILE).flatMap(({id}) =>
  id === RESEARCH_SLOT_WAIT_ID ? [] : ['space:' + id.split(':')[1]]);
const entityGoal = /^(loot|enemy):([1-9][0-9]*)$/;
const isPublicId = id => Number.isSafeInteger(id) && id > 0;

export function validTrainingGoalId(value) {
  if (typeof value !== 'string') return false;
  if (spaceIds.includes(value)) return true;
  const entity = entityGoal.exec(value);
  return Boolean(entity && isPublicId(Number(entity[2])));
}

export function publicTrainingGoalIds(observation) {
  const gems = (observation.loot ?? []).filter(item => item.kind === 'experience' && !item.being_collected);
  const visibleIds = (items, prefix, limit) => Array.from(new Set(items.map(item => item.id).filter(isPublicId)))
    .slice(0, limit).map(id => prefix + ':' + id);
  return [...visibleIds(gems, 'loot', 6), ...visibleIds(observation.enemies ?? [], 'enemy', 4), ...spaceIds];
}

function targetStatus(observation, goalId) {
  const match = entityGoal.exec(goalId);
  if (!match) return 'none';
  const id = Number(match[2]);
  if (match[1] === 'enemy') return observation.enemies?.some(item => item.id === id) ? 'visible' : 'unknown';
  const gem = observation.loot?.find(item => item.id === id && item.kind === 'experience');
  return gem ? gem.being_collected ? 'attracted' : 'visible' : 'unknown';
}

const round = value => Math.round(value * 10000) / 10000 || 0;
const validAnchor = anchor => Boolean(anchor && Number.isSafeInteger(anchor.tick) && anchor.tick >= 0 &&
  [anchor.x, anchor.y, anchor.hp].every(Number.isFinite));

export function projectTrainingIntent(mode, observation, current, committed = null) {
  if (!TRAINING_GOAL_MODES.includes(mode) || observation.terminal || observation.upgrade_offer ||
      !validAnchor(current) || current.tick !== observation.tick) {
    throw new TypeError('Expected a matching movement observation for goal diagnostics');
  }
  if (mode === 'goal-stateless-v1' || committed === null) return {mode, prior: null};
  const {goal_id, observed, applied_tick, plan_end} = committed;
  const hasAppliedPlan = applied_tick !== null;
  if (!validTrainingGoalId(goal_id) || !validAnchor(observed) || observed.tick > current.tick ||
      (hasAppliedPlan && (!Number.isSafeInteger(applied_tick) || applied_tick <= observed.tick || applied_tick > current.tick))) {
    throw new TypeError('Expected an acknowledged goal and earlier observation');
  }
  const elapsed = hasAppliedPlan ? Math.min(RESEARCH_SLOTS_MAX_TICKS, current.tick - applied_tick + 1) : 0;
  const ended = plan_end?.started_tick === applied_tick && Number.isSafeInteger(plan_end.executed_ticks) &&
    plan_end.executed_ticks >= 0 && plan_end.executed_ticks <= elapsed;
  return {mode, prior: {
    goal_id, observed_tick: observed.tick, dx: round(current.x - observed.x), dy: round(current.y - observed.y),
    hp_delta: round(current.hp - observed.hp), executed_ticks: ended ? plan_end.executed_ticks : elapsed,
    target_status: targetStatus(observation, goal_id),
  }};
}

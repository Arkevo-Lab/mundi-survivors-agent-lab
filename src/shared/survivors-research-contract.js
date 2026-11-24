export const RESEARCH_SCHEMA = 'survivors-research-v1';
export const RESEARCH_RULES = 'mundi-survivors-research-v1';
export const RESEARCH_ENGINE = 'survivors-lab-0.61.0-research-v1';
export const RESEARCH_BASELINE = 'bcfcd8d8ddf8b7de0bbcf41b3802f4116eed7433';
export const RESEARCH_BASE_SIM_BLOB = '0023f6e8117112814fd99c89a5626c2286f98184';
export const OBSERVATION_SCHEMA = 'survivors-observation-v1';
export const TICK_HZ = 60;
export const TICK_MS = 1000 / TICK_HZ;
export const RESEARCH_SIM_NODE_SCHEMA = 'survivors-research-sim-node-v1';
export const RESEARCH_SEGMENT_TICKS = 10 * TICK_HZ;
export const MAX_RESEARCH_LATENCY_COMPENSATION_MS = 1000;
export const DISTANCE_TIMEOUT_TICKS = 5 * TICK_HZ;
export const RESEARCH_CLOCK_POLICY = Object.freeze({
  version: 'survivors-realtime-clock-v1',
  max_steps_per_pump: 6,
  max_lag_ms: 100,
  sustained_lag_ms: 1000,
  snapshot_interval_ticks: 6,
});

export const RESEARCH_OBSERVATIONS = Object.freeze(['state-compact-v1', 'state-detail-v1', 'state-full-v1']);
export const RESEARCH_INFORMATION_FIELDS = Object.freeze([
  'health', 'progress', 'movement', 'equipment', 'enemies', 'hazards', 'loot', 'score',
]);
export const RESEARCH_FINE_HOLD_PROFILE = 'hold-fine-v1';
export const RESEARCH_FINE_HOLD_DURATIONS_MS = Object.freeze([50, 100, 150, 200, 250, 300]);
export const RESEARCH_SEQUENCE_PROFILE = 'hold-sequence-v1';
export const RESEARCH_COVERAGE_SEQUENCE_PROFILE = 'hold-sequence-coverage-v1';
export const RESEARCH_COVERAGE_SEQUENCE_DURATIONS_MS = Object.freeze([100, 100, 400]);
export const RESEARCH_SEQUENCE_MAX_SEGMENTS = 6;
export const RESEARCH_SEQUENCE_MAX_TICKS = 18;

export function researchSequenceTicks(profile) {
  if (profile === RESEARCH_COVERAGE_SEQUENCE_PROFILE) return 36;
  return profile === RESEARCH_SEQUENCE_PROFILE ? RESEARCH_SEQUENCE_MAX_TICKS : null;
}
export const RESEARCH_EXECUTED_PLAN_FEEDBACK = 'executed-plan-v1';
export const RESEARCH_CLOSED_PLAN_FEEDBACK = 'closed-plan-v1';
export const RESEARCH_EXECUTED_PLAN_MAX_AGE_TICKS = RESEARCH_SEQUENCE_MAX_TICKS;
export const RESEARCH_CLOSED_PLAN_HISTORY_FEEDBACK = 'closed-plan-history-v1';
export const RESEARCH_CLOSED_PLAN_HISTORY_LIMIT = 4;
export const RESEARCH_CLOSED_PLAN_HISTORY_MAX_AGE_TICKS = 120;
export const RESEARCH_ACTUAL_TRAIL_MODE = 'actual-positions-120-v1';
export const RESEARCH_ACTUAL_TRAIL_MAX_AGE_TICKS = 120;
export const RESEARCH_SLOTS_PROFILE = 'hold-slots-v1';
export const RESEARCH_SLOTS_COUNT = 10;
export const RESEARCH_SLOT_MS = 50;
export const RESEARCH_SLOT_TICKS = RESEARCH_SLOT_MS * TICK_HZ / 1000;
export const RESEARCH_SLOTS_MAX_TICKS = RESEARCH_SLOTS_COUNT * RESEARCH_SLOT_TICKS;
export const RESEARCH_SLOT_WAIT_ID = `wait:hold:${RESEARCH_SLOT_MS}`;
export const RESEARCH_MOVEMENT_FEEDBACK_MODES = Object.freeze([
  'none', 'receipts', 'trajectory', RESEARCH_EXECUTED_PLAN_FEEDBACK, RESEARCH_CLOSED_PLAN_FEEDBACK,
  RESEARCH_CLOSED_PLAN_HISTORY_FEEDBACK,
]);
export const RESEARCH_MOVEMENT_RECEIPT_LIMIT = 6;
export const RESEARCH_ACTIONS = Object.freeze(['hold-v1', 'distance-v1', RESEARCH_FINE_HOLD_PROFILE,
  RESEARCH_SEQUENCE_PROFILE, RESEARCH_COVERAGE_SEQUENCE_PROFILE, RESEARCH_SLOTS_PROFILE]);
export const RESEARCH_PRESSURE = 'dense-opening-v1';
export const RESEARCH_DEFAULT_CONFIG = Object.freeze({
  rules: RESEARCH_RULES,
  seed: 1,
  character: 'antonio',
  max_ticks: 120 * TICK_HZ,
  observation_profile: RESEARCH_OBSERVATIONS[0],
  action_profile: RESEARCH_ACTIONS[0],
  max_observation_age_ms: null,
  latency_compensation_ms: 0,
});

const DIRECTIONS = [
  ['up', 0, -1], ['up-right', 1, -1], ['right', 1, 0], ['down-right', 1, 1],
  ['down', 0, 1], ['down-left', -1, 1], ['left', -1, 0], ['up-left', -1, -1],
];
const ACTION_PARAMETERS = {
  'hold-v1': {name: 'hold', amounts: [100, 200, 500, 1000], unit: 'ms'},
  'distance-v1': {name: 'distance', amounts: [0.5, 1, 2, 4], unit: 'world units'},
  [RESEARCH_FINE_HOLD_PROFILE]: {name: 'hold', amounts: RESEARCH_FINE_HOLD_DURATIONS_MS, unit: 'ms'},
  [RESEARCH_SEQUENCE_PROFILE]: {name: 'hold', amounts: RESEARCH_FINE_HOLD_DURATIONS_MS, unit: 'ms'},
  [RESEARCH_COVERAGE_SEQUENCE_PROFILE]: {name: 'hold', amounts: [100, 400], unit: 'ms'},
  [RESEARCH_SLOTS_PROFILE]: {name: 'hold', amounts: [RESEARCH_SLOT_MS], unit: 'ms'},
};

const ACTION_CATALOGS = new Map(RESEARCH_ACTIONS.map(profile => {
  const {name, amounts, unit} = ACTION_PARAMETERS[profile];
  const slots = profile === RESEARCH_SLOTS_PROFILE;
  const entries = [Object.freeze(slots
    ? {id: RESEARCH_SLOT_WAIT_ID, description: `Wait for ${RESEARCH_SLOT_MS} ms while the world keeps moving.`,
      kind: 'hold', x: 0, y: 0, amount: RESEARCH_SLOT_MS}
    : {id: 'stop', description: 'Stop moving.', kind: 'stop', x: 0, y: 0})];
  for (const [direction, x, y] of DIRECTIONS) {
    if (profile === RESEARCH_COVERAGE_SEQUENCE_PROFILE && x !== 0 && y !== 0) continue;
    for (const amount of amounts) {
      entries.push(Object.freeze({
        id: `move:${direction}:${name}:${amount}`,
        description: `Move ${direction} at normal speed for ${amount} ${unit}${slots || researchSequenceTicks(profile) !== null ? '.' : ', then stop.'}`,
        kind: name, x, y, amount,
      }));
    }
    if (profile === RESEARCH_SEQUENCE_PROFILE) {
      entries.push(Object.freeze({
        id: `move:${direction}:ticks:1`,
        description: `Move ${direction} at normal speed for one simulation tick (about 16.7 ms).`,
        kind: 'ticks', x, y, amount: 1,
      }));
    }
  }
  return [profile, Object.freeze(entries)];
}));

export function researchMovement(profile, id) {
  return ACTION_CATALOGS.get(profile)?.find(entry => entry.id === id);
}

export function validResearchActionSequence(actionId, actionIds) {
  if (!Array.isArray(actionIds) || actionIds.length < 1 || actionIds.length > RESEARCH_SEQUENCE_MAX_SEGMENTS ||
      actionIds[0] !== actionId || typeof actionId !== 'string') return false;
  if (actionIds.length === 1 && /^choose:level-[1-9][0-9]*:[a-z-]+$/.test(actionId)) return true;
  return Array.from(actionIds).every(id => {
    const entry = researchMovement(RESEARCH_SEQUENCE_PROFILE, id);
    return entry && (entry.kind !== 'stop' || actionIds.length === 1);
  });
}

export function validResearchSlotPlan(actionId, actionIds) {
  if (!Array.isArray(actionIds) || typeof actionId !== 'string' || actionIds[0] !== actionId) return false;
  if (actionIds.length === 1) return /^choose:level-[1-9][0-9]*:[a-z-]+$/.test(actionId);
  return actionIds.length === RESEARCH_SLOTS_COUNT &&
    Array.from(actionIds).every(id => researchMovement(RESEARCH_SLOTS_PROFILE, id) !== undefined);
}

function validResearchCoveragePlan(actionId, actionIds) {
  if (!Array.isArray(actionIds) || typeof actionId !== 'string' || actionIds[0] !== actionId) return false;
  if (actionIds.length === 1) return actionId === 'stop' || /^choose:level-[1-9][0-9]*:[a-z-]+$/.test(actionId);
  return actionIds.length === RESEARCH_COVERAGE_SEQUENCE_DURATIONS_MS.length &&
    RESEARCH_COVERAGE_SEQUENCE_DURATIONS_MS.every((duration, index) =>
      researchMovement(RESEARCH_COVERAGE_SEQUENCE_PROFILE, actionIds[index])?.amount === duration);
}

export function researchPlanValidator(profile) {
  if (profile === RESEARCH_COVERAGE_SEQUENCE_PROFILE) return validResearchCoveragePlan;
  if (profile === RESEARCH_SLOTS_PROFILE) return validResearchSlotPlan;
  if (profile === RESEARCH_SEQUENCE_PROFILE) return validResearchActionSequence;
  return null;
}

export function researchCandidates(profile, offer = null) {
  const slots = profile === RESEARCH_SLOTS_PROFILE;
  const candidates = slots && offer ? [] : ACTION_CATALOGS.get(profile).map(({id, description}) => ({id, description}));
  if (offer) {
    for (const option of offer.options) {
      candidates.push({
        id: `choose:${offer.offer_id}:${option.option_id}`,
        description: `Choose ${option.name}. ${option.description} ${slots || researchSequenceTicks(profile) !== null
          ? 'Stops the previous movement plan.' : 'Continue the current movement.'}`,
      });
    }
  }
  return candidates;
}

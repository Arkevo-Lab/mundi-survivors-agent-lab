import {validDirectionContext} from './action-direction.js';
import {RESEARCH_CLOSED_PLAN_HISTORY_LIMIT, RESEARCH_CLOSED_PLAN_HISTORY_MAX_AGE_TICKS,
  RESEARCH_EXECUTED_PLAN_MAX_AGE_TICKS, RESEARCH_MOVEMENT_RECEIPT_LIMIT, RESEARCH_OBSERVATIONS, RESEARCH_SEQUENCE_MAX_TICKS, RESEARCH_SLOTS_PROFILE,
  RESEARCH_SLOT_TICKS, RESEARCH_SLOT_WAIT_ID, researchCandidates, researchMovement} from '../../../shared/survivors-research-contract.js';
import {validGoalObservationTick, validTrainingIntent} from './action-goal.js';

const number = Number.isFinite;
const text = value => typeof value === 'string';
const boolean = value => typeof value === 'boolean';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nullable = check => value => value === null || check(value);
const list = check => value => Array.isArray(value) && value.every(check);
const pair = value => Array.isArray(value) && value.length === 2 && value.every(number);
const record = fields => value => object(value) && Object.keys(value).every(key =>
  Object.hasOwn(fields, key) && (value[key] === undefined || fields[key](value[key])));

const stats = record({
  damage: number, cooldownTicks: number, speed: number, amount: number, pierce: number, radius: number,
  area: number, strikes: number, durationTicks: number, orbitRadius: number, angularSpeed: number,
  rechargeTicks: number, pulseTicks: number, evolved: boolean,
});
const item = record({
  id: text, name: text, level: number, effect: text, base_stats: stats, effective_value: nullable(number),
});
const movementReceipt = record({
  action_id: value => Boolean(researchMovement(RESEARCH_SLOTS_PROFILE, value)),
  started_tick: value => Number.isSafeInteger(value) && value >= 1,
  executed_ticks: value => Number.isInteger(value) && value >= 1 && value <= RESEARCH_SLOT_TICKS,
  dx: number, dy: number,
  reason: value => ['completed', 'replaced', 'run-ended'].includes(value),
});
const movementReceipts = value => Array.isArray(value) && value.length >= 1 && value.length <= RESEARCH_MOVEMENT_RECEIPT_LIMIT &&
  value.every((receipt, index) => movementReceipt(receipt) && Object.keys(receipt).length === 6 &&
    Object.values(receipt).every(field => field !== undefined) &&
    (index === 0 || receipt.started_tick >= value[index - 1].started_tick + value[index - 1].executed_ticks));
const exactRecord = fields => {
  const keys = Object.keys(fields);
  return value => object(value) && Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key) && fields[key](value[key]));
};
const nonNegative = value => number(value) && value >= 0;
const nonNegativeInt = value => Number.isSafeInteger(value) && value >= 0;
const rectangle = exactRecord({shape:value=>value==='rectangle', half_width:nonNegative, half_height:nonNegative});
const whipRange = exactRecord({shape:value=>value==='rectangle', max_half_width:nonNegative, max_half_height:nonNegative,
  center_forward:nonNegative, center_y_step:number});
const pendingStrike = exactRecord({index:nonNegativeInt, in_ticks:nonNegativeInt});
const activeStrikeFields = {
  id:nonNegativeInt, index:nonNegativeInt, direction:value=>value===1||value===-1, dx:number, dy:number,
  bounds:nullable(rectangle), remaining_ticks:nonNegativeInt, damage:nullable(nonNegative),
  already_hit_enemy_ids:list(nonNegativeInt),
};
const basicActiveStrike = exactRecord(activeStrikeFields);
const boundedActiveStrike = exactRecord({...activeStrikeFields,max_bounds:nullable(rectangle)});
const activeStrike = value => basicActiveStrike(value) || boundedActiveStrike(value);
const whipFacts = exactRecord({
  damage:nullable(nonNegative), range:nullable(whipRange), strikes_per_cycle:nullable(nonNegativeInt),
  repeat_ticks:nonNegativeInt, direction_mode:value=>value==='alternating_at_emission',
  cooldown_remaining_ticks:nullable(nonNegativeInt),
  pending_strikes:nullable(list(pendingStrike)), active_strikes:nullable(list(activeStrike)),
});
const weaponFacts = exactRecord({id:text, combat:nullable(whipFacts)});
const weaponState = value => Array.isArray(value) && value.every(row=>weaponFacts(row) &&
  (row.id==='whip' || row.combat===null));

export function withoutWeaponState(observation) {
  if (!Object.hasOwn(observation?.player ?? {},'weapon_state')) return observation;
  const {weapon_state,...player} = observation.player;
  return {...observation,player};
}

const previousMovement = exactRecord({
  dx: number, dy: number, hp_delta: number,
  executed_ticks: value => Number.isInteger(value) && value >= 1 && value <= RESEARCH_SEQUENCE_MAX_TICKS,
  age_ticks: value => Number.isInteger(value) && value >= 0 && value <= RESEARCH_EXECUTED_PLAN_MAX_AGE_TICKS,
});
const historyRow = exactRecord({
  dx: number, dy: number, hp_delta: number,
  executed_ticks: value => Number.isInteger(value) && value >= 1 && value <= RESEARCH_SEQUENCE_MAX_TICKS,
  age_ticks: value => Number.isInteger(value) && value >= 0 && value <= RESEARCH_CLOSED_PLAN_HISTORY_MAX_AGE_TICKS,
});
const boundedHistory = value => Array.isArray(value) && value.length >= 1 && value.length <= RESEARCH_CLOSED_PLAN_HISTORY_LIMIT;

function validMovementHistory(player, tick) {
  if (!number(player.hp) || !number(player.max_hp) || !number(player.speed) ||
      !Array.isArray(player.movement) || !number(player.movement[0]) || !number(player.movement[1]) ||
      !boundedHistory(player.movement_history) || Object.hasOwn(player, 'previous_movement')) return false;
  let previousEnd = 0;
  for (const row of player.movement_history) {
    if (!historyRow(row)) return false;
    const end = tick - row.age_ticks;
    if (end - row.executed_ticks + 1 <= previousEnd) return false;
    previousEnd = end;
  }
  return true;
}
const player = record({
  hp: number, max_hp: number, level: number, xp: number, xp_to_next: nullable(number),
  speed: number, movement: pair,
  previous_movement: previousMovement,
  movement_history: boundedHistory,
  movement_receipts: movementReceipts,
  movement_receipt_offset: value => record({ dx: number, dy: number })(value) && Number.isFinite(value.dx) && Number.isFinite(value.dy),
  movement_distance: record({ unobstructed_50_ms: number, unobstructed_100_ms: number, unobstructed_500_ms: number }), equipment: list(item), gem_pickup_radius: number, weapon_state: weaponState,
});
const point = { id: value => text(value) || number(value), kind: text, dx: number, dy: number };
const enemy = record({ ...point, radius: number, velocity: nullable(pair), hp: number, frozen: boolean });
const hazard = record({
  ...point, hostile: boolean, velocity: nullable(pair), shape: text, half_width: number, half_height: number,
  radius: number, remaining_ticks: nullable(number), phase: text,
});
const loot = record({ ...point, value: number, tier: value => text(value) || number(value), being_collected: boolean });
const coverage = record({ visible: number, sent: number, truncated: boolean });
const option = record({ option_id: text, name: text, description: text });
const offer = record({ offer_id: text, options: list(option) });
const tacticalDirections = researchCandidates(RESEARCH_SLOTS_PROFILE).map(({id}) =>
  id === RESEARCH_SLOT_WAIT_ID ? 'wait' : id.split(':')[1]);
const bounds = value => Array.isArray(value) && value.length === 4 && value.every(number) &&
  value[0] <= value[2] && value[1] <= value[3];
const heading = exactRecord({direction: text, gem_approach: nullable(value => number(value) && value >= 0),
  enemy_clearance: nullable(number)});
const trainingTactics = exactRecord({
  facing: value => value === 'left' || value === 'right',
  primary_whip: nullable(exactRecord({
    next_ticks: value => Number.isSafeInteger(value) && value >= 1, left: bounds, right: bounds,
  })),
  headings: value => Array.isArray(value) && value.length === tacticalDirections.length &&
    tacticalDirections.every((direction, index) => heading(value[index]) && value[index].direction === direction),
});
const observationRecord = record({
  schema: text, run_id: text, observation_id: text, tick: number, sim_time_ms: number,
  sampled_at_ms: number, projected_at_ms: number, profile: text, player, enemies: list(enemy),
  hazards: list(hazard), loot: list(loot), coverage: record({ enemies: coverage, hazards: coverage, loot: coverage }),
  score: record({ gems_collected: number, kills: number, gold: number, wave: number }),
  upgrade_offer: nullable(offer), terminal: boolean, reason: nullable(text), training_tactics: trainingTactics,
  training_intent: validTrainingIntent, direction_context: validDirectionContext,
});

export function validActionContext({ observation, candidates }, {
  min = 1, max = 64, allowDirection = false, allowTraining = false, allowPlanFeedback = false, allowPlanHistory = false, allowWeaponState = false,
} = {}) {
  return observationRecord(observation) &&
    (allowWeaponState || !Object.hasOwn(observation.player ?? {},'weapon_state')) &&
    (!Object.hasOwn(observation, 'direction_context') || allowDirection) &&
    (!Object.hasOwn(observation, 'training_tactics') || (allowTraining && observation.training_tactics !== undefined)) &&
    (!Object.hasOwn(observation, 'training_intent') || (allowTraining && observation.training_intent !== undefined &&
      !Object.hasOwn(observation, 'training_tactics') &&
      validGoalObservationTick(observation))) &&
    observation.schema === 'survivors-observation-v1' &&
    Number.isSafeInteger(observation.tick) && observation.tick >= 0 && observation.terminal === false &&
    (!observation.player || !Object.hasOwn(observation.player, 'previous_movement') ||
      (allowPlanFeedback && !observation.upgrade_offer && previousMovement(observation.player.previous_movement) &&
        observation.tick - observation.player.previous_movement.age_ticks - observation.player.previous_movement.executed_ticks >= 0)) &&
    (!observation.player || !Object.hasOwn(observation.player, 'movement_history') ||
      (allowPlanHistory && !observation.upgrade_offer && validMovementHistory(observation.player, observation.tick))) &&
    (!observation.player?.movement_receipt_offset || Boolean(observation.player.movement_receipts)) &&
    (!observation.player?.movement_receipts || observation.player.movement_receipts.every(receipt =>
      receipt.started_tick + receipt.executed_ticks - 1 <= observation.tick)) &&
    RESEARCH_OBSERVATIONS.includes(observation.profile) &&
    Array.isArray(candidates) && candidates.length >= min && candidates.length <= max &&
    candidates.every(validCandidate) && new Set(candidates.map(candidate => candidate.id)).size === candidates.length;
}

function validCandidate(candidate) {
  return object(candidate) && Object.keys(candidate).length === 2 &&
    typeof candidate.id === 'string' && /^[a-zA-Z0-9:_.-]{1,180}$/.test(candidate.id) &&
    typeof candidate.description === 'string' && candidate.description.length > 0 && candidate.description.length <= 320;
}

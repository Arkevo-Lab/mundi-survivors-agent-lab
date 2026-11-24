import {TRAINING_GOAL_MODES, publicTrainingGoalIds, validTrainingGoalId} from '../training-goal-memory.js';
import {RESEARCH_SLOTS_MAX_TICKS} from '../../../shared/survivors-research-contract.js';
export const GOAL_QUESTION = 'goal';
export const STATELESS_CURRENT_CONTEXT = 'stateless-current-v1';
export const STATELESS_CURRENT_MOVEMENT_GUIDANCE = 'Choose movement using only the current observation and its public entity offsets. An attracted gem is already following you. The separate goal answer is an independent diagnostic. It is not available to the current path decision and will not be passed to later path decisions.';
const STATELESS_CURRENT_GOAL_INSTRUCTIONS = 'Using only the current observation, choose a short-term tactical goal that advances survival and experience collection, or choose clear if no specific goal is appropriate. If a gem is already following you, consider another reachable target. Your answer is an independent diagnostic. It does not issue a movement command and is not passed to the current or any later path decision.';
const STATELESS_CURRENT_CLEAR = 'Report no specific goal for this observation.';

export async function wholePathContextDigest(input) {
  const { instructions, choices } = input.questions[1];
  const movement = input.input[0].content.at(-1).text;
  const bytes = new TextEncoder().encode(JSON.stringify([movement, instructions, choices[0].description]));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export const TWO_RATE_GOAL_MODE = 'goal-two-rate-v1';

export const isGoalPlan = observation => observation?.training_intent?.mode === TWO_RATE_GOAL_MODE &&
  observation.training_intent.phase === 'plan';
export const asksGoal = observation => Boolean(observation?.training_intent &&
  (observation.training_intent.mode !== TWO_RATE_GOAL_MODE || isGoalPlan(observation)));

function exactFields(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function validTrainingIntent(value) {
  const twoRate = value?.mode === TWO_RATE_GOAL_MODE;
  if (twoRate ? !exactFields(value, ['mode', 'phase', 'prior']) || !['plan', 'move'].includes(value.phase)
    : !exactFields(value, ['mode', 'prior']) || !TRAINING_GOAL_MODES.includes(value.mode)) return false;
  if (value.prior === null) return true;
  const prior = value.prior;
  return (twoRate || value.mode === 'goal-memory-v1') && exactFields(prior,
    ['goal_id', 'observed_tick', 'dx', 'dy', 'hp_delta', 'executed_ticks', 'target_status']) &&
    validTrainingGoalId(prior.goal_id) && Number.isSafeInteger(prior.observed_tick) && prior.observed_tick >= 0 &&
    [prior.dx, prior.dy, prior.hp_delta].every(Number.isFinite) &&
    Number.isInteger(prior.executed_ticks) && prior.executed_ticks >= 0 && prior.executed_ticks <= RESEARCH_SLOTS_MAX_TICKS &&
    (prior.goal_id.startsWith('loot:') ? ['visible', 'attracted', 'unknown'].includes(prior.target_status)
      : prior.goal_id.startsWith('enemy:') ? ['visible', 'unknown'].includes(prior.target_status)
        : prior.target_status === 'none');
}

export function validGoalObservationTick(observation) {
  const {mode, phase, prior} = observation.training_intent;
  return !prior || prior.observed_tick < observation.tick ||
    (mode === TWO_RATE_GOAL_MODE && phase === 'move' && prior.observed_tick === observation.tick &&
      [prior.dx, prior.dy, prior.hp_delta, prior.executed_ticks].every(value => value === 0));
}

export function goalQuestion(observation, context) {
  const currentOnly = context === STATELESS_CURRENT_CONTEXT;
  const {prior} = observation.training_intent;
  const visible = {...observation, loot: observation.loot?.filter(item => !item.being_collected &&
    [item.dx, item.dy].every(Number.isFinite)), enemies: observation.enemies?.filter(item => [item.dx, item.dy].every(Number.isFinite))};
  const choices = publicTrainingGoalIds(visible).map(value => {
    const [kind, target] = value.split(':');
    if (kind === 'space') return {value, description: 'Create or hold open space to the ' + target + ' relative to the player.'};
    const {dx, dy} = (kind === 'loot' ? visible.loot : visible.enemies).find(item =>
      item.id === Number(target) && (kind === 'enemy' || item.kind === 'experience'));
    return {value, description: (kind === 'loot' ? 'Approach this experience gem' : 'Manage this enemy or pack') +
      ' at current relative offset (' + dx + ', ' + dy + ') world units.'};
  });
  return {
    type: 'choice', name: GOAL_QUESTION,
    instructions: currentOnly ? STATELESS_CURRENT_GOAL_INSTRUCTIONS : (isGoalPlan(observation)
      ? 'Choose your own short-term tactical goal for the upcoming movement decisions. Retain it only while it remains useful and safe. Prioritize accessible experience gems, then combat positioning or space as needed. Choose clear when a specific target would distract from immediate safety. '
      : 'Choose your own short-term tactical goal. With memory enabled, a confirmed plan carries the goal into the next observation. ') +
      'Choose a concrete goal that advances survival and experience collection, retain a still useful prior goal, or clear it. ' +
      'If a gem has started following you, consider switching to another reachable target. Unknown means the entity is no longer observed and its outcome is unknown. ' +
      (isGoalPlan(observation) ? 'Your selected goal will be supplied to later movement requests with fresh observations.'
        : 'The movement answers are independent and cannot see this new answer.') + ' The goal does not issue a movement command.',
    choices: [
      {value: 'clear', description: currentOnly ? STATELESS_CURRENT_CLEAR : 'Carry no specific goal to the next observation.'},
      ...(prior ? [{value: 'retain', description: 'Keep your prior goal ' + prior.goal_id + '.'}] : []),
      ...choices,
    ],
  };
}

export const GOAL_MOVEMENT_GUIDANCE = [
  'Use your previously selected goal in training_intent.prior when it remains useful and safe.',
  'Use current public entity offsets to pursue it, adjust for actual signed dx and dy since the prior observation, and respond to hp_delta and executed_ticks.',
  'An attracted gem is already following you. An unknown entity has no current verified position or outcome.',
  'A space goal indicates a relative heading. Treat it as intent and choose movement from the current situation.',
  'The independent goal answer is for a future observation. Each movement answer uses the prior goal and current observation.',
].join(' ');

export const TWO_RATE_MOVEMENT_GUIDANCE = [
  'You chose the current tactical goal in training_intent.prior. When it is still useful and safe, use its current public relative offset to make progress across consecutive slots.',
  'For a visible un-attracted experience target, aim to enter its pickup radius by repeating a safe heading long enough to reach it.',
  'Use current clearance and observed HP change to prioritize escaping imminent contact. Resume pursuit when a safe path opens.',
  'If the target is attracted or unknown, use the current observation to pursue safe opportunities while awaiting your next goal choice.',
  'Signed dx and dy describe actual observed travel and executed_ticks describes the last acknowledged plan. A space goal is a relative heading.',
].join(' ');

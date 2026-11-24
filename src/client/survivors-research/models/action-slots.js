import { RESEARCH_SLOTS_PROFILE, RESEARCH_SLOTS_COUNT, RESEARCH_SLOT_MS, RESEARCH_SLOT_TICKS,
  RESEARCH_SLOT_WAIT_ID, researchCandidates, validResearchSlotPlan } from '../../../shared/survivors-research-contract.js';
import { ResearchModelError } from './common.js';

export { RESEARCH_SLOTS_PROFILE, RESEARCH_SLOTS_COUNT };
export const SLOT_PROMPT_VERSION = 'survivors-openai-decisions-slots-v1';
export const TRAJECTORY_PROMPT_VERSION = 'survivors-openai-decisions-slots-feedback-v1';
export const TRAINING_QUESTION_COUNTS = Object.freeze([1, 2, 5, RESEARCH_SLOTS_COUNT]);
export const TRAINING_ACTION_IDS = Object.freeze(researchCandidates(RESEARCH_SLOTS_PROFILE).map(({id}) => id));
export const DEFAULT_TRAINING_CONTROLS = Object.freeze({question_count: RESEARCH_SLOTS_COUNT, action_ids: TRAINING_ACTION_IDS});

export function validTrainingControls(value) {
  return Boolean(value) && typeof value === 'object' && Object.keys(value).length === 2 &&
    TRAINING_QUESTION_COUNTS.includes(value.question_count) && Array.isArray(value.action_ids) &&
    value.action_ids.length >= 2 && new Set(value.action_ids).size === value.action_ids.length &&
    Array.from(value.action_ids).every(id => TRAINING_ACTION_IDS.includes(id));
}

export function isDefaultTrainingControls(controls) {
  return controls?.question_count === RESEARCH_SLOTS_COUNT && controls.action_ids.length === TRAINING_ACTION_IDS.length &&
    controls.action_ids.every((id, index) => id === TRAINING_ACTION_IDS[index]);
}

export function validateSlotSample(sample) {
  if (sample === undefined) return;
  if (!sample || Object.keys(sample).length !== 2 ||
      ![1, 3, 5, 7, RESEARCH_SLOTS_COUNT].includes(sample.question_count) ||
      typeof sample.include_movement_scale !== 'boolean') {
    throw new ResearchModelError('invalid_slot_sample', 'Invalid frozen slot sample settings');
  }
}

export const upgradeRound = candidates => candidates.length > 0 && candidates.every(({ id }) => id.startsWith('choose:'));

export function slotQuestionNames(candidates, sample, controls) {
  return upgradeRound(candidates) ? ['action'] :
    Array.from({ length: controls?.question_count ?? sample?.question_count ?? RESEARCH_SLOTS_COUNT }, (_, index) => 'slot_' + (index + 1));
}

export function slotQuestions(observation, candidates, sample, policy, controls) {
  validateSlotSample(sample);
  const expected = researchCandidates(RESEARCH_SLOTS_PROFILE, observation.upgrade_offer ?? null);
  if (expected.length !== candidates.length || expected.some(({ id, description }, index) =>
    candidates[index].id !== id || candidates[index].description !== description) || (sample && upgradeRound(candidates))) {
    throw new ResearchModelError('invalid_observation', 'Fixed slots require the exact movement or upgrade catalog');
  }
  const selected = controls ? controls.action_ids.map(id => candidates.find(candidate => candidate.id === id)) : candidates;
  const scale = observation.player?.movement_distance;
  const scaleEnabled = sample?.include_movement_scale !== false;
  const slotsPerQuestion = controls ? RESEARCH_SLOTS_COUNT / controls.question_count : 1;
  const duration = RESEARCH_SLOT_MS * slotsPerQuestion;
  const choices = selected.map(({ id, description }) => ({ value: id,
    description: controls ? description.replace(RESEARCH_SLOT_MS + ' ms', duration + ' ms') : description }));
  return slotQuestionNames(candidates, sample, controls).map((name, index) => ({
    type: 'choice', name, choices,
    instructions: name === 'action' ? policy + ' Choose one offered upgrade now.' : controls ? [
      policy,
      'Choose the movement or wait for the ' + (index * duration) + '–' + ((index + 1) * duration) + ' ms window after application.',
      'This choice is held for ' + duration + ' ms (' + (RESEARCH_SLOT_TICKS * slotsPerQuestion) + ' simulation ticks).',
      'Each question shares the same observation and cannot see earlier answers. Time and combat continue during waits.',
      ...(scaleEnabled && scale ? ['At the observed speed this choice can travel up to about ' +
        (scale.unobstructed_50_ms * slotsPerQuestion) + ' world units in the chosen direction.'] : []),
    ].join(' ') : [
      policy,
      'Choose the operation for the absolute ' + (index * RESEARCH_SLOT_MS) + '–' + ((index + 1) * RESEARCH_SLOT_MS) +
        ' ms window from when the plan is applied (slot ' + (index + 1) + ' of ' + RESEARCH_SLOTS_COUNT + ').',
      'On application, the ordered plan starts at the next simulation boundary and replaces any unfinished plan.',
      'Each choice lasts ' + RESEARCH_SLOT_MS + ' ms (' + RESEARCH_SLOT_TICKS + ' simulation ticks). ' +
        RESEARCH_SLOT_WAIT_ID + ' means do not move during this slot. Time and combat continue and later slots still run.',
      'Use the same observation to judge this window independently. Other answers are unavailable. A direction may be repeated.',
      ...(observation.player?.movement_receipts ? [
        'Recent executed movement receipts are oldest first. dx and dy are signed net changes in the same world units as target offsets.',
        'executed_ticks gives actual duration at 60 Hz. One full slot is 50 ms; a replaced slot may have moved less.',
        'movement_receipt_offset, if present, is the signed displacement from the last closed receipt to the current player position. If omitted, that displacement is zero.',
        'Use observed travel to avoid undershooting or overshooting nearby targets. Any attached trajectory plots these same receipts.',
      ] : []),
      ...(scaleEnabled && scale ? [
        'Unobstructed travel in the same world units as the observed relative positions: 50 ms = ' +
          scale.unobstructed_50_ms + ', 100 ms = ' + scale.unobstructed_100_ms + ', 500 ms = ' +
          scale.unobstructed_500_ms + '. Diagonals cover the same total distance, divided by √2 on each axis.',
      ] : []),
    ].join(' '),
  }));
}

export function slotObservation(observation, sample) {
  if (sample?.include_movement_scale !== false || !observation.player?.movement_distance) return observation;
  const { movement_distance, ...player } = observation.player;
  return { ...observation, player };
}

export function validSlotPlan(actions, candidates) {
  return validResearchSlotPlan(actions?.[0], actions) &&
    actions.every(action => candidates.some(candidate => candidate.id === action));
}

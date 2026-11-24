import { RESEARCH_SEQUENCE_PROFILE, RESEARCH_SEQUENCE_MAX_SEGMENTS, RESEARCH_SEQUENCE_MAX_TICKS,
  validResearchActionSequence } from '../../../shared/survivors-research-contract.js';
import { ResearchModelError } from './common.js';

export { RESEARCH_SEQUENCE_PROFILE as SEQUENCE_ACTION_PROFILE,
  RESEARCH_SEQUENCE_MAX_SEGMENTS as MAX_ACTION_SEGMENTS };
export const SEQUENCE_END = 'END';

export const SEQUENCE_POLICY = [
  'Choose up to six actions to execute in order, starting now.',
  'You may repeat an action. A move with ticks:1 lasts one simulation tick (about 16.7 ms).',
  'Movement is cut off after ' + RESEARCH_SEQUENCE_MAX_TICKS + ' ticks (300 ms). A new plan replaces the unfinished plan.',
  'Stop or an upgrade must be the only action if selected.',
].join(' ');

export function validActionSequence(actions, candidates) {
  return validResearchActionSequence(actions?.[0], actions) &&
    actions.every(action => candidates.some(candidate => candidate.id === action));
}

export function parseActionSequence(raw, candidates) {
  let result;
  try { result = JSON.parse(raw); } catch { /* invalid model output */ }
  if (!result || Object.keys(result).length !== 1 || !validActionSequence(result.action_ids, candidates)) {
    throw new ResearchModelError('invalid_action_sequence', 'Expected one legal ordered action_ids array');
  }
  return result.action_ids;
}

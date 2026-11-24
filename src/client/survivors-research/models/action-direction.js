import {researchCandidates, RESEARCH_COVERAGE_SEQUENCE_PROFILE, RESEARCH_SEQUENCE_PROFILE} from '../../../shared/survivors-research-contract.js';

const directions = ['up', 'down', 'left', 'right'];
const noTarget = 'none';
const actions = [...directions.map(direction => [direction, 'move:' + direction + ':hold:100']), ['stop', 'stop']];
const actionByDirection = new Map(actions);
const catalogs = new Map([RESEARCH_SEQUENCE_PROFILE, RESEARCH_COVERAGE_SEQUENCE_PROFILE]
  .map(profile => [profile, researchCandidates(profile)]));
const target = value => value === noTarget || directions.includes(value);
const count = value => Number.isSafeInteger(value) && value >= 0;

export function validDirectionContext(value) {
  if (value === null) return true;
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 6 && target(value.threat) && target(value.crystal) &&
    actionByDirection.has(value.action) && count(value.observed_tick) &&
    count(value.applied_tick) && value.applied_tick > value.observed_tick && count(value.hits_since_observation);
}

export function directionCandidatesMatch(candidates, profile = RESEARCH_SEQUENCE_PROFILE) {
  const catalog = catalogs.get(profile);
  return candidates.length === catalog?.length && catalog.every(({id, description}, index) =>
    candidates[index].id === id && candidates[index].description === description);
}

export function directionAction(direction) {
  return actionByDirection.get(direction);
}

export function directionQuestions() {
  return [
    {type: 'choice', name: 'threat',
      instructions: 'Relative to your current position, which direction contains the enemy most likely to hit you soon? Use the nearest edge and enemy motion. This is the direction of the threat.',
      choices: [...directions, noTarget].map(value => ({value, description: value === noTarget ? 'No imminent threat.' : 'Threat is ' + value + '.'}))},
    {type: 'choice', name: 'crystal',
      instructions: 'Which direction has an uncollected experience crystal you can safely approach? Use the current positions, enemy movement and pickup radius.',
      choices: [...directions, noTarget].map(value => ({value, description: value === noTarget ? 'No safe crystal target now.' : 'Approach a crystal to the ' + value + '.'}))},
    {type: 'choice', name: 'direction',
      instructions: 'Choose the immediate action that avoids contact first and collects experience crystals when safe. Evaluate the threat and crystal directions from this same frame. The current movement vector is actual movement. direction_context contains the last applied decision and hits since that decision was observed. Recheck those old bearings against this frame. If repeatedly hit while going straight, choose an open escape direction. Stop only when holding your position is safe.',
      choices: actions.map(([value]) => ({value, description: value === 'stop' ? 'Stop now.' : 'Move ' + value + ' for up to 100 ms.'}))},
  ];
}

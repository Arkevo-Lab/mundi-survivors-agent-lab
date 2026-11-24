import {ACTION_POLICY} from '../../src/client/survivors-research/models/action-prompt.js';
import {validActionContext} from '../../src/client/survivors-research/models/action-observation.js';
import {DECISIONS_MODEL, validTrainingStrategy, WHIP_GUIDANCE}
  from '../../src/client/survivors-research/models/decisions.js';
import {WHOLE_PATH_DIRECTIONS as directions, WHOLE_PATH_STEPS as windows, wholePathDirections, wholePathQuestion}
  from '../../src/client/survivors-research/models/action-whole-path.js';
import {RESEARCH_SLOTS_PROFILE, researchCandidates} from '../../src/shared/survivors-research-contract.js';

export const WHOLE_PATH_ARMS = Object.freeze(['independent', 'whole-path']);
const candidates = researchCandidates(RESEARCH_SLOTS_PROFILE);
const basePolicy = ACTION_POLICY
  .replace('Choose one action for the Mundi Survivors real-time research game.', 'Control movement in the Mundi Survivors real-time research game.')
  .replace('Select upgrades using a listed upgrade action. ', '')
  .replace('Movement persists for its listed duration or distance, or until replaced. Stop cancels movement. ', '')
  .replace('Use the supplied observation and candidate list, and the same-tick image when provided.', 'Use the supplied public observation and choices.');
const timing = 'One movement plan contains three consecutive 100 ms steps (300 ms total). ' +
  'The steps begin when the plan is applied. Only up, down, left, and right are available.';
const moves = directions.map(value => ({value, description: 'Move ' + value + ' for 100 ms.'}));
export function wholePathInput(observation, strategy, arm) {
  if (!WHOLE_PATH_ARMS.includes(arm) || observation?.profile !== 'state-detail-v1' ||
      observation.upgrade_offer || !validActionContext({observation, candidates}) || !validTrainingStrategy(strategy)) {
    throw new TypeError('Expected a public movement observation, strategy and whole-path arm');
  }
  const questions = arm === 'independent' ? windows.map((window, index) => ({
    type: 'choice', name: 'step_' + (index + 1),
    instructions: 'Choose the direction for step ' + (index + 1) + ', the ' + window +
      ' window after plan application. Each question sees the same observation and cannot see the other answers.',
    choices: moves,
  })) : [wholePathQuestion()];
  return {model: DECISIONS_MODEL, input: [{role: 'user', content: [
    {type: 'input_text', text: JSON.stringify(observation)},
    {type: 'input_text', text: [basePolicy, timing, strategy, WHIP_GUIDANCE].join(' ')},
  ]}], questions};
}

const probability = value => Number.isFinite(value) && value >= 0 && value <= 1;

export function parseWholePathResponse(raw, input, arm) {
  if (!WHOLE_PATH_ARMS.includes(arm)) throw new TypeError('Unknown whole-path arm');
  const fail = () => {throw Object.assign(Error('Decisions returned an invalid whole-path answer'), {code: 'malformed'});};
  let data;
  try {data = JSON.parse(raw);} catch {fail();}
  if (!Array.isArray(data?.answers) || data.answers.length !== input.questions.length) fail();
  const answers = data.answers.map((answer, index) => {
    const question = input.questions[index];
    const values = new Set(question.choices.map(choice => choice.value));
    if (answer?.type !== 'choice' || answer.name !== question.name || !values.has(answer.choice) ||
        !probability(answer.confidence) || !Array.isArray(answer.probabilities) ||
        answer.probabilities.length !== values.size ||
        !answer.probabilities.every(row => values.delete(row?.value) && probability(row.probability))) fail();
    return answer.choice;
  });
  const steps = arm === 'independent' ? answers : wholePathDirections(answers[0]);
  if (steps?.length !== windows.length || !steps.every(direction => directions.includes(direction))) fail();
  return [...steps];
}

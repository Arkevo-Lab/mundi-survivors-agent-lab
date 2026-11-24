import {DECISIONS_MODEL} from '../../src/client/survivors-research/models/decisions.js';
import {matchesChoice, openNativeDecisionsTransport} from './native-decisions-transport.mjs';

const cardinal = ['up', 'down', 'left', 'right'];
const catalogs = new Map([
  ['direction', [...cardinal, 'up-left', 'up-right', 'down-left', 'down-right']],
  ['minimum_steps', ['1', '2', '3', 'more-than-3']],
  ['path', cardinal.flatMap(a => cardinal.flatMap(b => cardinal.map(c => [a, b, c].join(':'))))],
]);

function prepare(input) {
  if (input?.model !== DECISIONS_MODEL || !Array.isArray(input.questions) || input.questions.length !== catalogs.size) {
    throw new TypeError('Expected the three native Luna diagnostic questions');
  }
  const expected = new Map();
  for (const [index, [name, values]] of [...catalogs].entries()) {
    const question = input.questions[index];
    if (question?.name !== name || question.type !== 'choice' || !Array.isArray(question.choices) ||
        question.choices.length !== values.length || !values.every((value, index) => question.choices[index]?.value === value)) {
      throw new TypeError('Invalid choice catalog for ' + name);
    }
    expected.set(name, new Set(values));
  }
  return expected;
}

function validate(answers, expected) {
  const grouped = new Map();
  let unknown = false;
  for (const answer of Array.isArray(answers) ? answers : []) {
    if (!expected.has(answer?.name)) {
      unknown = true;
      continue;
    }
    const named = grouped.get(answer.name) ?? [];
    named.push(answer);
    grouped.set(answer.name, named);
  }
  const question_results = Object.fromEntries([...expected].map(([name, choices]) => {
    const named = grouped.get(name) ?? [];
    const [answer] = named;
    const status = named.length === 0 ? 'missing' : named.length !== 1 ? 'malformed'
      : answer.type === 'refusal' ? 'refusal' : matchesChoice(answer, choices) ? 'valid' : 'malformed';
    return [name, {status, ...(status === 'valid' && {choice: answer.choice})}];
  }));
  const statuses = Object.values(question_results).map(result => result.status);
  const error = unknown || statuses.some(status => status === 'malformed' || status === 'missing')
    ? {code: 'malformed'} : statuses.includes('refusal') ? {code: 'provider_refusal'} : null;
  const valid = [...grouped.values()].flat().filter(answer => question_results[answer.name].status === 'valid');
  return {answers: valid, question_results, error};
}

export function openBasicMovementTransport(options) {
  return openNativeDecisionsTransport({prepare, validate}, options);
}

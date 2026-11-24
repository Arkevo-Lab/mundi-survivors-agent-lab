import {DECISIONS_MODEL} from '../../src/client/survivors-research/models/decisions.js';
import {matchesChoice, openNativeDecisionsTransport} from './native-decisions-transport.mjs';

function choiceSets(input) {
  const {model, questions} = input ?? {};
  if (model !== DECISIONS_MODEL || !Array.isArray(questions) || ![1, 3].includes(questions.length)) {
    throw new TypeError('Expected a native Luna whole-path comparison request');
  }
  const choiceCount = questions.length === 1 ? 64 : 4;
  const expected = new Map();
  for (const question of questions) {
    const {name, type, choices} = question;
    const ids = Array.isArray(choices) && choices.map(choice => choice?.value);
    if (typeof name !== 'string' || !name || expected.has(name) || type !== 'choice' ||
        !ids || ids.length !== choiceCount || new Set(ids).size !== choiceCount ||
        ids.some(id => typeof id !== 'string' || !id)) throw new TypeError('Invalid whole-path choice catalog');
    expected.set(name, new Set(ids));
  }
  return expected;
}

function validAnswers(answers, expected) {
  if (!Array.isArray(answers) || answers.length !== expected.size) return false;
  return answers.every(answer => {
    const choices = expected.get(answer?.name);
    if (!matchesChoice(answer, choices)) return false;
    expected.delete(answer.name);
    return true;
  });
}

function validate(answers, expected) {
  if (Array.isArray(answers) && answers.some(answer => answer?.type === 'refusal')) {
    return {error: {code: 'provider_refusal'}};
  }
  return validAnswers(answers, expected) ? {answers} : {error: {code: 'malformed'}};
}

export function openWholePathTransport(options) {
  return openNativeDecisionsTransport({prepare: choiceSets, validate}, options);
}

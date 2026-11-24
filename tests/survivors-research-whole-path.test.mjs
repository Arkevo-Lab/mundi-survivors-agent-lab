import assert from 'node:assert/strict';
import test from 'node:test';
import {wholePathInput, parseWholePathResponse} from '../scripts/survivors-research/whole-path-protocol.mjs';

const observation = {
  schema: 'survivors-observation-v1', profile: 'state-detail-v1', tick: 42, terminal: false,
  player: {hp: 100, speed: 3.2}, loot: [{id: 1, kind: 'experience', dx: 1, dy: 0}],
};
const strategy = 'Collect reachable crystals and preserve a safe exit.';
const independent = wholePathInput(observation, strategy, 'independent');
const whole = wholePathInput(observation, strategy, 'whole-path');

test('both arms share input bytes and offer the same 64 legal ordered sequences', () => {
  assert.deepEqual(independent.input, whole.input);
  const choices = independent.questions.map(question => question.choices.map(choice => choice.value));
  const expected = choices[0].flatMap(a => choices[1].flatMap(b => choices[2].map(c => [a, b, c].join(':'))));
  const paths = whole.questions[0].choices;
  assert.deepEqual(paths.map(path => path.value), expected);
  assert.equal(new Set(expected).size, 64);
  assert.deepEqual(choices[0], ['up', 'down', 'left', 'right']);
  assert.match(independent.questions[0].instructions, /0–100 ms/);
  assert.match(independent.questions[1].instructions, /100–200 ms/);
  assert.match(independent.questions[2].instructions, /200–300 ms/);
  assert.equal(paths[6].description, '0–100 ms: move up, 100–200 ms: move down, 200–300 ms: move left.');
  assert.deepEqual(wholePathInput({...observation, loot: []}, strategy, 'whole-path').questions, whole.questions);
});

test('parses exactly three ordered model choices with no completion or repair', () => {
  const answers = (input, choices) => input.questions.map((question, index) => ({
    type: 'choice', name: question.name, choice: choices[index], confidence: 1,
    probabilities: question.choices.map(({value}) => ({value, probability: Number(value === choices[index])})),
  }));
  const single = answers(independent, ['up', 'down', 'left']);
  const path = answers(whole, ['up:down:left']);
  assert.deepEqual(parseWholePathResponse(JSON.stringify({answers: single}), independent, 'independent'), ['up', 'down', 'left']);
  assert.deepEqual(parseWholePathResponse(JSON.stringify({answers: path}), whole, 'whole-path'), ['up', 'down', 'left']);
  path[0].choice = 'up:down:wait';
  assert.throws(() => parseWholePathResponse(JSON.stringify({answers: path}), whole, 'whole-path'), {code: 'malformed'});
  assert.throws(() => parseWholePathResponse(JSON.stringify({answers: single.slice(1)}), independent, 'independent'), {code: 'malformed'});
});

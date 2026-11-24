import assert from 'node:assert/strict';
import test from 'node:test';
import {openBasicMovementTransport} from '../scripts/survivors-research/basic-movement-transport.mjs';
import {openWholePathTransport} from '../scripts/survivors-research/whole-path-transport.mjs';

const cardinal = ['up', 'down', 'left', 'right'];
const input = {model: 'gpt-6-luna', input: [], questions: [
  ['direction', [...cardinal, 'up-left', 'up-right', 'down-left', 'down-right']],
  ['minimum_steps', ['1', '2', '3', 'more-than-3']],
  ['path', cardinal.flatMap(a => cardinal.flatMap(b => cardinal.map(c => [a, b, c].join(':'))))],
].map(([name, choices]) => ({name, type: 'choice', choices: choices.map(value => ({value}))}))};

test('diagnostic transport preserves valid siblings and separately records a path refusal', async () => {
  const key = 'basic-movement-fixture-key';
  let calls = 0;
  const transport = await openBasicMovementTransport({readKey: async () => key, fetchModel: async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/decisions');
    assert.deepEqual(JSON.parse(init.body), input);
    assert.equal(init.headers.Authorization, 'Bearer ' + key);
    const answers = input.questions.map(({name, choices}) => ({name, type: 'choice', choice: choices[0].value,
      confidence: 1, probabilities: choices.map(({value}, i) => ({value, probability: Number(i === 0)}))}));
    if (++calls === 1) answers[2] = {name: 'path', type: 'refusal'};
    if (calls === 2) answers[1].probabilities.pop();
    return Response.json({answers, usage: {input_tokens: 123}}, {headers: {'openai-processing-ms': '35.4'}});
  }});
  const first = await transport.request(input);
  assert.deepEqual(first.question_results, {
    direction: {status: 'valid', choice: 'up'}, minimum_steps: {status: 'valid', choice: '1'}, path: {status: 'refusal'},
  });
  assert.equal(first.error.code, 'provider_refusal');
  assert.equal(first.answers.length, 2);
  assert.equal(JSON.parse(first.raw_response).answers[2].type, 'refusal');
  assert.equal(first.backend_metadata.upstream_openai_processing_ms, 35.4);
  assert.equal(first.usage.input_tokens, 123);
  assert.ok(first.end_to_end_ms >= first.backend_metadata.upstream_round_trip_ms);
  const second = await transport.request(input);
  assert.equal(second.error.code, 'malformed');
  assert.equal(second.question_results.minimum_steps.status, 'malformed');
  assert.equal(second.question_results.path.status, 'valid');
  transport.close();
});

test('diagnostic request shape remains separate from the old whole-path contract', async () => {
  const options = {readKey: async () => 'basic-movement-fixture-key', fetchModel: () => assert.fail('Unexpected dispatch')};
  const diagnostic = await openBasicMovementTransport(options);
  const old = await openWholePathTransport(options);
  await assert.rejects(diagnostic.request({...input, questions: [input.questions[2]]}), /three native Luna/);
  await assert.rejects(old.request(input), /Invalid whole-path choice catalog/);
  diagnostic.close();
  old.close();
});

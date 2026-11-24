import assert from 'node:assert/strict';
import test from 'node:test';
import {openWholePathTransport} from '../scripts/survivors-research/whole-path-transport.mjs';

const directions = ['up', 'down', 'left', 'right'];
const paths = directions.flatMap(a => directions.flatMap(b => directions.map(c => [a, b, c].join(':'))));
const question = (name, values) => ({name, type: 'choice', choices: values.map(value => ({value}))});
const request = questions => ({model: 'gpt-6-luna', input: [], questions});
const independent = request(['step_1', 'step_2', 'step_3'].map(name => question(name, directions)));
const whole = request([question('path', paths)]);
const answers = ({questions}) => questions.map(({name, choices}) => ({
  name, type: 'choice', choice: choices[0].value, confidence: 1,
  probabilities: choices.map(({value}, index) => ({value, probability: Number(index === 0)})),
}));

test('whole-path transport sends each arm unchanged and records native Decisions timing', async () => {
  const key = 'fixture-whole-path-key';
  const calls = [];
  let loads = 0;
  const transport = await openWholePathTransport({
    readKey: async () => { loads++; return key; },
    fetchModel: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/decisions');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer ' + key);
      const body = JSON.parse(options.body);
      calls.push(body);
      return Response.json({model: 'gpt-6-luna', answers: answers(body)},
        {headers: {'openai-processing-ms': calls.length === 1 ? '123.5' : '1, 2'}});
    },
  });
  const a = await transport.request(independent);
  const b = await transport.request(whole);
  assert.equal(a.error, null);
  assert.equal(b.error, null);
  assert.equal(a.backend_metadata.upstream_openai_processing_ms, 123.5);
  assert.equal(b.backend_metadata.upstream_openai_processing_ms, null);
  assert.equal(a.backend_metadata.upstream_status, 200);
  assert.equal(a.backend_metadata.upstream_dispatched, true);
  assert.ok(a.end_to_end_ms >= a.backend_metadata.upstream_round_trip_ms);
  assert.deepEqual(JSON.parse(b.raw_response).answers, b.answers);
  assert.deepEqual(calls, [independent, whole]);
  assert.equal(loads, 1);
  transport.close();
  await assert.rejects(transport.request(whole), /open transport/);
});

test('whole-path transport rejects incomplete catalogs, bad responses and cancelled requests', async () => {
  const key = 'fixture-whole-path-key';
  let dispatched = 0;
  const transport = await openWholePathTransport({
    readKey: async () => key,
    fetchModel: async (_url, {body}) => {
      dispatched++;
      const rows = answers(JSON.parse(body));
      if (dispatched === 1) rows[0].probabilities.pop();
      if (dispatched === 2) return Response.json({message: key}, {status: 401});
      return Response.json({answers: rows});
    },
  });
  await assert.rejects(transport.request(request([question('path', paths.slice(1))])), /Invalid whole-path/);
  const cancelled = await transport.request(whole, {signal: AbortSignal.abort()});
  assert.equal(cancelled.error.code, 'cancelled');
  assert.equal(cancelled.backend_metadata.upstream_dispatched, false);
  const malformed = await transport.request(whole);
  assert.equal(malformed.error.code, 'malformed');
  assert.equal(malformed.answers, null);
  const unauthorized = await transport.request(whole);
  assert.equal(unauthorized.error.code, 'provider_error');
  assert.equal(unauthorized.raw_response, null);
  assert.equal(unauthorized.http_status, 401);
  assert.equal(dispatched, 2);
  transport.close();
});

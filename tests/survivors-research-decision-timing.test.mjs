import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgent } from '../src/client/survivors-research/agent-loop.js';
import { researchNow } from '../src/client/survivors-research/models/common.js';
import { createResearchModel } from '../src/client/survivors-research/models/index.js';

const candidates = [{ id: 'stop', description: 'Stop' }];
const observation = {
  schema: 'survivors-observation-v1', run_id: 'fixture', observation_id: 'obs-5', tick: 5,
  profile: 'state-compact-v1', terminal: false,
};
const read = () => new Promise(resolve => setTimeout(resolve, 2));
const nonNegative = value => assert.ok(Number.isFinite(value) && value >= 0);

async function capture({ model, ...options }) {
  const events = [];
  await runAgent({
    observe: async ({ after_tick }) => after_tick === -1 ? { observation, candidates } : { terminal: true },
    submit: () => assert.fail('Action not expected'),
    model,
    ...options,
    onEvent: event => events.push(event),
  });
  return events.find(event => event.type === 'model:attempt') ?? events.find(event => event.type === 'model:observe_failed');
}

test('decision trace separates page pacing, observation cache and the action acknowledgement phases', async () => {
  let worker;
  const event = await capture({
    model: createResearchModel({ kind: 'mock', delay_ms: 2 }),
    observe: async ({ after_tick }) => {
      if (after_tick !== -1) return { terminal: true };
      await read();
      const requestedAt = researchNow();
      worker = { snapshot_cache_hit: true, observation_cache_hit: true, visual_cache_hit: null };
      await read();
      return { observation, candidates, observation_timing: worker,
        page_observation_timing: { requested_at_ms: requestedAt, returned_at_ms: researchNow() } };
    },
    submit: async payload => {
      const receivedAt = researchNow();
      await read();
      const appliedAt = researchNow();
      return { ...payload, received_at_ms: receivedAt, applied_tick: 7,
        applied_at_ms: appliedAt, tick_completed_at_ms: researchNow() };
    },
  });
  const trace = event.decision_timing;
  assert.equal(trace.schema, 'survivors-decision-timing-v1');
  assert.equal(trace.observation.worker, worker);
  assert.ok(trace.observation.pre_request_wait_ms > 0);
  assert.ok(trace.observation.round_trip_ms > 0);
  assert.ok(trace.observation.observe_elapsed_ms >= trace.observation.round_trip_ms + trace.observation.pre_request_wait_ms);
  assert.equal(trace.visual.status, 'not_applicable');
  assert.equal(trace.visual.render_ms, null);
  assert.equal(trace.model.transport_kind, 'local_mock');
  assert.equal(trace.model.provider_round_trip_ms, null);
  assert.equal(trace.model.provider_inference_ms, null);
  assert.equal(trace.model.provider_cache_read_tokens, null);
  assert.equal(trace.action.status, 'applied');
  const { page_to_worker_ms, worker_wait_to_apply_ms, worker_tick_after_apply_ms, worker_tick_to_ack_ms } = trace.action;
  assert.equal(trace.action.round_trip_ms, page_to_worker_ms + worker_wait_to_apply_ms + worker_tick_after_apply_ms + worker_tick_to_ack_ms);
  assert.deepEqual(event.input, { observation, candidates });
});

test('invalid image, invalid model output and cancellation leave unentered phases unknown', async () => {
  const mock = createResearchModel({ kind: 'mock', failure: 'malformed' });
  const imageFailure = await capture({
    model: mock, visualProfile: 'structured-v1',
    observe: async ({ after_tick }) => after_tick === -1
      ? { observation, candidates, visual_frame: { tick: 5 } } : { terminal: true },
    prepareImage: async () => ({ image: {}, render_ms: 2, encode_ms: 3 }),
  });
  assert.equal(imageFailure.status, 'visual_error');
  assert.equal(imageFailure.decision_timing.visual.status, 'failed');
  assert.equal(imageFailure.decision_timing.visual.render_ms, 2);
  nonNegative(imageFailure.decision_timing.visual.validation_ms);
  assert.equal(imageFailure.decision_timing.model.started_at_ms, null);
  assert.equal(imageFailure.decision_timing.action.round_trip_ms, null);

  const malformed = await capture({ model: mock });
  assert.equal(malformed.error.code, 'malformed');
  assert.equal(malformed.decision_timing.model.status, 'failed');
  nonNegative(malformed.decision_timing.model.output_parse_ms);
  assert.equal(malformed.decision_timing.action.status, 'not_sent');

  const controller = new AbortController();
  const cancelled = await capture({
    model: mock, signal: controller.signal,
    observe: async () => { controller.abort(); throw controller.signal.reason; },
  });
  assert.equal(cancelled.type, 'model:observe_failed');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.decision_timing.observation.round_trip_ms, null);
  assert.equal(cancelled.decision_timing.model.status, 'not_started');
});

test('HTTP adapter measures request preparation, body wait, decode, action parse and nested provider separately', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let responseMode = 'ok';
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/survivors-research/model/action');
    assert.deepEqual(JSON.parse(options.body), { observation, candidates, model: 'fixture' });
    if (responseMode === 'abort') {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
    await read();
    if (responseMode === 'bad') return new Response('invalid envelope');
    return Response.json({
      raw_response: '{"choices":[{"message":{"content":"{\\"action_id\\":\\"stop\\"}"}}]}',
      usage: { prompt_tokens_details: { cached_tokens: 0 } },
      backend_metadata: { upstream_round_trip_ms: 1, upstream_request_serialize_ms: 0.2 },
    });
  };
  const model = createResearchModel({ kind: 'generative', model: 'fixture' });
  const result = await capture({ model, submit: async payload => ({ ...payload, error: { code: 'terminal' } }) });
  const timing = result.decision_timing.model;
  assert.equal(result.decision_timing.action.status, 'rejected');
  assert.equal(result.decision_timing.action.applied_at_ms, null);
  assert.equal(timing.transport_kind, 'browser_http');
  let previous = timing.started_at_ms;
  for (const key of ['input_prepare', 'input_serialize', 'transport', 'response_decode', 'output_parse']) {
    const started = timing[key + '_started_at_ms'];
    const finished = timing[key + '_finished_at_ms'];
    assert.ok(started >= previous);
    assert.ok(finished >= started);
    assert.equal(timing[key + '_ms'], finished - started);
    previous = finished;
  }
  assert.ok(timing.finished_at_ms >= previous);
  assert.ok(timing.total_ms >= timing.input_prepare_ms + timing.input_serialize_ms + timing.transport_ms +
    timing.response_decode_ms + timing.output_parse_ms);
  assert.equal(timing.provider_round_trip_ms, 1);
  assert.equal(timing.provider_request_serialize_ms, 0.2);
  assert.equal(timing.provider_inference_ms, null);
  assert.equal(timing.provider_cache_read_tokens, 0);

  responseMode = 'bad';
  const malformed = await capture({ model });
  assert.equal(malformed.status, 'model_error');
  nonNegative(malformed.decision_timing.model.response_decode_ms);
  assert.equal(malformed.decision_timing.model.output_parse_ms, null);

  responseMode = 'abort';
  const controller = new AbortController();
  const abortingModel = { decide(args) {
    setTimeout(() => controller.abort(), 3);
    return model.decide(args);
  } };
  const aborted = await capture({ model: abortingModel, signal: controller.signal });
  assert.equal(aborted.decision_timing.model.status, 'cancelled');
  nonNegative(aborted.decision_timing.model.transport_ms);
  assert.equal(aborted.decision_timing.model.response_decode_ms, null);
  assert.equal(aborted.decision_timing.model.output_parse_ms, null);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { runAgent } from '../src/client/survivors-research/agent-loop.js';
import { calibrateLink, freezeLinkCalibration, requestLatency } from '../src/client/survivors-research/models/compensation.js';
import { createResearchModel } from '../src/client/survivors-research/models/index.js';

const now = 1_700_000_000_000;
const line = (lineId, ms, options = {}) => ({
  schema: 'mundi-link-calibration-v1',
  line_id: lineId,
  endpoint: 'https://api.openai.com/v1/models',
  collector: 'curl-num-connects-v1',
  measured_at: now - 5,
  method: 'GET',
  metric: 'warm-https-total-ms',
  expected_http_status: 401,
  samples: [
    { ms: 1000, http_status: 401, connection: 'new' },
    { ms: 1000, http_status: 401, connection: 'unknown' },
    { ms: 1000, http_status: 429, connection: 'reused' },
    { ms: 1000, http_status: 401, connection: 'reused', error: 'timeout' },
    ...ms.map(value => ({ ms: value, http_status: 401, connection: 'reused' })),
  ],
  ...options,
});

test('link budget derives from matching warm-probe medians and preserves frozen provenance', () => {
  const current = line('current', [219, 223, 225, 229]);
  const target = line('target', [39, 43, 45, 49]);
  const calibration = calibrateLink(current, target, { now });
  assert.equal(calibration.current.stats.p50_ms, 224);
  assert.equal(calibration.target.stats.p50_ms, 44);
  assert.equal(calibration.current.stats.n, 4);
  assert.equal(calibration.current.stats.excluded, 4);
  assert.equal(calibration.budget_ms, 180);
  assert.equal(calibration.comparison, 'matched-probe-estimate');
  assert.equal(freezeLinkCalibration(calibration, now + 100).budget_ms, 180);
  assert.throws(() => freezeLinkCalibration({ ...calibration, budget_ms: 99 }, now), /does not match/);
  assert.throws(() => freezeLinkCalibration(calibration, calibration.expires_at_ms), /expired/);
  assert.throws(() => calibrateLink(current, line('target', [1, 2]), { now }), /three/);
  assert.throws(() => calibrateLink(current, line('target', [1, 2, 3], { expected_http_status: undefined }), { now }), /three/);
  assert.throws(() => calibrateLink(current, line('target', [1, 2, 3], { method: 'HEAD', metric: 'warm-https-headers-ms' }), { now, allowProxy: true }), /methods and metrics/);
  const proxy = line('target', [42, 44, 46], { endpoint: 'https://different.invalid/v1/models' });
  assert.throws(() => calibrateLink(current, proxy, { now }), /proxy opt-in/);
  assert.equal(calibrateLink(current, proxy, { now, allowProxy: true }).comparison, 'proxy-estimate');
  assert.equal(calibrateLink(target, current, { now }).budget_ms, 0);
  assert.deepEqual(requestLatency(51, calibration.budget_ms), {
    raw_request_ms: 51, estimated_adjusted_request_ms: 0, link_compensation_ms: 180,
  });
});

const observation = { tick: 1, observation_id: 'obs-1', terminal: false };
const candidates = [{ id: 'stop', description: 'Stop' }];
const observe = async ({ after_tick }) => after_tick < 0 ? { observation, candidates } : { terminal: true };

test('model loop orders begin, decide, cleanup and action; default off sends no pause RPC', async () => {
  for (const budget of [0, 24.5]) {
    const order = [];
    const attempts = [];
    const baseline = createResearchModel({ kind: 'mock', delay_ms: 2 });
    const outcome = await runAgent({
      compensationMs: budget, observe,
      onRequestStart: async detail => { order.push(['begin', detail]); },
      onRequestEnd: async detail => {
        order.push(['end', detail]);
        return { decision_id: detail.decision_id, paused_ms: 2, budget_ms: budget, active: false };
      },
      model: { async decide(args) { order.push(['model']); return baseline.decide(args); } },
      submit: async detail => { order.push(['action', detail]); return { ...detail, applied_tick: 2 }; },
      onEvent: event => { if (event.type === 'model:attempt') attempts.push(event); },
    });
    assert.equal(outcome.applied, 1);
    assert.deepEqual(order.map(([name]) => name), budget ? ['begin', 'model', 'end', 'action'] : ['model', 'action']);
    const attempt = attempts[0];
    assert.equal(attempt.request_latency.raw_request_ms, attempt.decision_timing.model.total_ms);
    assert.equal(attempt.request_latency.estimated_adjusted_request_ms,
      Math.max(0, attempt.request_latency.raw_request_ms - budget));
    if (budget) {
      assert.equal(order[0][1].decision_id, order[2][1].decision_id);
      assert.equal(order[0][1].decision_id, order[3][1].decision_id);
      assert.equal(order[2][1].reason, 'completed');
      assert.equal(attempt.compensation_receipt.paused_ms, 2);
    } else {
      assert.equal(attempt.compensation_receipt, null);
    }
  }
});

test('model cleanup runs after cancellation, timeout, and ambiguous begin errors', async () => {
  for (const mode of ['cancel', 'terminal-begin', 'timeout', 'begin-error', 'end-error']) {
    const controller = new AbortController();
    const ended = [];
    const events = [];
    const loop = runAgent({
      compensationMs: 60, observe, signal: controller.signal,
      onRequestStart: async () => {
        if (mode === 'begin-error') throw new Error('arm failed');
        if (mode === 'cancel' || mode === 'terminal-begin') controller.abort();
        if (mode === 'terminal-begin') throw Object.assign(new Error('Run ended'), { code: 'terminal' });
      },
      onRequestEnd: async detail => {
        ended.push(detail);
        if (mode === 'end-error') throw new Error('release failed');
        return { paused_ms: 1, active: false };
      },
      model: mode === 'timeout' ? createResearchModel({ kind: 'mock', failure: 'timeout', timeout_ms: 5 })
        : mode === 'end-error' ? createResearchModel({ kind: 'mock' })
          : { decide: () => assert.fail('Request must not be dispatched') },
      submit: () => assert.fail('Action must not be submitted'),
      onEvent: event => { if (event.type === 'model:attempt') events.push(event); },
    });
    if (mode.endsWith('-error')) await assert.rejects(loop, /arm failed|release failed/);
    else await loop;
    assert.equal(ended.length, mode === 'terminal-begin' ? 0 : 1);
    if (ended.length) {
      assert.equal(ended[0].reason, mode === 'cancel' ? 'cancelled' : mode === 'end-error' ? 'completed' : 'failed');
    }
    const cancelled = mode === 'cancel' || mode === 'terminal-begin';
    assert.equal(events[0].status, mode.endsWith('-error') ? 'environment_error' : cancelled ? 'cancelled' : 'model_error');
    assert.equal(events[0].request_latency.raw_request_ms === null, cancelled || mode === 'begin-error');
  }
});

test('a change in compensation applies to the next decision only', async () => {
  let budget = 25;
  const began = [], ended = [], recorded = [];
  await runAgent({
    observe: async ({after_tick}) => after_tick < 2
      ? {observation: {...observation, tick: after_tick + 2}, candidates} : {terminal: true},
    currentCompensation: () => budget,
    onRequestStart: detail => { began.push(detail.budget_ms); },
    onRequestEnd: detail => { ended.push(detail.budget_ms); },
    model: {decide() { budget = 75; return {action_id: 'stop'}; }},
    submit: async ({observation_id}) => ({observation_id, applied_tick: 4}),
    onEvent: event => {
      if (event.type === 'model:attempt') recorded.push(event.request_latency.link_compensation_ms);
    },
  });
  assert.deepEqual(began, [25, 75]);
  assert.deepEqual(ended, began);
  assert.deepEqual(recorded, began);
});

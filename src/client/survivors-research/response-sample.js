import {RESEARCH_SEQUENCE_PROFILE} from '../../shared/survivors-research-contract.js';
import {ResearchModelError} from './models/common.js';
import {validateVisualImage} from './models/visual-input.js';
import {createVisualCapture} from './visual-render.js';
import {connectSimulation, expectResponse} from './worker-client.js';

export const SAMPLES_PER_CONDITION = 5;
const STRUCTURED = 'structured-v1';

export async function prepareResponseSample(config, signal) {
  const started = performance.now();
  const runId = crypto.randomUUID();
  const worker = connectSimulation();
  let created, sample;
  try {
    created = expectResponse(await worker.request('research:create', runId, {config}, {signal}));
    sample = expectResponse(await worker.request('research:observe', runId, {
      after_tick: -1, include_visual_frame: true,
    }, {signal}));
  } finally {
    worker.close();
  }
  const {observation, candidates, visual_frame} = sample;
  if (observation?.tick !== 0 || visual_frame?.tick !== 0 || observation.terminal || candidates?.length < 2) {
    throw Error('无法取得完整的第 0 帧观测');
  }
  const observationMs = performance.now() - started;
  const imageStarted = performance.now();
  const capture = await createVisualCapture()({visual_frame, observation, profile: STRUCTURED, signal});
  const imageMetadata = validateVisualImage(capture.image, 0, STRUCTURED);
  signal.throwIfAborted();
  return {observation, candidates, image: capture.image, setup: {
    config: created.config, observation_ms: observationMs, image_prepare_ms: performance.now() - imageStarted,
    image_render_ms: capture.render_ms, image_encode_ms: capture.encode_ms, image: imageMetadata,
  }};
}

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return {n, p50: null, min: null, max: null};
  return {n, p50: (sorted[(n - 1) >> 1] + sorted[n >> 1]) / 2, min: sorted[0], max: sorted.at(-1)};
}

export function summarizeResponseSamples(attempts) {
  const ok = attempts.filter(attempt => attempt.legal_action);
  return {
    n: attempts.length, legal_actions: ok.length, legal_rate: attempts.length ? ok.length / attempts.length : null,
    total_ms: distribution(ok.map(attempt => attempt.total_ms)),
    ...(ok.some(attempt => Object.hasOwn(attempt, 'adjusted_total_ms')) && {
      adjusted_total_ms: distribution(ok.map(attempt => attempt.adjusted_total_ms)),
    }),
    browser_http_ms: distribution(ok.map(attempt => attempt.browser_http_ms)),
    upstream_ms: distribution(ok.map(attempt => attempt.upstream_ms)),
  };
}

async function measure(model, context, signal) {
  const started = performance.now();
  let result, failure;
  try {
    result = await model.decide({...context, signal});
  } catch (error) {
    const known = error instanceof ResearchModelError;
    result = known ? error.details : {};
    failure = {code: known ? error.code : 'model_unavailable', message: known ? error.message : '模型请求失败'};
  }
  const totalMs = performance.now() - started;
  const legal = !failure && context.candidates.some(candidate => candidate.id === result.action_id);
  const {transport_started_at_ms: sent, transport_finished_at_ms: received} = result.timings ?? {};
  const meta = result.backend_metadata;
  return {
    total_ms: totalMs, browser_http_ms: Number.isFinite(sent) && Number.isFinite(received) ? received - sent : null,
    upstream_ms: meta?.upstream_round_trip_ms ?? null, upstream_status: meta?.upstream_status ?? null,
    browser_http_status: meta?.http_status ?? null, upstream_dispatched: meta?.upstream_dispatched ?? null,
    provider_model: meta?.provider_model ?? null, provider_response_id: meta?.provider_response_id ?? null,
    usage: result.usage ?? null, action_id: result.action_id ?? null, legal_action: legal,
    ...(result.action_ids && {action_ids: result.action_ids}),
    decision_answer: meta?.decision_answer ?? null,
    ...(meta?.decision_answers && {decision_answers: meta.decision_answers}),
    error: failure ?? (legal ? null : {code: 'invalid_action', message: '动作不在候选集合内'}),
  };
}

export async function sampleResponses({prepared, endpoints, report, signal, onUpdate = () => {}}) {
  const {observation, candidates, image} = prepared;
  const sequence = prepared.setup.config.action_profile === RESEARCH_SEQUENCE_PROFILE;
  const conditions = endpoints.flatMap(({model, endpoint}) => ['none-v1', STRUCTURED].map(profile => ({
    model, profile, group: {model: model.config.model, endpoint, visual_profile: profile,
      generation_profile: model.config.generation_profile, generation_parameters: model.config.generation_parameters, attempts: []},
  })));
  report.groups = conditions.map(({group}) => group);
  for (let repetition = 1; repetition <= SAMPLES_PER_CONDITION; repetition++) {
    for (const {model, profile, group} of conditions) {
      if (signal.aborted) return;
      const context = {observation, candidates, ...(sequence && {action_profile: RESEARCH_SEQUENCE_PROFILE}),
        ...(profile === STRUCTURED && {image})};
      const attempt = await measure(model, context, signal);
      group.attempts.push({number: repetition, probe: repetition === 1, ...attempt,
        ...(Number.isFinite(report.link_latency_estimate_ms) && {
          adjusted_total_ms: Math.max(0, attempt.total_ms - report.link_latency_estimate_ms),
        }),
      });
      group.summary = summarizeResponseSamples(group.attempts);
      onUpdate();
      if (attempt.error) {
        report.stopped_on = {model: group.model, endpoint: group.endpoint, visual_profile: profile,
          attempt: repetition, ...attempt.error};
        return;
      }
    }
  }
}

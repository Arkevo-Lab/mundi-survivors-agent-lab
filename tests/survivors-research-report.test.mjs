import assert from 'node:assert/strict';
import test from 'node:test';
import {crc32, deflateSync} from 'node:zlib';
import {hashJSON} from '../src/client/survivors-research/evidence.js';
import {createArchive, readReplay, resultMetrics, summarizeRuns} from '../src/client/survivors-research/report.js';

const manifest = run_id => ({run_id, config_id: 'same', config: {seed: 11, max_ticks: 7200}, model: {kind: 'mock'}});
const run = (id, result, metrics = {}, evidence_complete = true) => ({
  run_id: id, manifest: manifest(id), initial_state: {tick: 0}, result, metrics, evidence_complete
});

test('counts only fresh matching applied decisions and keeps failed attempts in the time window', () => {
  const attempts = [
    {decision_id: 'a', observation_tick: 0, action_id: 'move:right:hold:200', applied_tick: 4, status: 'applied', request_started_at_ms: 10, request_finished_at_ms: 50},
    {decision_id: 'b', observation_tick: 0, applied_tick: 8, status: 'applied'},
    {decision_id: 'c', observation_tick: 5, applied_tick: 9, status: 'applied'},
    {decision_id: 'd', observation_tick: 11, status: 'model_error', error: {code: 'timeout'}, request_started_at_ms: 75, request_finished_at_ms: 175}
  ].map(attempt => ({type: 'model:attempt', ...attempt}));
  const metrics = resultMetrics({elapsed_ms: 600, measurement_elapsed_ms: 500}, attempts, [
    {decision_id: 'a', observation_tick: 0, applied_tick: 4, action_id: 'move:right:hold:200', observation_age_ms: 61},
    {decision_id: 'b', applied_tick: 8, action_id: 'move:right:hold:200'},
    {decision_id: 'c', applied_tick: 10, action_id: 'stop'}
  ]);
  assert.equal(metrics.decisions, 1);
  assert.equal(metrics.raw_decision_hz, 2);
  assert.equal(metrics.authoritative_actions, 3);
  assert.equal(metrics.movements, 1);
  assert.equal(metrics.errors.timeout, 1);
  assert.deepEqual(metrics.request_ms, {n: 2, p50: 40, p95: 100, max: 100});
  assert.equal(metrics.effective_decision_hz, null);
});

test('weights all valid elapsed windows including early deaths and keeps exclusions visible', () => {
  const timed = (reason, elapsed_ms) => ({reason, elapsed_ms, environment_valid: true});
  const summary = summarizeRuns([
    run('finished', timed('time-limit', 120000), {decisions: 120, raw_decision_hz: 1}),
    run('death', timed('death', 10000), {decisions: 30, raw_decision_hz: 3}),
    run('stopped', timed('stopped', 300), {decisions: 10}),
    run('evidence-error', timed('evidence-error', 300), {decisions: 10}, false)
  ]);
  assert.equal(summary.rows.length, 4);
  assert.equal(summary.groups[0].valid_runs, 2);
  assert.equal(summary.groups[0].invalid_runs, 2);
  assert.equal(summary.groups[0].raw_decision_hz, 1.154);
  assert.equal(summary.quality_gate_status, 'uncalibrated');
});

test('capped timing exports raw, effective and compensated amounts without relabelling historical runs',()=>{
  const result={reason:'time-limit',elapsed_ms:500,environment_valid:true,provider_clock:{provider_processing_cap_ms:300}};
  const events=[{type:'provider_clock:reported',role:'micro',provider_processing_ms:640,
    effective_provider_processing_ms:300,provider_model_compensated_ms:340}];
  const metrics=resultMetrics(result,events,[]);
  assert.equal(metrics.provider_reported_ms_by_role.micro.p50,640);
  assert.equal(metrics.effective_provider_processing_ms_by_role.micro.p50,300);
  assert.equal(metrics.provider_model_compensated_ms_by_role.micro.p50,340);
  const oldResult={...result,provider_clock:{virtual_ms:640}};
  assert.ok(!Object.hasOwn(resultMetrics(oldResult,events,[]),'effective_provider_processing_ms_by_role'));
  const current=run('current',result,{decisions:1});
  const old=run('old',oldResult,{decisions:1});
  old.manifest.link_compensation={mode:'provider-processing-only-v1'};
  current.manifest.link_compensation={...old.manifest.link_compensation,provider_processing_cap_ms:300};
  const {groups}=summarizeRuns([old,current]);
  assert.deepEqual(groups.map(group=>group.provider_processing_cap_ms),[undefined,300]);
});

test('archive links exact payloads and movement termination to replay frames', async () => {
  const item = run('one', {reason: 'time-limit', state_hash: 'proof', tick: 60});
  item.actions = [{decision_id: 'decision', applied_tick: 4, action_id: 'move:right:hold:200'}];
  const input = {observation: {tick: 2}, candidates: [{id: item.actions[0].action_id}]};
  const raw_response = '{"action_id":"move:right:hold:200"}';
  const archive = await createArchive([{run: item, events: [
    {type: 'model:attempt', decision_id: 'decision', input, raw_response},
    {type: 'movement_ended', started_tick: 4, tick: 15, reason: 'hold-expired'}
  ]}]);
  const record = JSON.parse(archive.files['events.jsonl'].split('\n')[0]);
  assert.deepEqual(archive.files[record.input_file], input);
  assert.equal(archive.files[record.output_file], raw_response);
  assert.equal(record.input_sha256, await hashJSON(input));
  assert.equal(record.output_sha256, await hashJSON(raw_response));
  const [replay] = await readReplay(archive);
  assert.equal(replay.actions[0].applied_tick, 4);
  assert.equal(replay.actions[0].movement_end.reason, 'hold-expired');
  delete archive.files[record.output_file];
  await assert.rejects(readReplay(archive), /模型输入或输出哈希/);
});

test('decision timing aggregates per-round costs and separates cache reuse and wall-clock waits', () => {
  const epoch = 1000;
  const attempt = ({snapshot, json, image = false, render = null, encode = null}) => ({
    type: 'model:attempt',
    decision_timing: {
      schema: 'survivors-decision-timing-v1',
      observation: {requested_at_ms: epoch, returned_at_ms: epoch + 20, pre_request_wait_ms: 200, worker: {
        request_received_at_ms: epoch + 1, sample_started_at_ms: epoch + 12,
        snapshot_cache_hit: snapshot === null, observation_cache_hit: false, visual_cache_hit: image ? false : null,
        snapshot_started_at_ms: snapshot === null ? null : epoch + 12,
        snapshot_finished_at_ms: snapshot === null ? null : epoch + 12 + snapshot,
        observation_project_started_at_ms: epoch + 12, observation_project_finished_at_ms: epoch + 12 + json,
        visual_project_started_at_ms: image ? epoch + 16 : null, visual_project_finished_at_ms: image ? epoch + 17 : null,
        response_post_started_at_ms: epoch + 19, waited_for_new_tick: true
      }},
      visual: {status: image ? 'completed' : 'not_applicable', render_ms: render, encode_ms: encode,
        prepare_elapsed_ms: image ? 50 : null, prepare_finished_at_ms: image ? epoch + 70 : null},
      model: {total_ms: 202, transport_ms: 201, provider_round_trip_ms: 190},
      action: {worker_received_at_ms: epoch + 280, applied_at_ms: epoch + 300}
    }
  });
  const metrics = resultMetrics({}, [
    attempt({snapshot: 5, json: 0}),
    attempt({snapshot: null, json: 4}),
    attempt({snapshot: 1, json: 2, image: true, render: 3, encode: 4})
  ], []);
  const stages = metrics.stage_timings;
  assert.deepEqual(stages.data_generation_ms, {n: 3, p50: 5, p95: 11, max: 11});
  assert.deepEqual(stages.request_to_input_ready_ms, {n: 3, p50: 20, p95: 70, max: 70});
  assert.equal(stages.snapshot_ms.n, 2);
  assert.equal(stages.actual_trail_capture_ms.n, 0);
  assert.equal(stages.encode_ms.n, 1);
  assert.equal(stages.pacing_ms.p50, 200);
  assert.equal(stages.worker_wait_ms.p50, 11);
  assert.equal(stages.model_transport_ms.p50, 201);
  assert.equal(stages.provider_round_trip_ms.p50, 190);
  assert.equal(stages.provider_inference_ms.p50, null);
  assert.deepEqual(metrics.stage_counts.snapshot_cache, {n: 3, count: 1});
  assert.deepEqual(metrics.stage_counts.visual_cache, {n: 1, count: 0});
});

test('counts actual-trail capture once when sampling and excludes delayed visual cache time', () => {
  const attempt = worker => ({
    type:'model:attempt',
    visual:{profile:'structured-trail-v1'},
    decision_timing:{schema:'survivors-decision-timing-v1',
      observation:{worker},visual:{status:'completed',render_ms:1,encode_ms:2}},
  });
  const first = attempt({snapshot_cache_hit:false,observation_cache_hit:false,visual_cache_hit:false,
    snapshot_started_at_ms:1,snapshot_finished_at_ms:2,observation_project_started_at_ms:2,observation_project_finished_at_ms:4,
    actual_trail_capture_started_at_ms:4,actual_trail_capture_finished_at_ms:9,
    visual_project_started_at_ms:200,visual_project_finished_at_ms:203});
  const lazy = attempt({snapshot_cache_hit:true,observation_cache_hit:true,visual_cache_hit:false,
    actual_trail_capture_started_at_ms:null,actual_trail_capture_finished_at_ms:null,
    visual_project_started_at_ms:400,visual_project_finished_at_ms:403});
  const stages = resultMetrics({},[first,lazy],[]).stage_timings;
  assert.deepEqual(stages.actual_trail_capture_ms,{n:1,p50:5,p95:5,max:5});
  assert.deepEqual(stages.data_generation_ms,{n:2,p50:6,p95:14,max:14});
  for (const invalidEnd of [undefined,3]) {
    const worker = {...first.decision_timing.observation.worker,actual_trail_capture_finished_at_ms:invalidEnd};
    if (invalidEnd === undefined) delete worker.actual_trail_capture_finished_at_ms;
    const invalid = resultMetrics({},[attempt(worker)],[]).stage_timings;
    assert.equal(invalid.actual_trail_capture_ms.n,0);
    assert.equal(invalid.data_generation_ms.n,0);
  }
});

test('advice and strategy archive payloads independently from action, usage and pause accounting', async () => {
  const item = run('advisor', {reason: 'time-limit', state_hash: 'proof', tick: 80, latency_compensated_ms: 3});
  item.manifest.visual = {profile: 'structured-v1'};
  item.manifest.advisor = {condition: 'advisor-on'};
  item.manifest.strategy = {model: 'gpt-5.4-mini', refresh_ticks: 600};
  const chunk = (name, data) => {
    const body = Buffer.concat([Buffer.from(name), data]);
    const bytes = Buffer.alloc(body.length + 8);
    bytes.writeUInt32BE(data.length);
    body.copy(bytes, 4);
    bytes.writeUInt32BE(crc32(body), bytes.length - 4);
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(480);
  header.writeUInt32BE(270, 4);
  header[8] = 8;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(481 * 270))), chunk('IEND', Buffer.alloc(0))]);
  const image = {profile: 'structured-v1', tick: 18, mime_type: 'image/png',
    data_url: 'data:image/png;base64,' + png.toString('base64')};
  const visual = {profile: image.profile, tick: image.tick, mime_type: image.mime_type, width: 480, height: 270,
    byte_length: png.length};
  const input = {input: [{role: 'user', content: [{type: 'input_text', text: 'fixture'},
    {type: 'input_image', image_url: 'mundi-research-image:v1'}]}], questions: [{name: 'guidance'}]};
  const attempt = {type: 'advisor:attempt', status: 'published', decision_id: 'same', observation_tick: 18,
    request_started_at_ms: 100, request_finished_at_ms: 160, input, image, visual, raw_response: '{"answers":[]}',
    request_latency: {raw_request_ms: 60, estimated_adjusted_request_ms: 50}, usage: {input_tokens: 30, output_tokens: 1}};
  const events = [
    {type: 'model:attempt', status: 'cancelled', decision_id: 'same', observation_tick: 17, image: {...image, tick: 17},
      visual: {...visual, tick: 17}, request_started_at_ms: 90, request_finished_at_ms: 120,
      usage: {input_tokens: 20}, compensation_receipt: {paused_ms: 3}},
    attempt,
    {type: 'advisor:published', decision_id: 'same', observation_tick: 18, accepted_tick: 21},
    {type: 'advisor:used', decision_id: 'next', guidance_id: 'same'},
    {type: 'strategy:requested', decision_id: 'same'},
    {...attempt, type: 'strategy:attempt', status: 'accepted', usage: {input_tokens: 40, output_tokens: 8}},
    {type: 'strategy:published', decision_id: 'same', source_tick: 18, accepted_tick: 23},
    {type: 'strategy:used', strategy_id: 'same'},
    {type: 'strategy:restored', strategy_id: 'prior'},
  ];
  item.actions = [];
  item.metrics = resultMetrics(item.result, events, item.actions, item.manifest.advisor, item.manifest.strategy);
  assert.equal(item.metrics.decisions, 0);
  assert.equal(item.metrics.attempt_count, 1);
  assert.equal(item.metrics.usage.prompt_tokens, 20);
  assert.equal(item.metrics.actual_request_pause_ms.p50, 3);
  assert.equal(item.metrics.advisor.usage.prompt_tokens, 30);
  assert.equal(item.metrics.advisor.raw_request_ms.p50, 60);
  assert.equal(item.metrics.advisor.estimated_link_adjusted_request_ms.p50, 50);
  assert.equal(item.metrics.advisor.published_age_ticks.p50, 3);
  assert.equal(item.metrics.advisor.requests_overlapping_micro, 1);
  assert.equal(item.metrics.advisor.micro_requests_given_advice, 1);
  assert.equal(item.metrics.strategy.requests, 1);
  assert.equal(item.metrics.strategy.attempts, 1);
  assert.equal(item.metrics.strategy.statuses.accepted, 1);
  assert.equal(item.metrics.strategy.published, 1);
  assert.equal(item.metrics.strategy.advisor_requests_given_strategy, 1);
  assert.equal(item.metrics.strategy.raw_request_ms.p50, 60);
  assert.equal(item.metrics.strategy.published_age_ticks.p50, 5);
  assert.deepEqual(item.metrics.strategy.usage, {prompt_tokens: 40, completion_tokens: 8});

  const archive = await createArchive([{run: item, events}]);
  assert.deepEqual(archive.files['advisor/inputs/same.json'], input);
  assert.deepEqual(archive.files['advisor/images/same.json'], image);
  assert.equal(archive.files['advisor/outputs/same.json'], attempt.raw_response);
  assert.equal(archive.files['images/same.json'].tick, 17);
  assert.deepEqual(archive.files['strategy/inputs/same.json'], input);
  assert.deepEqual(archive.files['strategy/images/same.json'], image);
  assert.equal(archive.files['strategy/outputs/same.json'], attempt.raw_response);
  assert.match(archive.files['report.md'], /## 战略层/);
  const [replay] = await readReplay(archive);
  assert.deepEqual(replay.actions, []);
  assert.equal(replay.metrics.advisor.published, 1);
  assert.equal(replay.metrics.strategy.published, 1);
  archive.files['strategy/outputs/same.json'] = 'modified';
  await assert.rejects(readReplay(archive), /输入或输出哈希不一致/);
  archive.files['strategy/outputs/same.json'] = attempt.raw_response;
  archive.files['advisor/images/same.json'] = {...image, tick: 17};
  await assert.rejects(readReplay(archive), /图像输入哈希不一致/);
});


test('shared upper-layer captures count once while recipient bytes and token usage remain distinct', () => {
  const event = (type, capture_id, bytes, tokens) => ({type, status: 'accepted', image: {},
    visual: {capture_id, byte_length: bytes, prepare_elapsed_ms: 5, render_ms: 2, encode_ms: 1},
    usage: {prompt_tokens: tokens}});
  const {visual_roles: roles} = resultMetrics({}, [
    event('strategy:attempt', 'full-80', 5800, 430), event('advisor:attempt', 'full-80', 5800, 350),
    event('model:attempt', 'local-80', 1300, 210)
  ], [], {}, {}, {micro: 'local-micro-v1'});
  assert.equal(roles.unique_captures.count, 2);
  assert.equal(roles.unique_captures.render_ms.n, 2);
  assert.equal(roles.strategy.image_total_bytes + roles.direction.image_total_bytes + roles.micro.image_total_bytes, 12900);
  assert.equal(roles.strategy.usage.prompt_tokens + roles.direction.usage.prompt_tokens + roles.micro.usage.prompt_tokens, 990);
  assert.equal(roles.micro.encode_ms.p50, 1);
});


test('image preparation includes full frames produced without a recipient', () => {
  const prepare = (profile, tick) => ({type: 'visual:prepared', profile, tick, capture_id: profile + ':' + tick,
    prepare_elapsed_ms: 4, render_ms: 1, encode_ms: 3});
  const full = prepare('structured-v1', 80);
  const {visual_roles: roles} = resultMetrics({}, [full, prepare('structured-v1', 84), prepare('local-micro-v1', 84),
    {type: 'strategy:attempt', image: {}, visual: {...full, byte_length: 300}},
    {type: 'advisor:attempt', image: {}, visual: {...full, byte_length: 300}},
  ], [], {}, {}, {micro: 'local-micro-v1'});
  assert.equal(roles.unique_captures.count, 3);
  assert.equal(roles.full_captures.count, 2);
  assert.equal(roles.local_captures.count, 1);
  assert.equal(roles.unused_captures, 2);
  assert.equal(roles.strategy.image_total_bytes, 300);
  assert.equal(roles.direction.image_total_bytes, 300);
});

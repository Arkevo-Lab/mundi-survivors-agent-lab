import {TRAJECTORY_PROFILE} from './models/visual-input.js';
import {DECISION_TIMING_SCHEMA, elapsed as span, measured as finite} from './models/decision-timing.js';
const workerSpan = (worker, name) => span(worker?.[name + '_started_at_ms'], worker?.[name + '_finished_at_ms']);

export const TIMING_ROWS = [
  {id: 'data_generation_ms', label: '数据生成合计'},
  {id: 'request_to_input_ready_ms', label: '观测请求到输入就绪（墙钟）'},
  {id: 'pacing_ms', label: '节拍等待'},
  {id: 'worker_wait_ms', label: 'Worker 等待或排队'},
  {id: 'page_to_worker_ms', label: '页面到 Worker 边界'},
  {id: 'worker_to_page_ms', label: 'Worker 到页面边界'},
  {id: 'observe_round_trip_ms', label: '观测请求往返（总计）'},
  {id: 'snapshot_ms', label: '快照复制'},
  {id: 'json_project_ms', label: 'JSON 和候选投影'},
  {id: 'actual_trail_capture_ms', label: '实际轨迹采样'},
  {id: 'visual_project_ms', label: '视觉投影'},
  {id: 'render_ms', label: '浏览器绘图'},
  {id: 'encode_ms', label: '图像编码和读取'},
  {id: 'validation_ms', label: '图像校验'},
  {id: 'visual_prepare_ms', label: '图像准备（总计）'},
  {id: 'model_total_ms', label: '模型调用（总计）'},
  {id: 'model_input_prepare_ms', label: '模型请求构建'},
  {id: 'model_input_serialize_ms', label: '模型请求序列化'},
  {id: 'model_transport_ms', label: '适配器传输或本地等待'},
  {id: 'model_response_decode_ms', label: '模型响应解码'},
  {id: 'model_output_parse_ms', label: '动作输出解析'},
  {id: 'provider_round_trip_ms', label: '供应商往返（包含在传输内）'},
  {id: 'provider_inference_ms', label: '供应商内部推理'},
  {id: 'action_page_to_worker_ms', label: '动作发送到 Worker 接收'},
  {id: 'action_ack_ms', label: '动作确认往返（总计）'},
  {id: 'action_boundary_ms', label: 'Worker 接收到应用'},
  {id: 'sample_to_applied_ms', label: '采样到应用（真实经过）'},
  {id: 'sample_to_applied_virtual_ms', label: '采样到应用（模拟时间）'}
];

function timingSample(event) {
  const data = event.decision_timing;
  if (data?.schema !== DECISION_TIMING_SCHEMA) return null;
  const {observation: obs, visual, model, action} = data;
  const virtual = event.timing_clock === 'provider-processing';
  const worker = obs?.worker;
  const snapshot = workerSpan(worker, 'snapshot');
  const json = workerSpan(worker, 'observation_project');
  const shouldCountTrail = worker?.observation_cache_hit !== true && worker &&
    (Object.hasOwn(worker, 'actual_trail_capture_started_at_ms') || Object.hasOwn(worker, 'actual_trail_capture_finished_at_ms'));
  const capturedTrail = shouldCountTrail ? workerSpan(worker, 'actual_trail_capture') : null;
  const projectedVisual = workerSpan(worker, 'visual_project');
  const render = finite(visual?.render_ms);
  const encode = finite(visual?.encode_ms);
  const usesImage = visual?.status !== 'not_applicable';
  const generated = [worker?.snapshot_cache_hit === true ? 0 : snapshot,
    worker?.observation_cache_hit === true ? 0 : json,
    shouldCountTrail ? capturedTrail : 0,
    usesImage && event.visual?.profile !== TRAJECTORY_PROFILE
      ? worker?.visual_cache_hit === true ? 0 : projectedVisual : 0,
    usesImage ? render : 0, usesImage ? encode : 0];
  const ready = usesImage ? visual?.status === 'completed' ? visual.prepare_finished_at_ms : null : obs?.returned_at_ms;
  return {
    data_generation_ms: !virtual && generated.every(Number.isFinite) ? generated.reduce((sum, ms) => sum + ms, 0) : null,
    request_to_input_ready_ms: span(obs?.requested_at_ms, ready),
    pacing_ms: finite(obs?.pre_request_wait_ms),
    worker_wait_ms: virtual ? null : span(worker?.request_received_at_ms, worker?.sample_started_at_ms),
    page_to_worker_ms: virtual ? null : span(obs?.requested_at_ms, worker?.request_received_at_ms),
    worker_to_page_ms: virtual ? null : span(worker?.response_post_started_at_ms, obs?.returned_at_ms),
    observe_round_trip_ms: finite(obs?.round_trip_ms),
    snapshot_ms: virtual ? null : snapshot,
    json_project_ms: virtual ? null : json,
    actual_trail_capture_ms: virtual ? null : capturedTrail,
    visual_project_ms: virtual ? null : projectedVisual,
    render_ms: render,
    encode_ms: encode,
    validation_ms: finite(visual?.validation_ms),
    visual_prepare_ms: finite(visual?.prepare_elapsed_ms),
    model_total_ms: finite(model?.total_ms),
    model_input_prepare_ms: finite(model?.input_prepare_ms),
    model_input_serialize_ms: finite(model?.input_serialize_ms),
    model_transport_ms: finite(model?.transport_ms),
    model_response_decode_ms: finite(model?.response_decode_ms),
    model_output_parse_ms: finite(model?.output_parse_ms),
    provider_round_trip_ms: finite(model?.provider_round_trip_ms),
    provider_inference_ms: finite(model?.provider_inference_ms),
    action_page_to_worker_ms: finite(action?.page_to_worker_ms),
    action_ack_ms: finite(action?.round_trip_ms),
    action_boundary_ms: virtual ? null : span(action?.worker_received_at_ms, action?.applied_at_ms),
    sample_to_applied_ms: virtual ? null : span(event.sampled_at_ms, action?.applied_at_ms),
    sample_to_applied_virtual_ms: virtual ? span(event.sampled_at_ms, action?.applied_at_ms) : null,
    cache: {
      waited_for_new_tick: worker?.waited_for_new_tick,
      snapshot_cache: worker?.snapshot_cache_hit,
      observation_cache: worker?.observation_cache_hit,
      visual_cache: worker?.visual_cache_hit
    }
  };
}

export function summarizeTiming(attempts, distribution) {
  const samples = attempts.map(timingSample).filter(Boolean);
  if (!samples.length) return {};
  const stage_timings = Object.fromEntries(TIMING_ROWS.map(({id}) => [id, distribution(samples.map(sample => sample[id]))]));
  const stage_counts = {};
  for (const key of Object.keys(samples[0].cache)) {
    const values = samples.map(sample => sample.cache[key]).filter(value => typeof value === 'boolean');
    stage_counts[key] = {n: values.length, count: values.filter(Boolean).length};
  }
  return {decision_timing_schema: DECISION_TIMING_SCHEMA, stage_timings_unit: 'ms', stage_timings, stage_counts};
}

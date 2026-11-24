import {researchPlanValidator} from '../../shared/survivors-research-contract.js';
import {hashJSON} from './evidence.js';
import {verifyResumeNode} from './resume-node.js';
import {summarizeTiming} from './timing-report.js';
import {DREX_CAPPED_TIMING_PROVIDER_INPUT_PROFILE,DREX_TIMING_PROVIDER_INPUT_PROFILE,validMicroTimingContext} from './models/local-path-micro.js';
import {isLocalMicroProjectionSchema} from './models/local-micro.js';
import {validateVisualImage, VISUAL_IMAGE_REFERENCE, EVIDENCE_VISUAL_PROFILES, LOCAL_MICRO_PROFILE, STRUCTURED_TRAIL_PROFILE} from './models/visual-input.js';

export const ARCHIVE_SCHEMA = 'mundi-survivors-research-archive-v1';
export const GATE = Object.freeze({
  version: 'pilot-candidate-v1', status: 'uncalibrated',
  required_survival_seconds: 120, required_successes: 4, required_runs: 5,
  minimum_level: null, minimum_kills: null
});
const round = value => Math.round(value * 1000) / 1000;

function distribution(samples) {
  const sorted = samples.filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!sorted.length) return {n: 0, p50: null, p95: null, max: null};
  const at = fraction => round(sorted[Math.ceil(sorted.length * fraction) - 1]);
  return {n: sorted.length, p50: at(.5), p95: at(.95), max: at(1)};
}

function sameSequence(left, right) {
  if (left === undefined && right === undefined) return true;
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    left.every((id, index) => id === right[index]);
}

function totalUsage(attempts) {
  const usage = attempts.reduce((totals, {usage}) => {
    for (const [key, value] of Object.entries({
      prompt_tokens: usage?.prompt_tokens ?? usage?.input_tokens,
      completion_tokens: usage?.completion_tokens ?? usage?.output_tokens,
      total_tokens: usage?.total_tokens
    })) {
      if (Number.isFinite(value)) totals[key] = (totals[key] ?? 0) + value;
    }
    return totals;
  }, {});
  return Object.keys(usage).length ? usage : null;
}

function layerVisualMetrics(attempts) {
  const images = attempts.filter(event => event.image && event.visual).map(event => event.visual);
  return {
    input_images: images.length,
    image_bytes: distribution(images.map(image => image.byte_length)),
    image_total_bytes: images.reduce((total, image) => total + (image.byte_length ?? 0), 0),
    prepare_ms: distribution(images.map(image => image.prepare_elapsed_ms)),
    render_ms: distribution(images.map(image => image.render_ms)),
    encode_ms: distribution(images.map(image => image.encode_ms)),
    usage: totalUsage(attempts),
  };
}

function advisorMetrics(events) {
  const attempts = events.filter(event => event.type === 'advisor:attempt');
  const published = events.filter(event => event.type === 'advisor:published');
  const used = events.filter(event => event.type === 'advisor:used');
  const micro = events.filter(event => event.type === 'model:attempt' && Number.isFinite(event.request_started_at_ms) &&
    Number.isFinite(event.request_finished_at_ms));
  const overlapping = attempts.filter(attempt => micro.some(event =>
    attempt.request_started_at_ms < event.request_finished_at_ms && attempt.request_finished_at_ms > event.request_started_at_ms));
  const statuses = Object.create(null);
  for (const {status} of attempts) statuses[status] = (statuses[status] ?? 0) + 1;
  return {
    attempts: attempts.length,
    statuses,
    published: published.length,
    requests_overlapping_micro: overlapping.length,
    micro_requests_given_advice: used.length,
    raw_request_ms: distribution(attempts.map(event => event.request_latency?.raw_request_ms)),
    estimated_link_adjusted_request_ms: distribution(attempts.map(event => event.request_latency?.estimated_adjusted_request_ms)),
    published_age_ticks: distribution(published.map(event => event.accepted_tick - event.observation_tick)),
    usage: totalUsage(attempts),
  };
}

function visualRoleMetrics(events) {
  const strategy = events.filter(event => event.type === 'strategy:attempt');
  const direction = events.filter(event => event.type === 'advisor:attempt');
  const micro = events.filter(event => event.type === 'model:attempt');
  const sharedCaptures = new Map();
  for (const event of [...strategy, ...direction, ...micro]) {
    if (event.image && event.visual?.capture_id && !sharedCaptures.has(event.visual.capture_id)) {
      sharedCaptures.set(event.visual.capture_id, event);
    }
  }
  const prepared = [...new Map(events.filter(event => event.type === 'visual:prepared').map(event => [event.capture_id, event])).values()];
  const captures = prepared.length ? prepared : [...sharedCaptures.values()].map(event => event.visual);
  const summarizeCaptures = rows => ({count: rows.length,
    prepare_ms: distribution(rows.map(row => row.prepare_elapsed_ms)),
    render_ms: distribution(rows.map(row => row.render_ms)), encode_ms: distribution(rows.map(row => row.encode_ms))});
  return {strategy: layerVisualMetrics(strategy), direction: layerVisualMetrics(direction), micro: layerVisualMetrics(micro),
    unique_captures: summarizeCaptures(captures),
    ...(prepared.length && {full_captures: summarizeCaptures(prepared.filter(row => row.profile === 'structured-v1')),
      local_captures: summarizeCaptures(prepared.filter(row => row.profile === LOCAL_MICRO_PROFILE)),
      unused_captures: prepared.filter(row => !sharedCaptures.has(row.capture_id)).length})};
}

function strategyMetrics(events) {
  const attempts = events.filter(event => event.type === 'strategy:attempt');
  const published = events.filter(event => event.type === 'strategy:published');
  const statuses = Object.create(null);
  for (const {status} of attempts) statuses[status] = (statuses[status] ?? 0) + 1;
  return {
    requests: events.filter(event => event.type === 'strategy:requested').length,
    attempts: attempts.length,
    statuses,
    published: published.length,
    advisor_requests_given_strategy: events.filter(event => event.type === 'strategy:used').length,
    raw_request_ms: distribution(attempts.map(event => event.request_latency?.raw_request_ms ??
      (event.request_started_at_ms == null || event.request_finished_at_ms == null ? null :
        event.request_finished_at_ms - event.request_started_at_ms))),
    published_age_ticks: distribution(published.map(event => event.accepted_tick - event.source_tick)),
    usage: totalUsage(attempts),
  };
}

export function resultMetrics(result, events, actions, advisor, strategy, roleProfiles) {
  const attempts = events.filter(event => event.type === 'model:attempt');
  const images = attempts.flatMap(attempt => attempt.image && attempt.visual ? [attempt.visual] : []);
  const captureErrors = attempts.filter(attempt => attempt.status === 'visual_error');
  const accepted = attempts.filter(attempt => attempt.status === 'applied');
  const providerTiming = Boolean(result?.provider_clock);
  const deferred = providerTiming ? attempts.filter(attempt => attempt.status === 'deferred') : [];
  const acks = new Map([...accepted,...deferred].map(attempt => [attempt.decision_id, attempt]));
  const fields = ['decision_id', 'observation_id', 'observation_tick', 'action_id', 'applied_tick', 'applied_at_ms'];
  const matched = new Set();
  let lastObservationTick = -1;
  let lastAppliedTick = 0;
  const qualified = actions.filter(action => {
    const attempt = acks.get(action.decision_id);
    if (!attempt || matched.has(action.decision_id) || !Number.isInteger(action.observation_tick) ||
        !Number.isInteger(action.applied_tick) || (providerTiming ? action.observation_tick < lastObservationTick : action.observation_tick <= lastObservationTick) ||
        action.applied_tick <= Math.max(lastAppliedTick, action.observation_tick) ||
        fields.some(field => (attempt.status !== 'deferred' || !['applied_tick','applied_at_ms'].includes(field)) &&
          attempt[field] !== action[field]) ||
        !sameSequence(attempt.action_ids, action.action_ids) ||
        (attempt.status !== 'deferred' && action.action_ids !== undefined && !sameSequence(attempt.ack?.action_ids, action.action_ids))) return false;
    lastObservationTick = action.observation_tick;
    lastAppliedTick = action.applied_tick;
    matched.add(action.decision_id);
    return true;
  });
  const applicationTimes = qualified.map(action => action.applied_at_ms ?? acks.get(action.decision_id).applied_at_ms);
  const errors = Object.create(null);
  for (const attempt of attempts) {
    if (attempt.status === 'applied' || attempt.status === 'deferred') continue;
    const code = attempt.error?.code ?? attempt.status;
    errors[code] = (errors[code] ?? 0) + 1;
  }
  const elapsed = result?.wall_elapsed_ms ?? result?.measurement_elapsed_ms ?? result?.elapsed_ms;
  const paused = result?.latency_compensated_ms ?? 0;
  const gameElapsed = result?.effective_measurement_elapsed_ms ?? (elapsed == null ? null : Math.max(0, elapsed - paused));
  const rawRequestMs = attempts.map(attempt => attempt.request_latency?.raw_request_ms ?? (
    attempt.request_started_at_ms == null || attempt.request_finished_at_ms == null
      ? null : attempt.request_finished_at_ms - attempt.request_started_at_ms));
  const rawAge = action => action.observation_age_ms ?? acks.get(action.decision_id).ack?.observation_age_ms;
  const providerTimingByRole = field => Object.fromEntries(['micro','advisor','strategy','upgrade'].map(role => [
    role, distribution(events.filter(event => event.type === 'provider_clock:reported' && event.role === role)
      .map(event => event[field])),
  ]));
  const cappedProviderTiming = Number.isFinite(result?.provider_clock?.provider_processing_cap_ms);
  return {
    ...summarizeTiming(attempts, distribution),
    ...(providerTiming && {provider_reported_ms_by_role:providerTimingByRole('provider_processing_ms')}),
    ...(cappedProviderTiming && {
      effective_provider_processing_ms_by_role:providerTimingByRole('effective_provider_processing_ms'),
      provider_model_compensated_ms_by_role:providerTimingByRole('provider_model_compensated_ms'),
    }),
    decisions: qualified.length,
    authoritative_actions: actions.length,
    unmatched_authoritative_actions: actions.length - qualified.length,
    unmatched_applied_attempts: accepted.filter(attempt => !matched.has(attempt.decision_id)).length,
    attempt_count: attempts.length,
    observe_failures: events.filter(event => event.type === 'model:observe_failed' && event.status !== 'cancelled').length,
    raw_decision_hz: elapsed > 0 ? round(qualified.length * 1000 / elapsed) : null,
    game_clock_decision_hz: gameElapsed > 0 ? round(qualified.length * 1000 / gameElapsed) : null,
    effective_measurement_elapsed_ms: gameElapsed,
    request_ms: distribution(rawRequestMs),
    estimated_adjusted_request_ms: distribution(attempts.map((attempt, index) =>
      attempt.request_latency?.estimated_adjusted_request_ms ?? rawRequestMs[index])),
    actual_request_pause_ms: distribution(attempts.map(attempt => attempt.compensation_receipt?.paused_ms)),
    visual_frames: images.length,
    visual_capture_errors: captureErrors.length,
    visual_image_bytes: distribution(images.map(image => image.byte_length)),
    visual_mime_counts: images.reduce((counts, image) => ({...counts, [image.mime_type]: (counts[image.mime_type] ?? 0) + 1}), {}),
    visual_total_bytes: images.reduce((total, image) => total + image.byte_length, 0),
    visual_render_ms: distribution(images.map(image => image.render_ms)),
    visual_encode_ms: distribution(images.map(image => image.encode_ms)),
    visual_prepare_ms: distribution(images.map(image => image.prepare_elapsed_ms)),
    observation_age_ms: distribution(qualified.map(rawAge)),
    adjusted_observation_age_ms: distribution(qualified.map(action => action.adjusted_observation_age_ms ??
      acks.get(action.decision_id).ack?.adjusted_observation_age_ms ?? rawAge(action))),
    decision_interval_ms: distribution(applicationTimes.slice(1).map((time, index) => time - applicationTimes[index])),
    truncated_plans: events.filter(event => event.type === 'movement_plan_truncated').length,
    interrupted_plans: events.filter(event => event.type === 'movement_plan_ended' &&
      ['replaced', 'stopped'].includes(event.reason)).length,
    planned_movement_segments: qualified.reduce((count, action) => count +
      (action.action_ids ?? [action.action_id]).filter(id => id?.startsWith('move:')).length, 0),
    movements: qualified.filter(a => a.action_id?.startsWith('move:')).length,
    upgrades: qualified.filter(a => a.action_id?.startsWith('choose:')).length,
    errors,
    usage: totalUsage(attempts),
    ...(advisor && {advisor: advisorMetrics(events)}),
    ...(strategy && {strategy: strategyMetrics(events)}),
    ...(roleProfiles && {visual_roles: visualRoleMetrics(events)}),
    cost: null,
    effective_decision_hz: null,
    quality_gate_status: GATE.status
  };
}

export function summarizeRuns(runs) {
  const rows = runs.map(run => ({
    run_id: run.run_id,
    config_id: run.manifest.config_id,
    ...(run.manifest.advisor && {advisory_condition: run.manifest.advisor.condition}),
    ...(run.manifest.strategy && {strategy_config: run.manifest.strategy}),
    model: run.manifest.model.kind,
    model_name: run.manifest.model.model ?? null,
    model_endpoint: run.manifest.model.kind === 'generative' ? 'Chat Completions'
      : run.manifest.model.kind === 'openai-decisions' ? 'Decisions' : null,
    visual_profile: run.manifest.visual?.profile ?? 'none-v1',
    movement_feedback: run.manifest.config.movement_feedback ?? 'none',
    link_compensation: run.manifest.link_compensation ?? null,
    latency_compensation_ms: run.result?.latency_compensation_ms ?? run.manifest.config.latency_compensation_ms ?? 0,
    latency_compensated_ms: run.result?.latency_compensated_ms ?? 0,
    effective_elapsed_ms: run.result?.effective_elapsed_ms ?? run.result?.elapsed_ms ?? null,
    seed: run.manifest.config.seed,
    ...(run.manifest.branch && {branch: run.manifest.branch, segment_ticks: (run.result?.tick ?? run.manifest.branch.base_tick) - run.manifest.branch.base_tick,
      segment_crystals: run.result ? run.result.gems_collected - run.manifest.branch.start_facts.gems_collected : null,
      segment_hits: run.result ? run.result.hits_taken - run.manifest.branch.start_facts.hits_taken : null,
      segment_hp_delta: run.result ? run.result.hp - run.manifest.branch.start_facts.hp : null}),
    window_seconds: (run.manifest.branch ? run.manifest.branch.limit_tick - run.manifest.branch.base_tick : run.manifest.config.max_ticks) / 60,
    reason: run.result?.reason ?? 'interrupted',
    valid: run.result?.environment_valid === true && run.evidence_complete === true,
    comparison_eligible: !run.manifest.branch && run.result?.environment_valid === true && run.evidence_complete === true &&
      ['time-limit', 'death', 'reaper'].includes(run.result?.reason),
    evidence_complete: run.evidence_complete === true,
    evidence_fault: run.evidence_fault ?? null,
    elapsed_ms: run.result?.elapsed_ms ?? null,
    measurement_elapsed_ms: run.result?.measurement_elapsed_ms ?? run.result?.elapsed_ms ?? null,
    wall_elapsed_ms: run.result?.wall_elapsed_ms ?? null,
    provider_clock: run.result?.provider_clock ?? null,
    sim_time_ms: run.result?.sim_time_ms ?? null,
    clock: run.result?.clock ?? null,
    tick: run.result?.tick ?? null,
    level: run.result?.level ?? null,
    hp: run.result?.hp ?? null,
    pressure_profile: run.manifest.config.pressure_profile ?? null,
    action_profile: run.manifest.config.action_profile,
    hits_taken: run.result?.hits_taken ?? null,
    damage_taken: run.result?.damage_taken ?? null,
    xp: run.result?.xp ?? null,
    gems_collected: run.result?.gems_collected ?? null,
    distance: run.result?.distance ?? null,
    ...(run.metrics ?? {})
  }));
  const groups = new Map();
  for (const row of rows.filter(item => !item.branch)) {
    const clock_mode = row.link_compensation?.adaptive ? 'adaptive-link-compensation' : row.link_compensation?.mode ?? 'wall-clock';
    const key = JSON.stringify([row.config_id, clock_mode, row.latency_compensation_ms,
      row.link_compensation?.provider_processing_cap_ms]);
    const group = groups.get(key) ?? {config_id: row.config_id, model: row.model, visual_profile: row.visual_profile,
      clock_mode, latency_compensation_ms: row.latency_compensation_ms, valid_runs: 0, invalid_runs: 0, decisions: 0,
      ...(Number.isFinite(row.link_compensation?.provider_processing_cap_ms) && {
        provider_processing_cap_ms:row.link_compensation.provider_processing_cap_ms,
      }),
      elapsed_ms: 0, effective_elapsed_ms: 0, frequencies: []};
    if (row.comparison_eligible && row.measurement_elapsed_ms > 0) {
      group.valid_runs++;
      group.elapsed_ms += row.wall_elapsed_ms ?? row.measurement_elapsed_ms;
      group.effective_elapsed_ms += row.effective_measurement_elapsed_ms ?? row.measurement_elapsed_ms;
      group.decisions += row.decisions ?? 0;
      group.frequencies.push(row.raw_decision_hz);
    } else group.invalid_runs++;
    groups.set(key, group);
  }
  return {
    quality_gate_status: GATE.status,
    effective_decision_hz: null,
    rows,
    groups: Array.from(groups.values(), ({frequencies, ...group}) => ({...group,
      raw_decision_hz: group.elapsed_ms > 0 ? round(group.decisions * 1000 / group.elapsed_ms) : null,
      game_clock_decision_hz: group.effective_elapsed_ms > 0 ? round(group.decisions * 1000 / group.effective_elapsed_ms) : null,
      run_frequency_hz: distribution(frequencies)
    }))
  };
}

const mode = (budget, clockMode, adaptive = false, providerCap = null) => adaptive || clockMode === 'adaptive-link-compensation'
  ? '动态补偿 · 初始 ' + round(budget) + ' ms'
  : clockMode === 'provider-processing-only-v1'
    ? '供应商处理时间' + (Number.isFinite(providerCap) ? ' · 上限 ' + round(providerCap) + ' ms' : '')
  : clockMode === 'estimated-link-compensation' ? '实验模拟 ' + round(budget) + ' ms' : '实时';
const seconds = ms => Number.isFinite(ms) ? round(ms / 1000) : null;
const payloadDirectories = new Map([
  ['model:attempt', ''], ['advisor:attempt', 'advisor/'], ['strategy:attempt', 'strategy/'],
]);
const jsonl = values => values.map(value => JSON.stringify(value)).join('\n') + (values.length ? '\n' : '');

function reportMarkdown(summary) {
  const header = [
    '# Mundi Survivors 实时 Agent 研究',
    '',
    '两种频率分别以真实经过时间和游戏计时为分母。供应商处理时间模式按模型报告推进，标有上限的对局每笔按上限截取。共用时钟上的并发区间不累加。计时差为真实经过时间减计入的模拟时间。',
    '',
    '| 决策来源 | 视觉档 | 时钟 | 种子 | 窗口 | 终局 | 真实经过秒 | 游戏计时秒 | 计时差 ms | 模拟帧 | 等级 | 经验水晶 | 受击次数 | 真实经过 Hz | 游戏计时 Hz | 环境与证据 |',
    '| --- | --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |'
  ];
  for (const row of summary.rows.filter(item => !item.branch)) header.push(
    '| ' + [row.model, row.visual_profile, mode(row.latency_compensation_ms, row.link_compensation?.mode, row.link_compensation?.adaptive, row.link_compensation?.provider_processing_cap_ms), row.seed, row.window_seconds, row.reason,
      seconds(row.wall_elapsed_ms ?? row.measurement_elapsed_ms), seconds(row.effective_measurement_elapsed_ms ?? row.measurement_elapsed_ms),
      round(row.provider_clock?.wall_minus_charged_ms ?? row.latency_compensated_ms), row.tick, row.level,
      row.gems_collected, row.hits_taken, row.raw_decision_hz, row.game_clock_decision_hz,
      row.valid ? '有效' : '无效 / 中断'].map(value => String(value ?? '—').replaceAll('|', '/')).join(' | ') + ' |'
  );
  const branches = summary.rows.filter(row => row.branch);
  if (branches.length) {
    header.push('', '## 短段续测', '', '| 从原局时间 | 模拟秒 | 水晶增量 | 受击增量 | 生命变化 | 结局 |',
      '| ---: | ---: | ---: | ---: | ---: | --- |');
    for (const row of branches) {
      header.push('| ' + [row.branch.base_tick / 60, row.segment_ticks / 60, row.segment_crystals, row.segment_hits,
        row.segment_hp_delta, row.reason].map(value => value ?? '—').join(' | ') + ' |');
    }
  }
  header.push('', '## 配置汇总', '',
    '| 配置 ID | 决策来源 | 视觉档 | 时钟 | 有效局 | 排除局 | 实际决策 | 真实经过秒 | 游戏计时秒 | 真实经过 Hz | 游戏计时 Hz |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const group of summary.groups) header.push(
    '| ' + [group.config_id, group.model, group.visual_profile, mode(group.latency_compensation_ms, group.clock_mode, false, group.provider_processing_cap_ms), group.valid_runs,
      group.invalid_runs, group.decisions, seconds(group.elapsed_ms), seconds(group.effective_elapsed_ms),
      group.raw_decision_hz, group.game_clock_decision_hz].map(value => String(value ?? '—')).join(' | ') + ' |'
  );
  const timed = summary.rows.filter(row => row.stage_timings);
  if (timed.length) {
    header.push('', '## 阶段耗时', '', '每格为 n / p50 / p95 / 最大值，单位 ms。分阶段明细见 report.json。',
      '', '| 视觉档 | 时钟 | 种子 | 数据生成合计 | 观测请求到输入就绪 | 模型调用 | 采样到应用 |',
      '| --- | --- | ---: | --- | --- | --- | --- |');
    for (const row of timed) {
      const values = ['data_generation_ms', 'request_to_input_ready_ms', 'model_total_ms', 'sample_to_applied_ms']
        .map(key => { const d = row.stage_timings[key]; return d.n ? [d.n, d.p50, d.p95, d.max].join(' / ') : '—'; });
      header.push('| ' + [row.visual_profile, mode(row.latency_compensation_ms, row.link_compensation?.mode, row.link_compensation?.adaptive, row.link_compensation?.provider_processing_cap_ms), row.seed, ...values].join(' | ') + ' |');
    }
  }
  const advised = summary.rows.filter(row => row.advisor);
  if (advised.length) {
    const providerRuns = summary.rows.some(row => row.provider_clock);
    header.push('', '## 方向层', '',
      providerRuns ? '供应商处理时间模式下，方向层和战略层按各自报告的处理时间共用游戏时钟。传给微操层一栏统计输入中带有指导的请求。'
        : '方向层耗时独立记录。传给微操层一栏统计输入中带有指导的请求。',
      '', '| 种子 | 条件 | 方向层尝试 | 已发布 | 传给微操层 | 原始 p50 ms | 链路调整估算 p50 ms | 发布时年龄 p50 帧 |',
      '| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const row of advised) {
      const advisor = row.advisor;
      const condition = row.advisory_condition === 'latest-local-micro' ? '局部微操'
        : row.advisory_condition === 'strategy-on' ? '三层对照'
        : row.advisory_condition === 'advisor-on' ? '两层对照' : '微操层对照';
      header.push('| ' + [row.seed, condition, advisor.attempts, advisor.published, advisor.micro_requests_given_advice,
        advisor.raw_request_ms.p50, advisor.estimated_link_adjusted_request_ms.p50, advisor.published_age_ticks.p50]
        .map(value => value ?? '—').join(' | ') + ' |');
    }
  }
  const strategic = summary.rows.filter(row => row.strategy);
  if (strategic.length) {
    header.push('', '## 战略层', '',
      '| 对局 | 请求 | 发布 | 传给方向层 | 状态 | 请求 p50 ms | 输入 token | 输出 token |',
      '| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |');
    for (const row of strategic) {
      const strategy = row.strategy;
      const statuses = Object.entries(strategy.statuses).map(([status, count]) => status + ' ' + count).join('、');
      header.push('| ' + [row.run_id, strategy.requests, strategy.published, strategy.advisor_requests_given_strategy,
        statuses || '—', strategy.raw_request_ms.p50, strategy.usage?.prompt_tokens, strategy.usage?.completion_tokens]
        .map(value => String(value ?? '—').replaceAll('|', '/')).join(' | ') + ' |');
    }
  }
  const visualRoles = summary.rows.filter(row => row.visual_roles);
  if (visualRoles.length) {
    header.push('', '## 三层图像与用量', '', '每层统计实际收到的图像与 token。共享画面只计一次绘制和编码。',
      '', '| 对局 | 层 | 图像数 | 图像总字节 | 准备 p50 ms | 绘制 p50 ms | 编码 p50 ms | 输入 token | 输出 token |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const row of visualRoles) {
      for (const [key, label] of [['strategy', '战略层'], ['direction', '方向层'], ['micro', '微操层']]) {
        const image = row.visual_roles[key];
        header.push('| ' + [row.run_id, label, image.input_images, image.image_total_bytes, image.prepare_ms.p50,
          image.render_ms.p50, image.encode_ms.p50, image.usage?.prompt_tokens, image.usage?.completion_tokens]
          .map(value => value ?? '—').join(' | ') + ' |');
      }
      for (const [key, label] of [['full_captures', '全景图准备'], ['local_captures', '局部图准备'],
        ['unique_captures', row.visual_roles.full_captures ? '图像准备合计' : '归档中的图像准备']]) {
        const captures = row.visual_roles[key];
        if (!captures) continue;
        header.push('| ' + [row.run_id, label, captures.count, '—', captures.prepare_ms.p50,
          captures.render_ms.p50, captures.encode_ms.p50, '—', '—'].map(value => value ?? '—').join(' | ') + ' |');
      }
    }
  }
  header.push('', '在同一 Mundi 研究页选择导入回放，核对初始状态、实际应用帧及终局 hash。环境和存储异常保留在逐局结果中。模型用量见事件记录。');
  return header.join('\n') + '\n';
}

export async function createArchive(entries) {
  const files = {};
  const summary = summarizeRuns(entries.map(entry => entry.run));
  const isBatch = entries.length > 1;
  for (const {run, events, positions} of entries) {
    const prefix = isBatch ? 'runs/' + run.run_id + '/' : '';
    const payloadEvents = [];
    async function storeEvent(event) {
      const directory = payloadDirectories.get(event.type);
      if (directory === undefined) return event;
      const {input, raw_response, image, ...rest} = event;
      const inputPath = input == null ? null : directory + 'inputs/' + event.decision_id + '.json';
      const outputPath = raw_response == null ? null : directory + 'outputs/' + event.decision_id + '.json';
      const imagePath = image == null ? null : directory + 'images/' + event.decision_id + '.json';
      if (imagePath) files[prefix + imagePath] = image;
      if (inputPath) files[prefix + inputPath] = input;
      if (outputPath) files[prefix + outputPath] = raw_response;
      const [inputHash, outputHash, imageHash] = await Promise.all([
        inputPath ? hashJSON(input) : null, outputPath ? hashJSON(raw_response) : null, imagePath ? hashJSON(image) : null
      ]);
      return {...rest, input_file: inputPath, output_file: outputPath, image_file: imagePath,
        input_sha256: inputHash, output_sha256: outputHash, image_sha256: imageHash};
    }
    for (let index = 0; index < events.length; index += 128) {
      payloadEvents.push(...await Promise.all(events.slice(index, index + 128).map(storeEvent)));
    }
    files[prefix + 'initial-state.json'] = run.initial_state;
    if (run.manifest.branch) {
      await verifyResumeNode(run.resume_node);
      if (run.resume_node.integrity !== run.manifest.branch.node_sha256) throw Error('分支节点与清单不一致');
      files[prefix + 'resume-node.json'] = run.resume_node;
    }
    const eventLog = jsonl(payloadEvents);
    files[prefix + 'events.jsonl'] = eventLog;
    const ends = new Map(events.filter(event => event.type === 'movement_ended').map(event => [event.started_tick, event]));
    const planEnds = new Map(events.filter(event => event.type === 'movement_plan_ended').map(event => [event.started_tick, event]));
    const actions = (run.actions ?? events.filter(event => event.type === 'action_applied')).map(action => ({
      ...action, decision_source: run.manifest.model.kind, movement_end: ends.get(action.applied_tick) ?? null,
      ...(action.action_ids && {plan_end: planEnds.get(action.applied_tick) ?? null})
    }));
    const trajectory = positions?.slice(1).map(([x, y], index) => {
      const [startX, startY] = positions[index];
      return {tick: (run.manifest.branch?.base_tick ?? 0) + index + 1, start: [startX, startY], end: [x, y], dx: x - startX, dy: y - startY};
    });
    const movementLog = trajectory ? jsonl(trajectory) : null;
    if (movementLog !== null) files[prefix + 'movement.jsonl'] = movementLog;
    const actionLog = jsonl(actions);
    files[prefix + 'actions.jsonl'] = actionLog;
    const result = {
      ...run.result, metrics: run.metrics ?? null, evidence_complete: run.evidence_complete === true,
      evidence_fault: run.evidence_fault ?? null, quality_gate_status: GATE.status, effective_decision_hz: null
    };
    files[prefix + 'result.json'] = result;
    const [actions_sha256, events_sha256, result_sha256] = await Promise.all([hashJSON(actionLog), hashJSON(eventLog), hashJSON(result)]);
    files[prefix + 'manifest.json'] = {...run.manifest, archive_hashes: {actions_sha256, events_sha256, result_sha256,
      ...(movementLog !== null && {movement_sha256: await hashJSON(movementLog)})}};
  }
  files['report.json'] = summary;
  files['report.md'] = reportMarkdown(summary);
  return {schema: ARCHIVE_SCHEMA, run_ids: entries.map(entry => entry.run.run_id), files};
}

export async function readReplay(archive, {includeEvidence = false} = {}) {
  if (archive?.schema !== ARCHIVE_SCHEMA || !Array.isArray(archive.run_ids) ||
      archive.run_ids.length < 1 || archive.run_ids.length > 32 || !archive.files) {
    throw Error('无法识别研究实验包版本');
  }
  const isBatch = archive.run_ids.length > 1;
  if (new Set(archive.run_ids).size !== archive.run_ids.length) throw Error('实验包包含重复的对局');
  const runs = [];
  for (const id of archive.run_ids) {
    if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id)) throw Error('实验包的对局标识无效');
    const prefix = isBatch ? 'runs/' + id + '/' : '';
    const manifest = archive.files[prefix + 'manifest.json'];
    const initial_state = archive.files[prefix + 'initial-state.json'];
    const result = archive.files[prefix + 'result.json'];
    const actionText = archive.files[prefix + 'actions.jsonl'];
    const eventText = archive.files[prefix + 'events.jsonl'];
    if (manifest?.run_id !== id || !manifest.config || typeof manifest.model?.kind !== 'string' ||
        !initial_state || typeof actionText !== 'string' ||
        actionText.length > 24 * 1024 * 1024 || typeof eventText !== 'string' ||
        eventText.length > 48 * 1024 * 1024 || !result) throw Error('实验包缺少回放数据');
    const resume_node = archive.files[prefix + 'resume-node.json'];
    if (manifest.branch || resume_node) {
      await verifyResumeNode(resume_node);
      const branch = manifest.branch;
      if (branch?.schema !== 'survivors-research-branch-v1' || branch.node_id !== resume_node.node_id ||
          branch.node_sha256 !== resume_node.integrity || branch.base_tick !== resume_node.source.tick ||
          branch.start_semantics !== 'fresh-requests-at-node' || !Number.isSafeInteger(branch.limit_tick) ||
          branch.limit_tick <= branch.base_tick || result.tick < branch.base_tick || result.tick > branch.limit_tick ||
          result.base_tick !== branch.base_tick || result.limit_tick !== branch.limit_tick ||
          initial_state.limit_tick !== branch.limit_tick ||
          initial_state.node_state?.node_hash !== resume_node.node_state.node_hash ||
          await hashJSON(initial_state.node_state) !== await hashJSON(resume_node.node_state) ||
          await hashJSON(branch.source) !== await hashJSON(resume_node.source) ||
          await hashJSON(branch.start_facts) !== await hashJSON(resume_node.facts) ||
          await hashJSON(initial_state) !== manifest.initial_state_sha256) throw Error('分支实验包节点不一致');
    }
    const hashes = manifest.archive_hashes;
    const [actionHash, eventHash, resultHash] = await Promise.all([hashJSON(actionText), hashJSON(eventText), hashJSON(result)]);
    if (actionHash !== hashes?.actions_sha256 || eventHash !== hashes?.events_sha256 || resultHash !== hashes?.result_sha256) {
      throw Error('实验包事件、动作或终局哈希不一致');
    }
    const movementText = archive.files[prefix + 'movement.jsonl'];
    if ((movementText !== undefined || hashes?.movement_sha256 !== undefined) &&
        (typeof movementText !== 'string' || movementText.length > 24 * 1024 * 1024 ||
          await hashJSON(movementText) !== hashes?.movement_sha256)) throw Error('实验包位移哈希不一致');
    const profile = manifest.visual?.profile ?? 'none-v1';
    if (!EVIDENCE_VISUAL_PROFILES.includes(profile)) throw Error('未知的视觉档位');
    const roleProfiles = manifest.visual?.role_profiles;
    if (roleProfiles !== undefined && (!roleProfiles || Object.keys(roleProfiles).length !== 4 ||
        profile !== 'structured-v1' || roleProfiles.strategy !== profile || roleProfiles.direction !== profile ||
        roleProfiles.upgrade !== profile || roleProfiles.micro !== LOCAL_MICRO_PROFILE ||
        manifest.model.micro_visual_profile !== LOCAL_MICRO_PROFILE)) throw Error('实验包图像角色档位无效');
    if (roleProfiles === undefined && manifest.model.micro_visual_profile !== undefined) throw Error('实验包缺少图像角色档位');
    const projectionSchema = manifest.model.local_projection_schema;
    if (projectionSchema !== undefined && (!roleProfiles || !isLocalMicroProjectionSchema(projectionSchema))) {
      throw Error('实验包微操局部投影版本无效');
    }
    await checkPayloads(archive.files, prefix, eventText, profile, result.evidence_complete, roleProfiles, projectionSchema,
      manifest.model.provider_input_profile, manifest.config.action_profile);
    const actions = actionText.split('\n').filter(Boolean).map(line => JSON.parse(line));
    const profileValidator = researchPlanValidator(manifest.config.action_profile);
    if (actions.length > 36000 || actions.some(action => !Number.isSafeInteger(action?.applied_tick) ||
        action.applied_tick <= (manifest.branch?.base_tick ?? 0) || typeof action.action_id !== 'string' || action.action_id.length > 256 ||
        (profileValidator ? !profileValidator(action.action_id, action.action_ids) : action.action_ids !== undefined))) {
      throw Error('应用动作记录格式无效');
    }
    const events = (profileValidator || includeEvidence) ? eventText.split('\n').filter(Boolean).map(JSON.parse) : null;
    if (profileValidator) {
      const logged = new Map();
      const attempts = new Map();
      for (const event of events) {
        if (event.type === 'action_applied') logged.set(event.decision_id, event);
        if (event.type === 'model:attempt' && event.status === 'applied') attempts.set(event.decision_id, event);
      }
      if (result.evidence_complete && (logged.size !== actions.length || attempts.size !== actions.length ||
          actions.some(action => {
            const event = logged.get(action.decision_id);
            const attempt = attempts.get(action.decision_id);
            return event?.applied_tick !== action.applied_tick || !sameSequence(event?.action_ids, action.action_ids) ||
              !sameSequence(attempt?.action_ids, action.action_ids) || !sameSequence(attempt?.ack?.action_ids, action.action_ids);
          }))) throw Error('动作计划与已应用事件或模型确认不一致');
    }
    runs.push({run_id: id, manifest, initial_state, result, actions, metrics: result.metrics,
      ...(resume_node && {resume_node}), ...(includeEvidence && {events, payloads: {files: archive.files, prefix}}),
      evidence_complete: result.evidence_complete, evidence_fault: result.evidence_fault});
  }
  return runs;
}

async function checkPayloads(files, prefix, text, profile, complete, roleProfiles, projectionSchema, providerInputProfile, actionProfile) {
  async function check(line) {
    const event = JSON.parse(line);
    const directory = payloadDirectories.get(event.type);
    if (directory === undefined) return;
    const auxiliary = directory !== '';
    const auxiliaryLabel = directory === 'strategy/' ? '战略层' : '方向层';
    if (auxiliary && (profile !== 'structured-v1' || typeof event.decision_id !== 'string' ||
        !/^[\w-]{1,80}$/.test(event.decision_id))) throw Error(auxiliaryLabel + '记录格式无效');
    for (const [kind, key] of [['inputs', 'input'], ['outputs', 'output'], ['images', 'image']]) {
      const path = event[key + '_file'];
      if (path == null) {
        if (auxiliary && event[key + '_sha256'] != null) throw Error(auxiliaryLabel + '文件引用不完整');
        continue;
      }
      const stored = prefix + path;
      if (path !== directory + kind + '/' + event.decision_id + '.json' || !Object.hasOwn(files, stored) ||
          await hashJSON(files[stored]) !== event[key + '_sha256']) {
        throw Error(key === 'image' ? '实验包图像输入哈希不一致' : '实验包模型输入或输出哈希不一致');
      }
    }
    const image = event.image_file ? files[prefix + event.image_file] : null;
    const input = event.input_file ? files[prefix + event.input_file] : null;
    const chatContent = input?.messages?.[1]?.content;
    const decisionContent = Array.isArray(input?.input) ? input.input.flatMap(message => message?.content ?? []) : [];
    const references = [
      ...(Array.isArray(chatContent) ? chatContent.filter(part => part?.type === 'image_url').map(part => part.image_url?.url) : []),
      ...decisionContent.filter(part => part?.type === 'input_image').map(part => part.image_url)
    ];
    if (references.length && (references.length !== 1 || references[0] !== VISUAL_IMAGE_REFERENCE || !image)) {
      throw Error('实验包图像与模型输入引用不一致');
    }
    if (image) {
      let effectiveProfile = profile;
      if (roleProfiles) {
        const role = event.type === 'strategy:attempt' ? 'strategy' : event.type === 'advisor:attempt' ? 'direction'
          : event.visual_upgrade_offer === true ? 'upgrade' : 'micro';
        effectiveProfile = roleProfiles[role];
        const publicState = decisionContent.find(part => part?.type === 'input_text');
        const upgradeState=publicState?.text??input?.state?.[0];
        if(upgradeState!==undefined&&role==='upgrade'&&!JSON.parse(upgradeState).upgrade_offer){
          throw Error('实验包升级观测与图像角色档位不一致');
        }
        const microState = publicState?.text ?? input?.state?.[0];
        if(role==='micro'&&microState!==undefined){
          const parsed=JSON.parse(microState);
          if(parsed.schema!==(projectionSchema??'survivors-local-micro-v1')){
            throw Error('实验包微操观测与图像角色档位不一致');
          }
          const cappedTiming=providerInputProfile===DREX_CAPPED_TIMING_PROVIDER_INPUT_PROFILE;
          if((cappedTiming||providerInputProfile===DREX_TIMING_PROVIDER_INPUT_PROFILE)&&
              (!validMicroTimingContext(parsed,event.observation_tick,actionProfile)||
                Object.hasOwn(parsed,'provider_processing_cap_ms')!==cappedTiming)){
            throw Error('实验包微操时序档案无效');
          }
        }
      }
      if (profile === STRUCTURED_TRAIL_PROFILE) {
        const publicState = decisionContent.find(part => part?.type === 'input_text');
        const upgrade = event.visual_upgrade_offer === true;
        if (publicState && Boolean(JSON.parse(publicState.text).upgrade_offer) !== upgrade) {
          throw Error('实验包升级观测与视觉档位不一致');
        }
        effectiveProfile = upgrade ? 'structured-v1' : profile;
        if (event.decision_timing?.visual?.profile !== effectiveProfile) {
          throw Error('实验包图像计时档位不一致');
        }
      }
      const metadata = validateVisualImage(image, event.observation_tick, effectiveProfile);
      if ((auxiliary && metadata.mime_type !== 'image/png') ||
          Object.entries(metadata).some(([key, value]) => event.visual?.[key] !== value)) {
        throw Error('实验包图像元数据不一致');
      }
    } else if (complete && profile !== 'none-v1' && (event.status === 'applied' || event.request_started_at_ms != null)) {
      throw Error('实验包缺少本轮图像输入');
    }
  }
  const lines = text.split('\n').filter(Boolean);
  for (let index = 0; index < lines.length; index += 128) {
    await Promise.all(lines.slice(index, index + 128).map(check));
  }
}

import {BRANCH_SCHEMA, NODE_DURATION_TICKS, strategyName} from './resume-node.js';
import {createTrajectoryCapture} from './trajectory-render.js';
import {runAgent} from './agent-loop.js';
import {createExecutionWindow} from './provider-execution-window.js';
import {createProviderClock,providerClockMode,PROVIDER_PROCESSING_CAP_MS} from './provider-clock.js';
import {connectSimulation, expectResponse} from './worker-client.js';
import {hashJSON} from './evidence.js';
import {GATE, resultMetrics} from './report.js';
import {createVisualCapture} from './visual-render.js';
import {createLocalMicroCapture} from './micro-visual-render.js';
import {DREX_PROVIDER_MICRO_INPUT_PROFILE} from './models/local-path-micro.js';
import {STRATEGY_TACTICS_INPUT_SCHEMA, STRATEGY_TACTICS_PROMPT_VERSION, STRATEGY_BRIEF_INPUT_SCHEMA, STRATEGY_BRIEF_PROMPT_VERSION, STRATEGY_COMBAT_INPUT_SCHEMA, STRATEGY_SHARED_INPUT_SCHEMA, STRATEGY_SHARED_PROMPT_VERSION} from './models/action-strategy.js';
import {isControlBriefMode, CONTROL_BRIEF_SCHEMA} from './models/control-brief.js';
import {freezeLinkCalibration} from './models/compensation.js';
import {DECISION_TIMING_SCHEMA} from './models/decision-timing.js';
import {VISUAL_WIDTH, VISUAL_HEIGHT, MAX_VISUAL_IMAGE_BYTES, TRAJECTORY_PROFILE} from './models/visual-input.js';
import {BAT_CRYSTAL_BANDS} from '../../../public/games/survivors-lab-research-v1/src/bat-crystal-bands.mjs';
import {RESEARCH_BASELINE, RESEARCH_BASE_SIM_BLOB, RESEARCH_CLOCK_POLICY, RESEARCH_ENGINE,
  RESEARCH_SCHEMA, RESEARCH_RULES, TICK_HZ} from '../../shared/survivors-research-contract.js';

export const engineHash = typeof __MUNDI_RESEARCH_ENGINE_HASH__ === 'undefined' ? null : __MUNDI_RESEARCH_ENGINE_HASH__;
const commit = typeof __MUNDI_COMMIT__ === 'undefined' ? null : __MUNDI_COMMIT__;
export const now = () => performance.timeOrigin + performance.now();
const LINK_REFRESH_MS = 12_000;

async function makeManifest({runId, config, initialState, initialSnapshot, model, seedSet, batchId, runtime, setupMs, visual, benchmark, information, advisor, strategy, linkCompensation, branch}) {
  const {seed, ...parameters} = config;
  const {seed: modelSeed, ...modelConfig} = model;
  const {frozen_at_ms, ...linkCondition} = linkCompensation ?? {};
  const scenario = config.scenario === BAT_CRYSTAL_BANDS.id ? {
    id: BAT_CRYSTAL_BANDS.id,
    seed: BAT_CRYSTAL_BANDS.seed,
    enemy_respawns: BAT_CRYSTAL_BANDS.enemyRespawns,
    initial_enemy_ids: BAT_CRYSTAL_BANDS.initialEnemyIds,
    initial_gem_ids: BAT_CRYSTAL_BANDS.initialGemIds,
    initial_snapshot_sha256: initialSnapshot.tick === 0 ? await hashJSON(initialSnapshot) : null,
  } : null;
  const configuration = {
    engine: RESEARCH_ENGINE, engine_sha256: engineHash, rules: RESEARCH_RULES,
    config: parameters, model: modelConfig, seed_set: seedSet, runtime, visual, benchmark, ...(information && {information}), ...(advisor && {advisor}), ...(strategy && {strategy}), ...(linkCompensation && {link_compensation: linkCondition})
  };
  if (branch) configuration.branch = branch;
  return {
    schema: RESEARCH_SCHEMA,
    run_id: runId,
    batch_id: batchId,
    config_id: await hashJSON(configuration),
    repository_commit: commit,
    baseline_commit: RESEARCH_BASELINE,
    baseline_sim_blob: RESEARCH_BASE_SIM_BLOB,
    engine: RESEARCH_ENGINE,
    engine_sha256: engineHash,
    rules: RESEARCH_RULES,
    config,
    seed_set: seedSet,
    initial_state_file: 'initial-state.json',
    initial_state_sha256: await hashJSON(initialState),
    model: modelSeed === undefined ? model : {...model, seed: modelSeed},
    runtime,
    visual,
    benchmark,
    ...(information && {information}),
    ...(advisor && {advisor}),
    ...(strategy && {strategy}),
    ...(branch && {branch}),
    ...(scenario && {scenario}),
    link_compensation: linkCompensation ?? {mode: 'wall-clock', configured_ms: 0, calibration: null},
    decision_timing: {schema: DECISION_TIMING_SCHEMA, unit: 'ms', clock: 'performance-time-origin'},
    cold_start_ms: setupMs,
    tick_hz: TICK_HZ,
    clock_policy: linkCompensation?.mode === providerClockMode
      ? {version:providerClockMode,tick_hz:TICK_HZ,action_frame_rounding:'ceiling-of-cumulative-time',
        provider_processing_cap_ms:linkCompensation.provider_processing_cap_ms}
      : RESEARCH_CLOCK_POLICY,
    quality_gate: GATE,
    created_at: new Date().toISOString()
  };
}

export function runExperiment({config, model: selectedModel, createBranchModel, resumeNode, nodeLookup, store, seedSet, batchId, runtime, onUpdate, createWorker, visualProfile = 'none-v1', minimumObservationIntervalMs = 0, benchmark = null, information = null, advisor = null, linkCalibration = null, linkCalibrationFrozenAtMs = Date.now(), measureLink, providerProcessing = false, providerAdmission, durationTicks = NODE_DURATION_TICKS}) {
  if (!Number.isFinite(linkCalibrationFrozenAtMs) || linkCalibrationFrozenAtMs > Date.now()) {
    throw new TypeError('Invalid link calibration freeze time');
  }
  if (resumeNode && (!Number.isSafeInteger(durationTicks) || durationTicks < 1)) {
    throw new TypeError('Invalid saved-node duration');
  }
  const runId = crypto.randomUUID();
  const restored = resumeNode ? createBranchModel(runId) : null;
  const model = restored?.model ?? selectedModel;
  const strategyConfig = model?.strategy?.config;
  const combatContextSchema = providerProcessing && model?.config?.combat_context_schema;
  const controlBriefMode = model?.config?.control_brief_mode;
  const controlBrief = providerProcessing && isControlBriefMode(controlBriefMode);
  const strategy = strategyConfig?.combat_context_schema
    ? {...strategyConfig, input_schema: strategyConfig.prompt_version === STRATEGY_TACTICS_PROMPT_VERSION ? STRATEGY_TACTICS_INPUT_SCHEMA : strategyConfig.prompt_version === STRATEGY_SHARED_PROMPT_VERSION ? STRATEGY_SHARED_INPUT_SCHEMA : strategyConfig.prompt_version === STRATEGY_BRIEF_PROMPT_VERSION
      ? STRATEGY_BRIEF_INPUT_SCHEMA : STRATEGY_COMBAT_INPUT_SCHEMA} : strategyConfig;
  const advisorManifest = advisor && combatContextSchema ? {...advisor, combat_context_schema: combatContextSchema,
    ...(controlBrief && {control_brief_schema: CONTROL_BRIEF_SCHEMA, control_brief_mode: controlBriefMode})} : advisor;
  const microProfile = model?.config.micro_visual_profile;
  const roleProfiles = microProfile && {strategy: visualProfile, direction: visualProfile,
    micro: microProfile, upgrade: visualProfile};
  const localCapture = roleProfiles ? createLocalMicroCapture() : undefined;
  const execution = providerProcessing ? createExecutionWindow(resumeNode ?? {
    source:{tick:0,config},facts:{hits_taken:0},
    node_state:{harness:{movement:{entry:{id:'stop'}},movementPlan:[],planInfo:null}},
  }) : null;
  if (providerProcessing && (!model?.config || model.config.model !== 'drex-max-v1.1')) {
    throw new TypeError('按供应商处理计时需要 Drex 微操。');
  }
  const calibration = model && !providerProcessing && linkCalibration ? freezeLinkCalibration(linkCalibration, linkCalibrationFrozenAtMs) : null;
  let compensationMs = calibration?.budget_ms ?? 0;
  const adaptive = Boolean(model && !providerProcessing && measureLink);
  const linkCompensation = providerProcessing ? {mode:providerClockMode,provider_processing_cap_ms:PROVIDER_PROCESSING_CAP_MS} : calibration || adaptive ? {
    mode: 'estimated-link-compensation', configured_ms: compensationMs, calibration, frozen_at_ms: linkCalibrationFrozenAtMs,
    ...(adaptive && {adaptive: true, refresh_interval_ms: LINK_REFRESH_MS}),
  } : null;
  const workerConfig = {...config, latency_compensation_ms: compensationMs,
    ...(model?.config.kind === 'human' && {pause_for_upgrade: true})};
  const abort = new AbortController();
  const setupStarted = now();
  const regularCapture = visualProfile === TRAJECTORY_PROFILE ? createTrajectoryCapture()
    : visualProfile === 'none-v1' ? undefined : createVisualCapture();
  let nextObservationAt = 0;
  let initialObservation;
  async function observe({after_tick, signal, include_visual_frame}) {
    const wait = nextObservationAt - performance.now();
    if (wait > 0) {
      await new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, wait);
        signal.addEventListener('abort', abort, {once: true});
        if (signal.aborted) abort();
      });
    }
    signal?.throwIfAborted();
    const requested_at_ms = now();
    try {
      if (initialObservation) {
        const sample = initialObservation;
        initialObservation = null;
        nextObservationAt = performance.now() + minimumObservationIntervalMs;
        return sample;
      }
      const sample = expectResponse(await worker.request('research:observe', runId,
        {after_tick, ...(include_visual_frame && {include_visual_frame: true})}, {signal}));
      const returned_at_ms = now();
      nextObservationAt = performance.now() + minimumObservationIntervalMs;
      return {...sample, page_observation_timing: {requested_at_ms, returned_at_ms}};
    } catch (error) {
      throw Object.assign(new Error(error?.message ?? '观测请求失败', {cause: error}),
        {code: error?.code, page_observation_timing: {requested_at_ms, returned_at_ms: now()}});
    }
  }
  let fault = null;
  let stopReason = null;
  let writer;
  let latestSnapshot;
  let startedAt;
  let wallStartedAt;
  let wallEndedAt;
  let receivedMax = 0;
  let stopPromise;
  let terminalResolve;
  const terminal = new Promise(resolve => { terminalResolve = resolve; });
  const add = event => writer?.add(event);
  const providerClock = providerProcessing ? createProviderClock({
    admission:providerAdmission,
    async step(target, held) {
      const deferred = held ? submitToWorker(held) : null;
      const step = worker.request('research:provider_step', runId, {relative_tick:target});
      const [response, ack] = await Promise.all([step, deferred]);
      if (held && !ack.error) held.onDeferredApplied(ack);
      return expectResponse(response);
    },
    trace:event => add({...event,run_id:runId,at_ms:event.at_wall_ms}),
    fatal:error => {
      fault ??= error.message;
      onUpdate({type:'fault',message:fault});
      stop('interrupted');
    },
  }) : null;
  function submitToWorker({observation_id, decision_id, action_id, action_ids}) {
    return worker.request('research:action', runId, {observation_id, decision_id, action_id,
      ...(action_ids && {action_ids})});
  }
  function submitAction(action) {
    return providerClock ? providerClock.acknowledge(action, submitToWorker) : submitToWorker(action);
  }
  const traceCapture = capture => async input => {
    const startedAt = now();
    const prepared = await capture(input);
    const {profile, tick} = prepared.image;
    const capture_id = profile + ':' + tick;
    add({type: 'visual:prepared', run_id: runId, tick, at_ms: now(), profile, capture_id,
      prepare_elapsed_ms: now() - startedAt, render_ms: prepared.render_ms, encode_ms: prepared.encode_ms});
    return {...prepared, capture_id};
  };
  const prepareImage = roleProfiles ? traceCapture(regularCapture) : regularCapture;
  const prepareLocalMicroImage = localCapture && traceCapture(localCapture);
  async function refreshLink() {
    const budgets = calibration ? [calibration.budget_ms] : [];
    while (!abort.signal.aborted) {
      await new Promise(resolve => {
        const done = () => {
          clearTimeout(timer);
          abort.signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, LINK_REFRESH_MS);
        abort.signal.addEventListener('abort', done, {once: true});
      });
      if (abort.signal.aborted) return;
      const measured = await Promise.resolve().then(() => measureLink(abort.signal)).catch(() => null);
      if (!measured || abort.signal.aborted) continue;
      budgets.push(measured.budget_ms);
      if (budgets.length > 3) budgets.shift();
      if (budgets.length === 1) compensationMs = budgets[0];
      if (budgets.length === 3) compensationMs = [...budgets].sort((a, b) => a - b)[1];
      add({type: 'link:calibration_updated', at_ms: now(), budget_ms: compensationMs, calibration: measured});
    }
  }
  const stop = (reason = 'stopped') => {
    stopReason ??= reason;
    providerClock?.end();
    abort.abort();
    if (startedAt != null && !stopPromise) {
      stopPromise = worker.request('research:stop', runId, {reason: stopReason})
        .then(expectResponse).then(terminalResolve, error => onFailure(error.message));
    }
    return stopPromise;
  };
  function onFailure(message) {
    fault ??= message;
    onUpdate({type: 'fault', message});
    providerClock?.end();
    abort.abort();
    terminalResolve();
  }
  const hitTicks = model?.actionApplied ? [] : null;
  const worker = connectSimulation({createWorker, onFailure, onMessage(message) {
    if (message.run_id !== runId) return;
    if (message.type === 'research:snapshot') {
      latestSnapshot = message.snapshot;
      if (!providerClock && Number.isFinite(message.snapshot_ready_at_ms)) {
        receivedMax = Math.max(receivedMax, now() - message.snapshot_ready_at_ms);
      }
      onUpdate({...message, startedAt});
    }
    if (message.type === 'research:event') {
      execution?.record(message.event);
      if (hitTicks && message.event.type === 'player_hit') hitTicks.push(message.event.tick);
      add(message.event);
      onUpdate(message.event);
      if (message.event.type === 'run_ended') {
        wallEndedAt = now();
        providerClock?.end();
        terminalResolve();
      }
    }
  }});
  const lifecycle = state => {
    add({type: 'page:lifecycle', state, at_ms: now(), tick: latestSnapshot?.tick ?? null});
    if (writer) void worker.request('research:lifecycle', runId, {state}).catch(() => {});
    if (state === 'freeze' || state === 'pagehide') writer?.flush();
    if (state === 'pagehide') stop('interrupted');
  };
  async function compensationRequest(type, {decision_id, budget_ms}) {
    const response = expectResponse(await worker.request(type, runId, {decision_id, budget_ms}));
    const receipt = response.latency_compensation;
    if (receipt?.decision_id !== decision_id || receipt.budget_ms !== budget_ms ||
        !Number.isFinite(receipt.paused_ms) || receipt.paused_ms < 0 || receipt.paused_ms > budget_ms ||
        (type === 'research:latency_end' && receipt.active !== false)) {
      throw Error('研究 Worker 返回了无效的链路补偿凭证');
    }
    return receipt;
  }
  async function complete() {
    let final;
    let agentStartedAt;
    let interrupted = false;
    try {
      const created = expectResponse(await worker.request('research:create', runId, {config: workerConfig,
        ...(providerClock && {clock_mode:providerClockMode}),
        ...(resumeNode && {node_state: resumeNode.node_state, duration_ticks: durationTicks})}));
      if (providerClock && created.clock_mode !== providerClockMode) throw Error('研究 Worker 时钟不匹配');
      const branch = resumeNode && {
        schema: BRANCH_SCHEMA, node_id: resumeNode.node_id, node_sha256: resumeNode.integrity,
        source: resumeNode.source, base_tick: created.base_tick, limit_tick: created.limit_tick,
        start_facts: resumeNode.facts, strategy: strategyName(model?.config, advisor, strategy),
        start_semantics: 'fresh-requests-at-node', context: restored?.contextReport, prefix_model_requests: 0, node_lookup: nodeLookup,
        ...(roleProfiles && {micro_feedback: 'fresh-at-node'}),
      };
      if (branch && (branch.base_tick !== resumeNode.source.tick ||
          branch.limit_tick !== Math.min(branch.base_tick + durationTicks, created.config.max_ticks))) {
        throw Error('模拟器返回的续测起点或时限无效');
      }
      latestSnapshot = created.snapshot;
      const manifest = await makeManifest({runId, config: created.config, initialState: created.initial_state, initialSnapshot: created.snapshot,
        model: {...(model?.config ?? {kind:'none'}),
          ...(controlBrief && {control_brief_schema: CONTROL_BRIEF_SCHEMA}),
          ...(providerProcessing && {provider_input_profile:model?.config.provider_input_profile??DREX_PROVIDER_MICRO_INPUT_PROFILE})}, seedSet, batchId, runtime, setupMs: now() - setupStarted, benchmark, information, advisor: advisorManifest, strategy, linkCompensation, branch,
        visual: {profile: visualProfile, minimum_observation_interval_ms: minimumObservationIntervalMs,
          ...(roleProfiles && {role_profiles: roleProfiles}),
          ...(prepareImage && {width: VISUAL_WIDTH, height: VISUAL_HEIGHT, max_image_bytes: MAX_VISUAL_IMAGE_BYTES,
            encoding_policy: visualProfile === TRAJECTORY_PROFILE ? 'png-only-v1' : 'png-then-jpeg-v1'})}});
      writer = await store.start({run_id: runId, manifest, initial_state: created.initial_state,
        ...(resumeNode && {resume_node: resumeNode}),
        evidence_complete: false, status: 'recording'}, error => {
        fault ??= error.message;
        onUpdate({type: 'fault', message: error.message});
        stop('evidence-error');
      });
      add({type: 'page:created', at_ms: now(), visibility: document.visibilityState});
      if (stopReason || document.hidden) {
        if (document.hidden) await worker.request('research:lifecycle', runId, {state: 'hidden'});
        interrupted = true;
        final = expectResponse(await worker.request('research:stop', runId, {reason: 'interrupted'}));
      } else {
        const requested_at_ms = now();
        const start = expectResponse(await worker.request('research:start', runId,
          branch ? {include_initial_visual_frame: Boolean(prepareImage)} : {}));
        const returned_at_ms = now();
        startedAt = start.started_at_ms;
        wallStartedAt = returned_at_ms;
        if (branch) {
          if (start.initial_sample?.observation?.tick !== branch.base_tick ||
              start.initial_sample.observation.run_id !== runId) throw Error('续测首帧与保存节点不一致');
          initialObservation = {...start.initial_sample, page_observation_timing: {requested_at_ms, returned_at_ms}};
        }
        onUpdate({type: 'research:snapshot', snapshot: latestSnapshot, startedAt});
        if (stopReason) stop(stopReason);
        if (adaptive) void refreshLink();
        if (model) agentStartedAt = now();
        const loop = model ? runAgent({
          signal: abort.signal,
          model,
          ...(hitTicks && {hitsAtTick: tick => (branch?.start_facts.hits_taken ?? 0) + hitTicks.findLastIndex(hit => hit <= tick) + 1}),
          ...(model.advisor && {advisor: model.advisor}),
          ...(model.strategy && {strategy: model.strategy}),
          ...((model.advisor || model.strategy) && {onAuxiliaryEvent: event => { add(event); onUpdate(event); }}),
          observe, visualProfile, prepareImage, prepareLocalMicroImage, compensationMs, actionProfile: created.config.action_profile,
          ...(adaptive && {currentCompensation: () => compensationMs}),
          onRequestStart: detail => compensationRequest('research:latency_begin', detail),
          onRequestEnd: detail => compensationRequest('research:latency_end', detail),
          executedMovement:execution?.observe,
          submit:submitAction, providerClock,
          onEvent: event => { add(event); onUpdate(event); }
        }).catch(error => {
          fault ??= error.message;
          onUpdate({type: 'fault', message: fault});
          stop('interrupted');
        }) : Promise.resolve();
        final = await terminal;
        abort.abort();
        const agentResult = await loop;
        agentStartedAt = agentResult?.started_at_ms ?? agentStartedAt;
        final ??= expectResponse(await worker.request('research:result', runId));
      }
    } catch (error) {
      fault ??= error.message;
      onUpdate({type: 'fault', message: fault});
      if (!writer) throw error;
    } finally {
      providerClock?.end();
      abort.abort();
      worker.close();
    }
    add({type: 'page:finished', at_ms: now(), snapshot_transfer_max_ms: receivedMax, fault});
    const result = final?.result;
    const measurementElapsed = providerClock ? result?.elapsed_ms ?? null : result && agentStartedAt != null && result.ended_at_ms != null
      ? Math.max(0, result.ended_at_ms - agentStartedAt) : result?.elapsed_ms ?? null;
    const providerElapsed = providerClock && wallStartedAt != null ? (wallEndedAt ?? now()) - wallStartedAt : null;
    const providerTimeline = providerClock?.snapshot();
    const chargedMs = providerTimeline && result
      ? Math.min(providerTimeline.virtual_ms,providerTimeline.frame*1000/TICK_HZ) : null;
    const pausedMs = (result?.latency_compensated_ms ?? 0) + (result?.upgrade_paused_ms ?? 0);
    const effectiveMeasurementElapsed = measurementElapsed === null ? null : Math.max(0, measurementElapsed - pausedMs);
    return writer.finish({
      status: result?.status ?? 'interrupted',
      result: result ? {...result, agent_started_at_ms: agentStartedAt ?? null, measurement_elapsed_ms: measurementElapsed, effective_measurement_elapsed_ms: effectiveMeasurementElapsed,
        preflight_elapsed_ms: wallStartedAt == null ? null : wallStartedAt - setupStarted,
        ...(providerClock && {provider_clock:{...providerTimeline,virtual_ms:chargedMs,charged_sim_ms:chargedMs,
          last_ready_virtual_ms:providerTimeline.virtual_ms,
          unspent_terminal_ms:providerTimeline.virtual_ms-chargedMs,
          exact_fractional_tick:chargedMs*TICK_HZ/1000,
          frame_quantization_ticks:providerTimeline.frame-chargedMs*TICK_HZ/1000,
          wall_started_at_ms:wallStartedAt ?? null,wall_ended_at_ms:wallEndedAt ?? null,
          wall_elapsed_ms:providerElapsed,wall_minus_charged_ms:providerElapsed == null ? null : providerElapsed-chargedMs},
          wall_elapsed_ms:providerElapsed}), snapshot_transfer_max_ms: providerClock ? null : receivedMax} : null,
      actions: final?.actions ?? null,
      evidence_complete: !fault && !interrupted && Boolean(final?.result),
      evidence_fault: fault
    }, (saved, events) => {
      const metrics = resultMetrics(saved.result, events, saved.actions ?? events.filter(event => event.type === 'action_applied'), advisor, strategy, roleProfiles);
      const mismatch = metrics.unmatched_authoritative_actions > 0 || metrics.unmatched_applied_attempts > 0;
      const missingImage = visualProfile !== 'none-v1' && events.some(event =>
        ['model:attempt', 'advisor:attempt', 'strategy:attempt'].includes(event.type) &&
        (event.status === 'applied' || event.request_started_at_ms != null) && !event.image);
      return {
        metrics,
        evidence_complete: saved.evidence_complete && !mismatch && !missingImage,
        evidence_fault: saved.evidence_fault ?? (mismatch ? '实际应用日志和 Agent 确认未完全匹配' : missingImage ? '缺少本轮图像输入' : null)
      };
    });
  }
  return {runId, stop, lifecycle, done: complete()};
}

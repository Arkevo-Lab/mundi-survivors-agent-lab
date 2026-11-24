import {RESEARCH_SCHEMA,TICK_MS} from '../../shared/survivors-research-contract.js';
import {ResearchRun, epochNow} from './sim-run.js';
import {providerClockMode} from './provider-clock.js';
import {ResearchError} from './sim-world.js';
import {buildResearchNode, replayResearch} from './sim-replay.js';

export function attachResearchWorker(port) {
  const send = payload => port.postMessage(payload);
  const usedRunIds = new Set();
  let activeRun;
  let manualClock = null;
  const clockNow = () => manualClock ? manualClock.epoch + manualClock.frame * TICK_MS : epochNow();
  let replaying = false;

  async function dispatch(message, receivedAt) {
    const {type, run_id: runId} = message;
    if (typeof runId !== 'string' || !runId || runId.length > 160) {
      throw new ResearchError('invalid-run-id', 'A valid run_id is required.');
    }
    if (message.schema !== undefined && message.schema !== RESEARCH_SCHEMA) {
      throw new ResearchError('unsupported-version', 'Unsupported research message schema.');
    }
    if (type === 'research:create') {
      if (replaying || activeRun && activeRun.status !== 'ended') {
        throw new ResearchError('run-active', 'Stop the active run or wait for replay before creating another run.');
      }
      if (usedRunIds.has(runId)) throw new ResearchError('run-id-reused', 'Use a new run ID.');
      if (message.node_state?.source_run_id === runId) throw new ResearchError('run-id-reused', 'Use a new run ID.');
      if (message.node_state === null || message.duration_ticks !== undefined && !message.node_state) {
        throw new ResearchError('invalid-resume-node', 'A duration requires a valid resume node.');
      }
      if (message.clock_mode !== undefined && message.clock_mode !== providerClockMode) {
        throw new ResearchError('invalid-clock-mode', '未知的研究时钟模式。');
      }
      manualClock = message.clock_mode === providerClockMode ? {epoch:epochNow(),frame:0} : null;
      activeRun = new ResearchRun({runId, config: message.config, nodeState: message.node_state,
        durationTicks: message.duration_ticks, send,
        ...(manualClock && {now:clockNow,schedule:()=>null,allowSameObservationTick:true})});
      if (manualClock && (activeRun.config.latency_compensation_ms !== 0 || activeRun.config.pause_for_upgrade)) {
        activeRun = null;
        manualClock = null;
        throw new ResearchError('invalid-clock-mode', '供应商处理时钟要求关闭实时补偿。');
      }
      usedRunIds.add(runId);
      const {world, config} = activeRun;
      return {...(manualClock && {clock_mode:providerClockMode}),config, initial_state: world.initialState(), snapshot: world.snapshot(),
        ...(activeRun.resumed && {base_tick: world.baseTick, limit_tick: world.limitTick})};
    }
    if (type === 'research:replay' || type === 'research:build_node') {
      if (replaying || activeRun && activeRun.status !== 'ended') {
        throw new ResearchError('run-active', 'Stop the active run or wait for replay.');
      }
      replaying = true;
      try {
        return await (type === 'research:build_node' ? buildResearchNode(message) : replayResearch(message));
      } finally {
        replaying = false;
      }
    }
    if (!activeRun || activeRun.runId !== runId) throw new ResearchError('unknown-run', 'The requested run is not active on this Worker.');
    switch (type) {
      case 'research:provider_step': {
        const target = message.relative_tick;
        if (!manualClock || activeRun.status === 'created' || !Number.isInteger(target) ||
            target < manualClock.frame || target - manualClock.frame > 600) {
          throw new ResearchError('invalid-provider-frame', '无效的供应商时钟步进目标。');
        }
        while (manualClock.frame < target && activeRun.status === 'running') {
          manualClock.frame++;
          activeRun.advance();
          if (activeRun.world.done) activeRun.finish(activeRun.world.reason);
          else if (manualClock.frame % 6 === 0) activeRun.publishSnapshot();
        }
        activeRun.flushObservers();
        return {relative_tick:manualClock.frame,terminal:activeRun.status === 'ended'};
      }
      case 'research:start': return activeRun.start(message.include_initial_visual_frame);
      case 'research:observe': return activeRun.observe(message.after_tick, message.include_visual_frame, receivedAt);
      case 'research:latency_begin': return activeRun.beginLatency(message.decision_id, message.budget_ms);
      case 'research:latency_end': return activeRun.endLatency(message.decision_id);
      case 'research:action': return activeRun.submit(message);
      case 'research:stop':
        return activeRun.finish(['interrupted', 'evidence-error'].includes(message.reason) ? message.reason : 'stopped');
      case 'research:result': return activeRun.result();
      case 'research:lifecycle': return activeRun.lifecycle(message.state);
      default: throw new ResearchError('unknown-request', 'Unsupported research request.');
    }
  }

  port.addEventListener('message', async ({data}) => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;
    const {request_id, type, run_id} = data;
    if (!['string', 'number'].includes(typeof request_id)) return;
    const receivedAt = type === 'research:observe' ? clockNow() : null;
    const envelope = {schema: RESEARCH_SCHEMA, request_id, type, run_id};
    try {
      const response = {...envelope, ...await dispatch(data, receivedAt)};
      if (response.observation_timing) response.observation_timing.response_post_started_at_ms = clockNow();
      if (response.initial_sample?.observation_timing) {
        response.initial_sample.observation_timing.response_post_started_at_ms = clockNow();
      }
      send(response);
    } catch (error) {
      send({...envelope, error: {code: error.code ?? (type === 'research:replay' ? 'invalid-replay' : 'simulation-error'),
        message: error.message}});
    }
  });
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) attachResearchWorker(self);

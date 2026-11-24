import { ADVISOR_MODE, ADVISOR_REFRESH_TICKS, ADVISOR_TTL_TICKS } from './action-advisor.js';
import { ResearchModelError, researchNow } from './common.js';
import { requestLatency } from './compensation.js';
import {NACE_PROVIDER} from './nace-decisions.js';
import {timedProviderResult} from '../provider-clock.js';
import {createControlBrief,ageControlBrief,isControlBriefMode} from './control-brief.js';

function failureStatus(error) {
  if (error?.name === 'AbortError') return 'cancelled';
  if (!(error instanceof ResearchModelError)) return 'model_error';
  if (['cancelled', 'timeout', 'provider_refusal'].includes(error.code)) return error.code;
  return 'model_error';
}

export function createAdvisorScheduler({memory, advise, provider, mode = ADVISOR_MODE, cardinal = false, restore = null}) {
  let active = restore?.active ?? null;
  let pending = null;
  let nextTick = restore?.nextTick ?? 0;
  let open = true;
  let memoryTiming = null;
  let lastHint = null;
  let providerPhase = 1;

  function closeAttempt(row, status, sampleTick, emit, hint = null) {
    const latency = requestLatency(row.finished - row.started, row.budget);
    const result = row.result ?? row.error?.details;
    emit({
      type: 'advisor:attempt', advisor_mode: mode, advisor_role: cardinal ? 'cardinal-advisor' : 'advisor',
      at_ms: researchNow(), decision_id: row.id, run_id: row.observation.run_id,
      observation_id: row.observation.observation_id, observation_tick: row.observation.tick,
      sampled_at_ms: row.observation.sampled_at_ms, resolved_tick: sampleTick,
      request_started_at_ms: row.started, request_finished_at_ms: row.finished,
      request_latency: latency, compensation_receipt: null, actual_simulation_age_ticks:
        sampleTick === null ? null : sampleTick - row.observation.tick,
      status, image: row.image, visual: {...row.visual, shared_with_micro: row.visual?.shared_with_micro ?? true},
      memory_timing: row.memoryTiming,
      input: result?.input ?? null, raw_response: result?.raw_response ?? null,
      usage: result?.usage ?? null, backend_metadata: result?.backend_metadata ?? null,
      timings: result?.timings ?? null, guidance: result?.guidance ?? null, hint,
      error: row.error ? {code: row.error.code ?? 'model_unavailable', message: row.error.message} : null,
    });
  }

  function hintAt({snapshot, guidance, sourceTick, acceptedTick, id, controlBrief}) {
    if (snapshot.tick >= sourceTick + ADVISOR_TTL_TICKS) return null;
    const target = snapshot.targets.find(target => target.id === guidance.target_id);
    if (guidance.target_id !== null && (!target || !['visible', 'unknown'].includes(target.status))) return null;
    if (guidance.target_id === null && guidance.heading === 'none') return null;
    return Object.freeze({
      guidance_id: id, source_tick: sourceTick, accepted_tick: acceptedTick,
      expires_tick: sourceTick + ADVISOR_TTL_TICKS, heading: guidance.heading,
      ...(controlBrief!==undefined&&{control_brief:ageControlBrief(controlBrief,snapshot.tick)}),
      target: target ? Object.freeze({id: target.id, status: target.status,
        dx: target.x - snapshot.player.x, dy: target.y - snapshot.player.y, last_seen_tick: target.last_seen_tick}) : null,
    });
  }

  function checkResult(snapshot, observation, emit) {
    const row = pending;
    if (!row?.finished) return;
    const sampleTick = snapshot.tick;
    if (row.error) {
      closeAttempt(row, failureStatus(row.error), sampleTick, emit);
    } else if (sampleTick >= row.observation.tick + ADVISOR_TTL_TICKS) {
      closeAttempt(row, 'expired', sampleTick, emit);
    } else if (observation.upgrade_offer) {
      return;
    } else {
      const guidance = row.result.guidance;
      const sourceTick = row.observation.tick;
      if (!memory.accept({guidance_id: row.id, source_tick: sourceTick, ...guidance})) {
        closeAttempt(row, 'discarded', sampleTick, emit);
      } else {
        const current = memory.snapshot();
        active = {guidance, sourceTick, acceptedTick: sampleTick, id: row.id,
          ...(row.controlBrief!==undefined&&{controlBrief:row.controlBrief})};
        const hint = hintAt({snapshot: current, ...active});
        closeAttempt(row, 'accepted', sampleTick, emit, hint);
        emit({type: 'advisor:published', at_ms: researchNow(), run_id: observation.run_id,
          decision_id: row.id, observation_tick: sourceTick, accepted_tick: sampleTick, guidance, hint});
      }
    }
    pending = null;
  }

  return {
    observe({observation, frame, hitsTaken, emit}) {
      if (!open) return null;
      const started = researchNow();
      memory.observe(observation, frame && {tick: frame.tick, sampled_at_ms: frame.sampled_at_ms,
        player: {x: frame.player?.x, y: frame.player?.y}, gemsCollected: frame.gemsCollected}, hitsTaken, true);
      const projected = researchNow();
      const snapshot = memory.snapshot();
      memoryTiming = {observe_ms: projected - started, snapshot_ms: researchNow() - projected};
      if (!snapshot || snapshot.tick !== observation.tick || snapshot.run_id !== observation.run_id) return null;
      checkResult(snapshot, observation, emit);
      const hint = observation.upgrade_offer || !active ? null : hintAt({snapshot: memory.snapshot(), ...active});
      if (hint?.guidance_id !== lastHint?.guidance_id || hint?.target?.status !== lastHint?.target?.status) {
        emit({type: 'advisor:availability', at_ms: researchNow(), run_id: observation.run_id,
          observation_tick: observation.tick, hint});
      }
      lastHint = hint;
      return hint;
    },
    dispatch({actionProfile,observation, candidates, image, visual, budget, directionObservation, signal, strategy, combat_context, control_brief_mode, emit, providerClock}) {
      if (!open || pending || observation.upgrade_offer || image?.mime_type !== 'image/png' || signal?.aborted || observation.tick < nextTick) return;
      const snapshotStarted = researchNow();
      const snapshot = cardinal ? memory.cardinalSnapshot({includeHeading:provider===NACE_PROVIDER}) : memory.snapshot();
      const snapshotMs = researchNow() - snapshotStarted;
      if (!snapshot || snapshot.tick !== observation.tick || snapshot.run_id !== observation.run_id) return;
      const controller = new AbortController();
      const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const row = {id: crypto.randomUUID(), observation, image, visual, controller, budget, memoryTiming: {...memoryTiming, request_snapshot_ms: snapshotMs}, started: researchNow(),
        ...(isControlBriefMode(control_brief_mode)&&{controlBrief:createControlBrief(strategy,observation.tick)})};
      pending = row;
      nextTick = observation.tick + ADVISOR_REFRESH_TICKS;
      if (strategy) emit?.({type:'strategy:used',at_ms:researchNow(),run_id:observation.run_id,observation_tick:observation.tick,
        decision_id:row.id,strategy_id:strategy.strategy_id,source_tick:strategy.source_tick,
        accepted_tick:strategy.accepted_tick,age_ticks:strategy.age_ticks});
      const providerProfile=providerClock && {phase:providerPhase,...(isControlBriefMode(control_brief_mode)&&{brief_mode:control_brief_mode})};
      if (providerProfile) providerPhase=(providerPhase+1)%4;
      row.settled = Promise.resolve().then(() => timedProviderResult(providerClock,
        {id:row.id,role:'advisor',provider,observation,signal:requestSignal}, () => advise({observation: directionObservation, candidates, image,
        action_profile: actionProfile ?? 'hold-sequence-v1', advisor_context: snapshot, ...(strategy && {strategy_context:strategy}), ...(combat_context && {combat_context}), ...(providerProfile && {provider_profile:providerProfile}), signal: requestSignal}))).then(
        result => { row.result = result; row.finished = researchNow(); },
        error => { row.error = error; row.finished = researchNow(); },
      );
    },
    recordAction: receipt => memory.recordAction(receipt),
    async finish(emit) {
      open = false;
      const row = pending;
      pending = null;
      if (!row) return;
      row.controller.abort();
      if (row.finished === undefined) {
        let timer;
        await Promise.race([row.settled, new Promise(resolve => { timer = setTimeout(resolve, 75); })]);
        clearTimeout(timer);
      }
      row.finished ??= researchNow();
      closeAttempt(row, row.error ? failureStatus(row.error) : 'cancelled', memory.snapshot()?.tick ?? null, emit);
    },
  };
}

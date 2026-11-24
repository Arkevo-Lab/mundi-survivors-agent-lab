import { RESEARCH_SLOTS_PROFILE, validSlotPlan } from './models/action-slots.js';
import { RESEARCH_COVERAGE_SEQUENCE_PROFILE, researchPlanValidator } from '../../shared/survivors-research-contract.js';
import { SEQUENCE_ACTION_PROFILE, validActionSequence } from './models/action-sequence.js';
import { ResearchModelError, researchNow } from './models/common.js';
import { validateVisualImage, EVIDENCE_VISUAL_PROFILES, STRUCTURED_TRAIL_PROFILE, TRAJECTORY_PROFILE } from './models/visual-input.js';
import { decisionTiming, elapsed, observationTiming } from './models/decision-timing.js';
import { requestLatency } from './models/compensation.js';
import {withoutWeaponState} from './models/action-observation.js';
import {DREX_WEAPON_MICRO_PROJECTION_SCHEMA} from './models/local-micro.js';
import {DREX_CAPPED_TIMING_PROVIDER_INPUT_PROFILE,DREX_TIMING_PROVIDER_INPUT_PROFILE} from './models/local-path-micro.js';
import {NACE_PROVIDER} from './models/nace-decisions.js';
import {createCombatContext} from './models/combat-context.js';
import {timedProviderResult,PROVIDER_PROCESSING_CAP_MS} from './provider-clock.js';

function resultFields(result = {}) {
  return {
    input: result.input ?? null,
    raw_response: result.raw_response ?? null,
    timings: result.timings ?? null,
    usage: result.usage ?? null,
    backend_metadata: result.backend_metadata ?? null,
  };
}

export async function runAgent(options) {
  const {advisor = options.model.advisor, strategy = options.model.strategy, onAuxiliaryEvent = options.onEvent ?? (() => {})} = options;
  try {
    return await runAgentLoop({...options, advisor, strategy, onAuxiliaryEvent});
  } finally {
    await Promise.all([advisor?.finish(onAuxiliaryEvent),strategy?.finish(onAuxiliaryEvent)]);
  }
}

async function runAgentLoop({ observe, submit, model, signal, hitsAtTick, onEvent = () => {},
  advisor, strategy, onAuxiliaryEvent, actionProfile, visualProfile = 'none-v1', prepareImage, prepareLocalMicroImage, compensationMs = 0, currentCompensation, onRequestStart, onRequestEnd, providerClock, executedMovement }) {
  const compensationBudget = currentCompensation ?? (() => compensationMs);
  requestLatency(null, compensationBudget());
  if ((currentCompensation || compensationMs > 0) &&
      (typeof onRequestStart !== 'function' || typeof onRequestEnd !== 'function')) {
    throw new TypeError('Link compensation requires both request lifecycle hooks');
  }
  const slots = actionProfile === RESEARCH_SLOTS_PROFILE;
  const coverage = actionProfile === RESEARCH_COVERAGE_SEQUENCE_PROFILE;
  const sequence = slots || coverage || actionProfile === SEQUENCE_ACTION_PROFILE;
  const coverageValidator = researchPlanValidator(RESEARCH_COVERAGE_SEQUENCE_PROFILE);
  const validPlan = slots ? validSlotPlan : coverage
    ? (ids, candidates) => coverageValidator(ids?.[0], ids) &&
        ids.every(id => candidates.some(candidate => candidate.id === id))
    : validActionSequence;
  if (model.config?.slot_sample) throw new TypeError('Frozen slot sampling cannot control a live game');
  const usesImage = visualProfile !== 'none-v1';
  const usesScene = usesImage && visualProfile !== TRAJECTORY_PROFILE;
  if (!EVIDENCE_VISUAL_PROFILES.includes(visualProfile) || (usesImage && typeof prepareImage !== 'function')) {
    throw new TypeError('Visual profiles require a matching image preparation callback');
  }
  let restoredStrategyReported = false;
  let lastTick = -1;
  let repeatFrame = false;
  let microPhase = 1;
  const cappedTiming=model.config?.provider_input_profile===DREX_CAPPED_TIMING_PROVIDER_INPUT_PROFILE;
  const timingAware=cappedTiming||model.config?.provider_input_profile===DREX_TIMING_PROVIDER_INPUT_PROFILE;
  const microProcessing=[];
  function microEstimate(){
    if(!microProcessing.length)return null;
    const sorted=microProcessing.toSorted((a,b)=>a-b);
    const count=sorted.length;
    const low=sorted[Math.floor((count-1)/2)],high=sorted[Math.floor(count/2)];
    return {median_ms:low+(high-low)/2,count,min_ms:sorted[0],max_ms:sorted.at(-1)};
  }
  let attempts = 0;
  let applied = 0;
  const startedAt = researchNow();

  while (!signal?.aborted) {
    let sample;
    const observeStartedAt = researchNow();
    try {
      sample = await observe({ after_tick: repeatFrame ? lastTick-1 : lastTick, signal, ...(usesScene && { include_visual_frame: true }) });
    } catch (error) {
      const cancelled = signal?.aborted;
      await onEvent({
        type: 'model:observe_failed', ...(providerClock && {timing_clock:'provider-processing'}), after_tick: lastTick, at_ms: researchNow(),
        status: cancelled ? 'cancelled' : 'environment_error',
        decision_timing: decisionTiming({
          observation: observationTiming(error, observeStartedAt, researchNow()),
          visualStatus: usesImage ? 'not_started' : 'not_applicable', modelStatus: 'not_started', actionStatus: 'not_sent',
        }),
      });
      if (cancelled) break;
      throw error;
    }
    const sampleTiming = observationTiming(sample, observeStartedAt, researchNow());
    const { observation:publicObservation, candidates, terminal } = sample;
    const observation=withoutWeaponState(publicObservation);
    const microObservation=model.config?.local_projection_schema===DREX_WEAPON_MICRO_PROJECTION_SCHEMA &&
      !observation?.upgrade_offer ? publicObservation : observation;
    if (signal?.aborted || terminal || observation?.terminal) break;
    if (!Number.isSafeInteger(observation?.tick) || observation.tick < lastTick ||
        observation.tick === lastTick && !repeatFrame) {
      throw new Error('Research worker did not return a newer observation');
    }
    const observationId = observation.observation_id ?? observation.id;
    if (typeof observationId !== 'string' || !Array.isArray(candidates) || !candidates.length) {
      throw new Error('Research worker returned an invalid observation or candidate list');
    }
    const estimateStarted=timingAware?researchNow():null;
    const recentMicroProcessing=timingAware?microEstimate():null;
    const estimateMs=timingAware?elapsed(estimateStarted,researchNow()):0;
    lastTick = observation.tick;
    repeatFrame = false;
    attempts++;
    const decision = {
      observation_id: observationId,
      observation_tick: lastTick,
      decision_id: crypto.randomUUID(),
      ...((visualProfile === STRUCTURED_TRAIL_PROFILE || model.prepareLocalMicro) && observation.upgrade_offer && {visual_upgrade_offer: true}),
      sampled_at_ms: observation.sampled_at_ms ?? observation.sampled_at_server_ms ?? null,
      projected_at_ms: observation.projected_at_ms ?? observation.projection_completed_at_ms ?? null,
    };
    const emit = (type, detail = {}) => onEvent({ type, ...decision,
      ...(providerClock && {timing_clock:'provider-processing'}), at_ms: researchNow(), ...detail });
    let feedback = advisor && model.actionApplied ? {hitsTaken: hitsAtTick(observation.tick)} : {};
    const strategyHint = strategy?.observe({observation, frame:sample.visual_frame, hitsTaken:hitsAtTick(observation.tick), emit:onAuxiliaryEvent});
    if (strategyHint && !restoredStrategyReported && strategyHint.accepted_tick <= observation.tick) {
      const restored = strategy.exportState().restored;
      if (restored) onAuxiliaryEvent({type:'strategy:restored',at_ms:researchNow(),run_id:observation.run_id,observation_tick:observation.tick,strategy:strategyHint});
      restoredStrategyReported=true;
    }
    const advisorHint = advisor?.observe({observation, frame: sample.visual_frame, ...feedback, emit: onAuxiliaryEvent});
    await emit('model:observation', { candidate_count: candidates.length });
    let image;
    let visual;
    if (usesImage) {
      const effectiveProfile = visualProfile === STRUCTURED_TRAIL_PROFILE && observation.upgrade_offer
        ? 'structured-v1' : visualProfile;
      const timingProfile = visualProfile === STRUCTURED_TRAIL_PROFILE && {effective_profile: effectiveProfile};
      const prepareStartedAt = researchNow();
      let preparation;
      let validationMs = null;
      try {
        const frame = sample.visual_frame;
        if (usesScene && frame?.tick !== observation.tick) {
          throw new ResearchModelError('visual_frame_mismatch', 'Visual frame does not match the observation tick');
        }
        signal?.throwIfAborted();
        preparation = await prepareImage({ visual_frame: frame, observation, profile: effectiveProfile, signal });
        const candidateImage = preparation?.image ?? preparation;
        const validationStarted = researchNow();
        try { visual = validateVisualImage(candidateImage, observation.tick, effectiveProfile); }
        finally { validationMs = elapsed(validationStarted, researchNow()); }
        image = candidateImage;
        signal?.throwIfAborted();
      } catch (error) {
        const visualStatus = signal?.aborted ? 'cancelled' : 'failed';
        visual = { profile: effectiveProfile, tick: observation.tick, ...visual, ...timingProfile,
          ...visualTiming(preparation, prepareStartedAt, researchNow(), validationMs) };
        await emit('model:attempt', {
          ...resultFields(),
          status: signal?.aborted ? 'cancelled' : 'visual_error',
          error: { code: signal?.aborted ? 'cancelled' : error instanceof ResearchModelError ? error.code : 'visual_capture_failed',
            message: signal?.aborted ? 'Image preparation cancelled' : 'Could not prepare a valid image for this observation' },
          request_started_at_ms: null,
          request_finished_at_ms: null,
          request_latency: requestLatency(null, compensationBudget()),
          compensation_receipt: null,
          visual,
          decision_timing: decisionTiming({ observation: sampleTiming, visual, visualStatus,
            modelStatus: 'not_started', actionStatus: 'not_sent' }),
          ...(image && { image }),
        });
        continue;
      }
      Object.assign(visual, timingProfile, visualTiming(preparation, prepareStartedAt, researchNow(), validationMs));
      if (model.prepareLocalMicro) {
        visual.capture_id=preparation?.capture_id ?? `structured-v1:${observation.tick}`;
        visual.shared_with_micro=Boolean(observation.upgrade_offer);
      }
    }
    if (!model.prepareLocalMicro || observation.upgrade_offer) await emit('model:request');
    const budget = compensationBudget();
    if (!advisor && model.actionApplied) feedback = {hitsTaken: hitsAtTick(observation.tick)};
    const combat_context=model.config?.combat_context_schema && providerClock
      ? createCombatContext({observation:publicObservation,frame:sample.visual_frame,providerProcessingCapMs:PROVIDER_PROCESSING_CAP_MS}) : undefined;
    strategy?.dispatch({observation,image,visual,signal,emit:onAuxiliaryEvent,providerClock,combat_context});
    if (advisor) advisor.dispatch({actionProfile, observation, candidates, image, visual, budget,
      directionObservation: model.directionObservation({observation, ...feedback}), signal,
      ...(strategyHint && {strategy:strategyHint}),...(combat_context && {combat_context}),
      ...(model.config?.control_brief_mode&&{control_brief_mode:model.config.control_brief_mode}),emit:onAuxiliaryEvent,providerClock});
    let localFields;
    let providerProfile;
    if (model.prepareLocalMicro && !observation.upgrade_offer) {
      const projectionStarted=researchNow();
      let localStarted=projectionStarted, projectionMs=null;
      try {
        if (typeof prepareLocalMicroImage !== 'function') throw new Error('Local image callback missing');
        localFields=model.prepareLocalMicro({observation:microObservation,frame:sample.visual_frame,advisorHint});
        if (providerClock && timingAware) {
          const movement=executedMovement(observation,{includeRemainingPlan:true});
          providerProfile={phase:microPhase,...movement,recent_micro_processing:recentMicroProcessing,
            ...(cappedTiming&&{provider_processing_cap_ms:PROVIDER_PROCESSING_CAP_MS}),
            ...(model.config?.control_brief_mode&&{brief_mode:model.config.control_brief_mode})};
        }
        localStarted=researchNow();
        projectionMs=elapsed(projectionStarted,localStarted)+estimateMs;
        const prepared=await prepareLocalMicroImage({projection:localFields.local_projection,signal});
        image=prepared?.image ?? prepared;
        if (providerClock) {
          if(!timingAware)providerProfile={phase:microPhase,interval:executedMovement(observation)};
          microPhase=(microPhase+1)%4;
        }
        const validationStarted=researchNow();
        visual=validateVisualImage(image,observation.tick,'local-micro-v1');
        Object.assign(visual,visualTiming(prepared,localStarted,researchNow(),elapsed(validationStarted,researchNow())));
        visual.capture_id=prepared?.capture_id ?? `local-micro-v1:${observation.tick}`;
        visual.projection_ms=projectionMs;
        signal?.throwIfAborted();
      } catch (error) {
        await emit('model:attempt',{...resultFields(),status:signal?.aborted?'cancelled':'visual_error',
          error:{code:'local_image_failed',message:'Could not prepare the local micro image'},
          visual:{profile:'local-micro-v1',tick:observation.tick,projection_ms:projectionMs,prepare_started_at_ms:localStarted,prepare_finished_at_ms:researchNow()},
          request_started_at_ms:null,request_finished_at_ms:null,request_latency:requestLatency(null,budget),
          compensation_receipt:null,backend_metadata:{upstream_dispatched:false},
          decision_timing:decisionTiming({observation:sampleTiming,visualStatus:signal?.aborted?'cancelled':'failed',modelStatus:'not_started',actionStatus:'not_sent'})});
        continue;
      }
    }
    if (model.prepareLocalMicro && !observation.upgrade_offer) await emit('model:request');
    const visualEvidence = image ? {image,visual} : {};
    const visualStatus = image ? 'completed' : 'not_applicable';
    let requestStartedAt = null;
    let requestFinishedAt = null;
    let result;
    let modelError;
    let modelFailed = false;
    let hookError;
    let compensationReceipt = null;
    const hookContext = {
      decision_id: decision.decision_id, observation_id: observationId, observation_tick: lastTick, budget_ms: budget,
    };
    let beginAttempted = false;
    try {
      signal?.throwIfAborted();
      if (budget > 0) {
        beginAttempted = true;
        try { await onRequestStart(hookContext); }
        catch (error) {
          // The Worker rejects a begin after its terminal event. No pause exists to release.
          if (signal?.aborted && error?.code === 'terminal') beginAttempted = false;
          else hookError = error;
          throw error;
        }
      }
      signal?.throwIfAborted();
      requestStartedAt = researchNow();
      try {
        if (advisorHint) onAuxiliaryEvent({type: 'advisor:used', at_ms: requestStartedAt,
          run_id: observation.run_id, decision_id: decision.decision_id, observation_id: observationId,
          observation_tick: lastTick, guidance_id: advisorHint.guidance_id, hint: advisorHint});
        result = await timedProviderResult(providerClock, {
          id: decision.decision_id, role: observation.upgrade_offer ? 'upgrade' : 'micro',
          ...(observation.upgrade_offer&&{provider:model.config?.upgrade_provider}),observation,signal,
        }, () => model.decide({ observation:microObservation, candidates, signal, ...feedback, ...(image && { image }),
          ...(advisorHint && {advisorHint}), ...(localFields ?? {}), ...(providerProfile && {provider_profile:providerProfile}),
          ...(sequence && { action_profile: actionProfile }) }));
      } finally {
        requestFinishedAt = researchNow();
      }
      if (signal?.aborted) throw new ResearchModelError('cancelled', 'Model request cancelled', result);
      if (!candidates.some(candidate => candidate.id === result?.action_id)) {
        throw new ResearchModelError('invalid_action', 'Model selected an action outside the candidate list', result);
      }
      if (sequence && (!validPlan(result.action_ids, candidates) || result.action_ids[0] !== result.action_id)) {
        throw new ResearchModelError('invalid_action_sequence', 'Model returned an invalid ordered plan', result);
      }
    } catch (error) {
      modelError = error;
      modelFailed = true;
    } finally {
      if (beginAttempted) {
        try {
          compensationReceipt = await onRequestEnd({ ...hookContext,
            reason: signal?.aborted ? 'cancelled' : modelFailed ? 'failed' : 'completed' });
        } catch (error) {
          hookError ??= error;
        }
      }
    }
    const latency = requestLatency(elapsed(requestStartedAt, requestFinishedAt), budget);
    const compensationEvidence = { request_latency: latency, compensation_receipt: compensationReceipt };
    if (modelFailed || hookError) {
      const known = modelError instanceof ResearchModelError;
      const modelFields = resultFields(known ? modelError.details : result);
      await emit('model:attempt', {
        ...modelFields,
        ...visualEvidence,
        ...compensationEvidence,
        status: hookError ? 'environment_error' : signal?.aborted || providerClock?.snapshot().terminal ? 'cancelled' : 'model_error',
        error: hookError ? { code: hookError.code ?? 'latency_compensation_error', message: hookError.message }
          : { code: signal?.aborted ? 'cancelled' : known ? modelError.code : 'model_unavailable',
            message: signal?.aborted ? 'Model request cancelled' : known ? modelError.message : 'Model request failed' },
        request_started_at_ms: requestStartedAt,
        request_finished_at_ms: requestFinishedAt,
        decision_timing: decisionTiming({ observation: sampleTiming, visual, visualStatus,
          model: { ...modelFields, started_at_ms: requestStartedAt, finished_at_ms: requestFinishedAt },
          modelStatus: requestStartedAt === null ? 'not_started' : signal?.aborted ? 'cancelled'
            : modelFailed ? 'failed' : 'completed',
          actionStatus: 'not_sent' }),
      });
      if (hookError) throw hookError;
      continue;
    }
    if(timingAware&&!observation.upgrade_offer){
      const metadata=result.backend_metadata;
      const measured=metadata?.upstream_nace_evaluation_time_ms;
      if(metadata?.provider===NACE_PROVIDER&&metadata.upstream_status===200&&Number.isFinite(measured)&&measured>=0){
        microProcessing.push(cappedTiming?Math.min(measured,PROVIDER_PROCESSING_CAP_MS):measured);
        if(microProcessing.length>5)microProcessing.shift();
      }
    }
    const selected = {
      action_id: result.action_id, ...(sequence && { action_ids: result.action_ids }),
    };
    await emit('model:response', selected);
    function recordApplied(ack) {
      applied++;
      model.actionApplied?.({observation, result, appliedTick: ack.applied_tick, advisorHint, ...feedback});
      if (!observation.upgrade_offer) {
        const receipt={decision_id:decision.decision_id,applied_tick:ack.applied_tick,action_id:selected.action_id};
        advisor?.recordAction(receipt);
        strategy?.recordAction(receipt);
      }
    }
    let ack = null;
    let submitError = null;
    let submittedAt = null;
    let ackReturnedAt = null;
    if (!signal?.aborted) {
      await emit('model:submit', selected);
      if (!signal?.aborted) {
        submittedAt = researchNow();
        try {
          ack = await submit({ observation_id: observationId, decision_id: decision.decision_id, ...selected, signal,
            ...(providerClock && {onDeferredApplied:recordApplied}) });
          ackReturnedAt = researchNow();
        } catch (error) {
          submitError = error;
        }
      }
    }
    const rejected = typeof ack?.error?.code === 'string';
    const identity = { observation_id: observationId, observation_tick: lastTick, decision_id: decision.decision_id, action_id: result.action_id };
    const sequenceMatches = !sequence || (Array.isArray(ack?.action_ids) &&
      ack.action_ids.length === selected.action_ids.length &&
      selected.action_ids.every((id, index) => ack.action_ids[index] === id));
    const accepted = sequenceMatches && Number.isSafeInteger(ack?.applied_tick) && ack.applied_tick > lastTick && !ack.error && ack.ok !== false &&
      Object.entries(identity).every(([key, value]) => !Object.hasOwn(ack, key) || ack[key] === value);
    const deferred = Boolean(providerClock && ack?.clock_deferred);
    if (submittedAt !== null && !accepted && !rejected && !deferred) {
      submitError ??= new Error('Research worker action acknowledgement was missing or inconsistent');
    }
    const status = accepted ? 'applied' : deferred ? 'deferred'
      : signal?.aborted || providerClock && ack?.error?.code === 'terminal' ? 'cancelled'
      : rejected ? 'rejected' : 'environment_error';
    if (accepted) recordApplied(ack);
    repeatFrame = deferred;
    await emit('model:attempt', {
      ...resultFields(result),
      ...visualEvidence,
      ...compensationEvidence,
      status,
      ...selected,
      request_started_at_ms: requestStartedAt,
      request_finished_at_ms: requestFinishedAt,
      submitted_at_ms: submittedAt,
      applied_tick: accepted ? ack.applied_tick : null,
      applied_at_ms: accepted ? ack.applied_at_ms ?? null : null,
      ack,
      decision_timing: decisionTiming({ observation: sampleTiming, visual, visualStatus,
        model: { ...result, started_at_ms: requestStartedAt, finished_at_ms: requestFinishedAt },
        modelStatus: 'completed',
        action: { sent_at_ms: submittedAt, ack_returned_at_ms: ackReturnedAt, ack, workerClock:providerClock ? 'virtual' : 'wall' },
        actionStatus: submittedAt === null || deferred ? 'not_sent' : status }),
      error: rejected ? ack.error : status === 'cancelled' ? { code: 'cancelled', message: 'Action submission cancelled' }
        : submitError ? { code: 'environment_error', message: 'Research worker action acknowledgement failed' } : null,
    });
    if (submitError && !signal?.aborted) throw submitError;
  }

  return { attempts, applied, started_at_ms: startedAt, finished_at_ms: researchNow() };
}

function visualTiming(preparation, startedAt, finishedAt, validationMs) {
  return {
    prepare_started_at_ms: startedAt,
    prepare_finished_at_ms: finishedAt,
    prepare_elapsed_ms: finishedAt - startedAt,
    validation_ms: validationMs,
    render_ms: Number.isFinite(preparation?.render_ms) ? preparation.render_ms : null,
    encode_ms: Number.isFinite(preparation?.encode_ms) ? preparation.encode_ms : null,
    jpeg_quality: Number.isFinite(preparation?.jpeg_quality) ? preparation.jpeg_quality : null,
    ...(typeof preparation?.capture_id === 'string' && {capture_id:preparation.capture_id}),
  };
}

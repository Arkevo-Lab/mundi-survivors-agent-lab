import {STRATEGY_REFRESH_TICKS, parseStrategy} from './action-strategy.js';
import {researchNow} from './common.js';
import {STRATEGY_CONFIG} from './strategy.js';
import {timedProviderResult} from '../provider-clock.js';

// Runs asynchronously alongside the advisor and the movement model.
export function createStrategyScheduler({memory, advise, config=STRATEGY_CONFIG, restore=null, now=researchNow, id=()=>crypto.randomUUID()}) {
  let active=restore?.active ? structuredClone(restore.active) : null;
  let nextTick=restore?.nextTick ?? 0, pending=null, open=true;
  let lastStatus=restore?.lastStatus ?? null;
  function current(tick) {
    if (!active || !Number.isSafeInteger(tick) || tick < active.accepted_tick) return null;
    return {...structuredClone(active),age_ticks:tick-active.source_tick};
  }
  function settle(observation,emit) {
    const row=pending;
    if (row?.finished === undefined) return;
    let status='accepted', strategy=null;
    try {
      if (row.error) status=row.controller.signal.aborted ? 'cancelled' : ['cancelled','timeout','provider_refusal'].includes(row.error.code) ? row.error.code : 'failed';
      else strategy=parseStrategy(row.result?.strategy_json ?? row.result?.content ?? '');
    } catch {status='invalid';}
    const tick=observation.tick;
    if (status==='accepted') {
      active={strategy_id:row.id,source_tick:row.observation.tick,accepted_tick:tick,strategy};
      emit({type:'strategy:published',at_ms:now(),run_id:observation.run_id,decision_id:row.id,
        source_tick:row.observation.tick,accepted_tick:tick,strategy});
    }
    lastStatus=status;
    emit({type:'strategy:attempt',at_ms:now(),run_id:observation.run_id,decision_id:row.id,
      observation_id:row.observation.observation_id,observation_tick:row.observation.tick,
      sampled_at_ms:row.observation.sampled_at_ms,resolved_tick:tick,request_started_at_ms:row.started,request_finished_at_ms:row.finished,
      image:row.image,visual:row.visual && {...row.visual,shared_with_micro:row.visual?.shared_with_micro ?? true},
      memory_timing:{snapshot_ms:row.historyMs},timings:row.result?.timings ?? row.error?.details?.timings ?? null,
      request_latency:{raw_request_ms:Math.max(0,row.finished-row.started),estimated_adjusted_request_ms:null,link_compensation_ms:0},status,
      input:row.result?.input ?? row.error?.details?.input ?? null,
      raw_response:row.result?.raw_response ?? row.error?.details?.raw_response ?? null,
      usage:row.result?.usage ?? row.error?.details?.usage ?? null,
      backend_metadata:row.result?.backend_metadata ?? row.error?.details?.backend_metadata ?? null,
      error:row.error ? {code:row.error.code ?? 'model_error'} : null});
    pending=null;
  }
  return {
    config,
    observe({observation,frame,hitsTaken,emit}) {
      if (!open || !memory.observe({observation,frame,hitsTaken})) return null;
      settle(observation,emit);
      return current(observation.tick);
    },
    dispatch({observation,image,visual,signal,emit,providerClock,combat_context}) {
      if (!open || pending || observation?.terminal || signal?.aborted || observation.tick<nextTick ||
          image?.tick!==observation.tick || image?.mime_type!=='image/png') return false;
      const historyStarted=now();
      const history=memory.snapshot();
      const historyMs=now()-historyStarted;
      if (!history || history.to_tick!==observation.tick || history.run_id!==observation.run_id) return false;
      const controller=new AbortController();
      const row={id:id(),observation:structuredClone(observation),image,visual,historyMs,controller,started:now()};
      pending=row; nextTick=observation.tick+STRATEGY_REFRESH_TICKS;
      emit({type:'strategy:requested',at_ms:now(),run_id:observation.run_id,decision_id:row.id,
        observation_id:observation.observation_id,observation_tick:observation.tick,
        sampled_at_ms:observation.sampled_at_ms,request_started_at_ms:row.started});
      const requestSignal=signal ? AbortSignal.any([signal,controller.signal]) : controller.signal;
      row.settled=Promise.resolve().then(()=>timedProviderResult(providerClock,
        {id:row.id,role:'strategy',observation,signal:requestSignal},
        ()=>advise({observation,image,visual,history,prior_strategy:current(observation.tick),combat_context,signal:requestSignal}))).then(
        result=>{row.result=result;row.finished=now();},error=>{row.error=error;row.finished=now();});
      return true;
    },
    current,
    recordAction:receipt=>memory.recordAction(receipt),
    exportState() {return structuredClone({active,nextTick,lastStatus,memory_state:memory.exportState(),inflight_discarded:Boolean(pending),restored:Boolean(restore?.active)});},
    async finish(emit) {
      open=false;
      const row=pending;
      if (!row) return;
      row.controller.abort();
      if (row.finished === undefined) {let timer; await Promise.race([row.settled,new Promise(resolve=>{timer=setTimeout(resolve,75);})]);clearTimeout(timer);}
      if (pending!==row) return;
      row.finished ??= now();
      row.error ??= {code:'cancelled'};
      const snap=memory.snapshot();
      settle({run_id:row.observation.run_id,tick:snap?.to_tick ?? row.observation.tick},emit);
    },
  };
}

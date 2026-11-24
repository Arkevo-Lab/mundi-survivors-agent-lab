import {NACE_PROVIDER} from './models/nace-decisions.js';
import {TICK_HZ} from '../../shared/survivors-research-contract.js';

export const providerClockMode='provider-processing-only-v1';
export const PROVIDER_PROCESSING_CAP_MS=300;
const scale=TICK_HZ/1000;
const epsilon=1e-8;
const wall=()=>performance.timeOrigin+performance.now();
const actionRole=role=>role==='micro'||role==='upgrade';
const usesNace=(role,provider)=>role==='micro'||(role==='advisor'||role==='upgrade')&&provider===NACE_PROVIDER;
function processingEvidence(row) {
  return {
    provider_processing_ms:row.processing??null,
    effective_provider_processing_ms:row.effectiveProcessing??null,
    provider_model_compensated_ms:row.processing===undefined?null:row.processing-row.effectiveProcessing,
  };
}

// One gate per playtest page. A queued request has not entered the model deadline.
export function createPacedNaceAdmission(intervalMs=750) {
  const queue=[];
  let next=0,timer;
  function drain(){
    clearTimeout(timer);
    timer=undefined;
    if(!queue.length)return;
    const wait=next-performance.now();
    if(wait>0){timer=setTimeout(drain,Math.ceil(wait));return;}
    const request=queue.shift();
    request.signal?.removeEventListener('abort',request.abort);
    next=performance.now()+intervalMs;
    try{request.resolve(request.load());}catch(error){request.reject(error);}
    drain();
  }
  return ({role,provider,signal},load)=>{
    if(!usesNace(role,provider))return load();
    signal?.throwIfAborted();
    return new Promise((resolve,reject)=>{
      const request={resolve,reject,signal,load,abort(){
        queue.splice(queue.indexOf(request),1);
        reject(signal.reason);
        drain();
      }};
      signal?.addEventListener('abort',request.abort,{once:true});
      queue.push(request);
      drain();
    });
  };
}

// A terminal event can invalidate cached responses while the Worker is stepping.
export function createProviderClock({step, trace=()=>{}, fatal=()=>{}, admission}) {
  let virtualMs=0, frame=0, serial=0, terminal=false, draining=false, command=null, heldAction=null;
  const pending=new Map();
  const snapshot=()=>({provider_processing_cap_ms:PROVIDER_PROCESSING_CAP_MS,virtual_ms:virtualMs,frame,exact_fractional_tick:virtualMs*scale,
    frame_quantization_ticks:frame-virtualMs*scale,terminal,pending:pending.size});
  function end() {
    if(terminal)return;
    terminal=true;
    heldAction=null;
    for(const row of [...pending.values()])cancel(row);
  }
  function cancel(row) {
    if(!pending.delete(row.id))return;
    row.signal?.removeEventListener('abort',row.abort);
    row.admissionController?.abort();
    trace({type:'provider_clock:cancelled',...snapshot(),id:row.id,role:row.role,at_wall_ms:wall(),
      ...processingEvidence(row),ready_virtual_ms:row.ready??null});
    row.reject(row.signal?.reason??new DOMException('研究运行已结束','AbortError'));
  }
  function fail(error) {
    if(terminal)return;
    trace({type:'provider_clock:failure',...snapshot(),message:error.message,at_wall_ms:wall()});
    end();
    fatal(error);
  }
  async function advance(to) {
    if(to<=frame||terminal)return;
    const before=frame;
    const held=heldAction;
    heldAction=null;
    const out=await step(to,held);
    if(!Number.isInteger(out.relative_tick)||out.relative_tick<before||out.relative_tick>to||
      (!out.terminal&&out.relative_tick!==to))throw new Error('供应商时钟 Worker 帧回执无效');
    frame=out.relative_tick;
    trace({type:'provider_clock:step',...snapshot(),from_frame:before,target_frame:to,at_wall_ms:wall()});
    if(out.terminal)end();
  }
  function publish(row) {
    pending.delete(row.id);
    row.signal?.removeEventListener('abort',row.abort);
    trace({type:'provider_clock:publish',...snapshot(),id:row.id,role:row.role,
      dispatch_virtual_ms:row.dispatched,ready_virtual_ms:row.ready,...processingEvidence(row),
      provider_field:row.metadata.reported_field,raw_upstream_ms:row.metadata.raw_upstream_ms,
      actual_wall_request_ms:row.realSettled-row.realDispatched,
      wall_minus_reported_ms:row.realSettled-row.realDispatched-row.processing,
      at_wall_ms:wall()});
    row.resolve(row.packet);
  }
  async function drain(main) {
    if(draining||command||terminal)throw new Error('供应商时钟收到重叠的主动作请求');
    draining=true;
    try{
      // Let the two schedulers register requests from the same observation
      // before freezing the batch, including a foreground upgrade.
      await Promise.resolve();
      await Promise.all([...pending.values()].map(row=>row.finished));
      if(terminal||!pending.has(main.id))return;
      const actionFrame=Math.ceil(main.ready*scale-epsilon);
      if(actionFrame<frame)throw new Error('供应商处理时间不能回退物理帧');
      const auxiliaries=[...pending.values()].filter(row=>row!==main&&row.ready<=main.ready)
        .sort((a,b)=>a.ready-b.ready||a.order-b.order);
      for(const row of auxiliaries){
        if(!pending.has(row.id))continue;
        virtualMs=Math.max(virtualMs,row.ready);
        await advance(Math.min(actionFrame-1,Math.floor(virtualMs*scale+epsilon)));
        if(terminal)return;
        publish(row);
      }
      virtualMs=main.ready;
      await advance(actionFrame-1);
      if(terminal)return;
      command={id:main.id,target:actionFrame,sampleTick:main.sampleTick,timing:processingEvidence(main)};
      publish(main);
    }finally{draining=false;}
  }
  function request({id,role,provider,observation,sampleTick,signal,load}) {
    if(terminal)return Promise.reject(new DOMException('研究运行已结束','AbortError'));
    signal?.throwIfAborted();
    if(typeof id!=='string'||pending.has(id)||!['micro','upgrade','advisor','strategy'].includes(role))
      return Promise.reject(new Error('供应商时钟请求标识无效'));
    return new Promise((resolve,reject)=>{
      const admissionController=admission?new AbortController():null;
      const admissionSignal=admissionController&&(signal?AbortSignal.any([signal,admissionController.signal]):admissionController.signal);
      const row={id,role,sampleTick,signal,admissionController,resolve,reject,dispatched:virtualMs,realDispatched:wall(),order:serial++};
      row.abort=()=>{cancel(row);if(actionRole(role)&&!terminal)fail(new Error('主动作请求在计时完成前取消'));};
      pending.set(id,row);
      signal?.addEventListener('abort',row.abort,{once:true});
      trace({type:'provider_clock:dispatch',...snapshot(),id,role,sample_tick:sampleTick,at_wall_ms:row.realDispatched});
      row.finished=Promise.resolve().then(()=>
        admission?admission({id,role,provider,observation,signal:admissionSignal},()=>{
          admissionSignal.throwIfAborted();
          trace({type:'provider_clock:admission',...snapshot(),id,role,at_wall_ms:wall(),
            wait_ms:wall()-row.realDispatched});
          return load();
        }):load()).then(packet=>{
        if(!pending.has(id)||terminal)return;
        const timing=packet?.value?.backend_metadata?.r120_timing;
        const field=usesNace(role,provider)?'evaluation_time_ms':'openai-processing-ms';
        if(packet?.status!==200||timing?.reported_field!==field||
          !Number.isFinite(timing.provider_reported_ms)||timing.provider_reported_ms<0)
          throw new Error('缺少 '+role+' 的供应商处理时间，已停止本次计时');
        row.metadata=timing;
        row.processing=timing.provider_reported_ms;
        row.effectiveProcessing=Math.min(row.processing,PROVIDER_PROCESSING_CAP_MS);
        row.ready=row.dispatched+row.effectiveProcessing;
        row.realSettled=wall();
        row.packet=packet;
        trace({type:'provider_clock:reported',...snapshot(),id,role,provider_field:field,
          dispatch_virtual_ms:row.dispatched,ready_virtual_ms:row.ready,...processingEvidence(row),
          raw_upstream_ms:timing.raw_upstream_ms,at_wall_ms:row.realSettled});
      }).catch(error=>{
        if(!pending.has(id)||terminal)return;
        if(actionRole(role)){
          fail(error);
          return;
        }
        pending.delete(id);
        row.signal?.removeEventListener('abort',row.abort);
        trace({type:'provider_clock:auxiliary_failed',...snapshot(),id,role,at_wall_ms:wall(),
          ...processingEvidence(row),ready_virtual_ms:null,
          error:{code:error?.code??'model_unavailable',message:error?.message??String(error)}});
        row.reject(error);
      });
      if(actionRole(role))void drain(row).catch(fail);
    });
  }
  async function acknowledge(action,submit) {
    const id=action.decision_id;
    if(!command||command.id!==id||terminal)throw new Error('主动作未到达供应商时钟应用边界');
    const {target,sampleTick,timing}=command;
    try {
      if (target === frame) {
        trace({type:'provider_clock:action_deferred',...snapshot(),id,sample_tick:sampleTick,
          replaced_decision_id:heldAction?.decision_id ?? null,...timing,at_wall_ms:wall()});
        heldAction=action;
        return {clock_deferred:true};
      }
      if (heldAction) {
        trace({type:'provider_clock:action_superseded',...snapshot(),id:heldAction.decision_id,
          replacing_decision_id:id,at_wall_ms:wall()});
        heldAction=null;
      }
      const result=submit(action);
      const [ack]=await Promise.all([result,advance(target)]);
      trace({type:'provider_clock:action_boundary',...snapshot(),id,sample_tick:sampleTick,
        action_boundary_frame:target,...timing,at_wall_ms:wall()});
      return ack;
    } finally {command=null;}
  }
  return {request,acknowledge,end,snapshot,fail};
}


// Wall-time request deadlines belong inside load. Once it has returned and
// validated, clock publication observes only the run's cancellation signal.
export function timedProviderResult(clock, {id, role, provider, observation, signal}, load) {
  if (!clock) return load();
  return clock.request({id,role,provider,observation,sampleTick:observation.tick,signal,async load() {
    const result = await load();
    const metadata = result.backend_metadata;
    const nace = usesNace(role,provider);
    return {status:200,value:{
      result,
      backend_metadata:{r120_timing:{
        reported_field:nace ? 'evaluation_time_ms' : 'openai-processing-ms',
        provider_reported_ms:nace ? metadata?.upstream_nace_evaluation_time_ms : metadata?.upstream_openai_processing_ms,
        raw_upstream_ms:metadata?.upstream_round_trip_ms ?? null
      }}
    }};
  }}).then(packet => packet.value.result);
}

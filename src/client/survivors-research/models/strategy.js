import {ResearchModelError,researchNow} from './common.js';
import {parseStrategy,STRATEGY_TRANSITION_INPUT_SCHEMA,STRATEGY_TRANSITION_PROMPT_VERSION,STRATEGY_COMBAT_INPUT_SCHEMA,STRATEGY_COMBAT_PROMPT_VERSION,STRATEGY_BRIEF_INPUT_SCHEMA,STRATEGY_BRIEF_PROMPT_VERSION,STRATEGY_SHARED_INPUT_SCHEMA,STRATEGY_SHARED_PROMPT_VERSION,STRATEGY_TACTICS_INPUT_SCHEMA,STRATEGY_TACTICS_PROMPT_VERSION} from './action-strategy.js';
import {STRATEGY_MODEL,STRATEGY_REASONING_EFFORT,STRATEGY_MAX_COMPLETION_TOKENS,
  STRATEGY_SERVER_TIMEOUT_MS,STRATEGY_CLIENT_TIMEOUT_MS} from './strategy-config.js';

export const STRATEGY_CONFIG=Object.freeze({mode:'chat-strategy-v1',model:STRATEGY_MODEL,
  generation_profile:'openai-chat-completions-v1',reasoning_effort:STRATEGY_REASONING_EFFORT,
  max_completion_tokens:STRATEGY_MAX_COMPLETION_TOKENS,server_timeout_ms:STRATEGY_SERVER_TIMEOUT_MS,
  interval_ticks:600,max_inflight:1,timeout_ms:STRATEGY_CLIENT_TIMEOUT_MS,prompt_version:'strategy-v1'});
export function createStrategist({transitionAware=false,combatAware=false,briefAware=false,sharedFactsAware=false,tacticsAware=false}={}) {
  const config=tacticsAware?{...STRATEGY_CONFIG,prompt_version:STRATEGY_TACTICS_PROMPT_VERSION,combat_context_schema:'survivors-combat-context-v1'}:
    sharedFactsAware?{...STRATEGY_CONFIG,prompt_version:STRATEGY_SHARED_PROMPT_VERSION,combat_context_schema:'survivors-combat-context-v1'}:
    briefAware?{...STRATEGY_CONFIG,prompt_version:STRATEGY_BRIEF_PROMPT_VERSION,combat_context_schema:'survivors-combat-context-v1'}:
    combatAware?{...STRATEGY_CONFIG,prompt_version:STRATEGY_COMBAT_PROMPT_VERSION,combat_context_schema:'survivors-combat-context-v1'}:
    transitionAware?{...STRATEGY_CONFIG,prompt_version:STRATEGY_TRANSITION_PROMPT_VERSION}:STRATEGY_CONFIG;
  return {config,async advise({observation,image,history,prior_strategy,combat_context,signal}) {
    const deadline=AbortSignal.timeout(STRATEGY_CONFIG.timeout_ms), timings={};
    let response,data;
    timings.input_serialize_started_at_ms=researchNow();
    const body=JSON.stringify({schema:tacticsAware?STRATEGY_TACTICS_INPUT_SCHEMA:sharedFactsAware?STRATEGY_SHARED_INPUT_SCHEMA:briefAware?STRATEGY_BRIEF_INPUT_SCHEMA:combatAware?STRATEGY_COMBAT_INPUT_SCHEMA:transitionAware?STRATEGY_TRANSITION_INPUT_SCHEMA:'survivors-strategy-input-v1',run_id:observation.run_id,
      tick:observation.tick,observation,image,history,prior_strategy,...((tacticsAware||sharedFactsAware||briefAware||combatAware)&&{combat_context})});
    timings.input_serialize_finished_at_ms=researchNow();
    timings.input_serialize_ms=timings.input_serialize_finished_at_ms-timings.input_serialize_started_at_ms;
    timings.transport_kind='browser_http';timings.transport_started_at_ms=researchNow();
    let responseText;
    try {
      response=await fetch('/api/survivors-research/model/strategy',{method:'POST',mode:'same-origin',
        headers:{'Content-Type':'application/json','X-Mundi-Local-Connection':'1'},body,
        signal:AbortSignal.any([signal,deadline])});
      responseText=await response.text();
    } catch {
      timings.transport_finished_at_ms=researchNow();
      throw new ResearchModelError(signal?.aborted?'cancelled':deadline.aborted?'timeout':'connection_unavailable',
        '战略层请求未完成',{timings});
    }
    timings.transport_finished_at_ms=researchNow();
    timings.response_decode_started_at_ms=researchNow();
    try {data=JSON.parse(responseText);} catch {throw new ResearchModelError('malformed','战略层响应格式无效',{timings});}
    finally {
      timings.response_decode_finished_at_ms=researchNow();
      timings.response_decode_ms=timings.response_decode_finished_at_ms-timings.response_decode_started_at_ms;
    }
    if (!response.ok) throw new ResearchModelError(data?.error?.code ?? 'model_unavailable',
      '战略层请求失败',{...data?.trace,timings});
    timings.output_parse_started_at_ms=researchNow();
    let content;
    try {
      let provider; try {provider=JSON.parse(data.raw_response);} catch {throw new ResearchModelError('malformed','战略层响应格式无效',{...data,timings});}
      const choice=provider?.choices?.[0];
      if (choice?.message?.refusal || choice?.finish_reason==='content_filter') throw new ResearchModelError('provider_refusal','战略层拒绝响应',{...data,timings});
      if (choice?.finish_reason==='length') throw new ResearchModelError('truncated','战略层响应不完整',{...data,timings});
      content=choice?.message?.content;
      try {parseStrategy(content);} catch {throw new ResearchModelError('malformed','战略层响应格式无效',{...data,timings});}
    } finally {
      timings.output_parse_finished_at_ms=researchNow();
      timings.output_parse_ms=timings.output_parse_finished_at_ms-timings.output_parse_started_at_ms;
    }
    return {...data,content,timings};
  }};
}

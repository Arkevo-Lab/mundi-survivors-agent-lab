import {strategyModelInput,STRATEGY_TRANSITION_INPUT_SCHEMA,STRATEGY_TRANSITION_PROMPT_VERSION,
  STRATEGY_COMBAT_INPUT_SCHEMA,STRATEGY_COMBAT_PROMPT_VERSION,
  STRATEGY_BRIEF_INPUT_SCHEMA,STRATEGY_BRIEF_PROMPT_VERSION,
  STRATEGY_SHARED_INPUT_SCHEMA,STRATEGY_SHARED_PROMPT_VERSION,
  STRATEGY_TACTICS_INPUT_SCHEMA,STRATEGY_TACTICS_PROMPT_VERSION} from '../client/survivors-research/models/action-strategy.js';
import {COMBAT_CONTEXT_SCHEMA, validCombatContext} from '../client/survivors-research/models/combat-context.js';
import {STRATEGY_CLIENT_TIMEOUT_MS, STRATEGY_MODEL, STRATEGY_SERVER_TIMEOUT_MS} from '../client/survivors-research/models/strategy-config.js';
import {restoreActionImage} from '../client/survivors-research/models/action-prompt.js';
import {VISUAL_IMAGE_REFERENCE, MAX_VISUAL_BASE64_LENGTH} from '../client/survivors-research/models/visual-input.js';

export async function survivorsResearchStrategyRoute(request,env,{localKey,rate,fail,json,readBody,readModelText}) {
  if (!localKey || request.method!=='POST' || request.headers.get('x-mundi-local-connection')!=='1' ||
      request.headers.has('x-mundi-research-key')) fail(401,'战略层需要本机模型连接');
  const body=await readBody(request,MAX_VISUAL_BASE64_LENGTH+200_000);
  const briefAware=body?.schema===STRATEGY_BRIEF_INPUT_SCHEMA;
  const sharedAware=body?.schema===STRATEGY_SHARED_INPUT_SCHEMA;
  const tacticsAware=body?.schema===STRATEGY_TACTICS_INPUT_SCHEMA;
  const combatAware=tacticsAware||sharedAware||briefAware||body?.schema===STRATEGY_COMBAT_INPUT_SCHEMA;
  const keys=['schema','run_id','tick','observation','image','history','prior_strategy'];
  if (combatAware) keys.push('combat_context');
  const transitionAware=body?.schema===STRATEGY_TRANSITION_INPUT_SCHEMA;
  if (!body || Object.keys(body).length!==keys.length || keys.some(k=>!Object.hasOwn(body,k)) ||
      (!combatAware&&!transitionAware&&body.schema!=='survivors-strategy-input-v1') ||
      body.run_id!==body.observation?.run_id || body.tick!==body.observation?.tick ||
      body.observation?.profile!=='state-detail-v1' ||
      (combatAware&&!validCombatContext(body.combat_context,body.tick))) fail(400,'战略层输入无效');
  let input;
  const preparationStarted=performance.now();
  try {input=strategyModelInput(STRATEGY_MODEL,body);} catch {fail(400,'战略层公开观测或图像无效');}
  const preparationMs=performance.now()-preparationStarted;
  if (new TextEncoder().encode(JSON.stringify({observation:body.observation,history:body.history,
    prior_strategy:body.prior_strategy,...(combatAware&&{combat_context:body.combat_context})})).length>192_000)
    fail(413,'战略层输入过大');
  await rate(env.DB,'survivors-research-local-key',3600,60_000);
  const deadline=AbortSignal.timeout(STRATEGY_SERVER_TIMEOUT_MS),signal=AbortSignal.any([request.signal,deadline]);
  const started=performance.now(); let response,raw=null,provider,dispatched=false,serializeMs=null,parseMs=null;
  function reportedProcessingMs() {
    const value=response?.headers.get('openai-processing-ms');
    return typeof value==='string' && /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value))
      ? Number(value) : null;
  }
  const trace=()=>({input,raw_response:raw,usage:provider?.usage??null,backend_metadata:{
    provider:'mundi-owned-chat-completions',model:input.model,endpoint:'/v1/chat/completions',
    provider_model:typeof provider?.model==='string'?provider.model:null,
    reasoning_effort:input.reasoning_effort,max_completion_tokens:input.max_completion_tokens,
    upstream_timeout_ms:STRATEGY_SERVER_TIMEOUT_MS,client_timeout_ms:STRATEGY_CLIENT_TIMEOUT_MS,
    generation_profile:'openai-chat-completions-v1',
    prompt_version:tacticsAware?STRATEGY_TACTICS_PROMPT_VERSION:sharedAware?STRATEGY_SHARED_PROMPT_VERSION:briefAware?STRATEGY_BRIEF_PROMPT_VERSION:
      combatAware?STRATEGY_COMBAT_PROMPT_VERSION:transitionAware?STRATEGY_TRANSITION_PROMPT_VERSION:'strategy-v1',
    ...(combatAware&&{input_schema:body.schema,combat_context_schema:COMBAT_CONTEXT_SCHEMA}),
    visual_profile:body.image.profile,visual_tick:body.image.tick,upstream_status:response?.status??null,
    upstream_dispatched:dispatched,upstream_openai_processing_ms:reportedProcessingMs(),upstream_round_trip_ms:performance.now()-started,
    upstream_request_prepare_ms:preparationMs,upstream_request_serialize_ms:serializeMs,upstream_response_process_ms:parseMs}});
  try {
    const serializeStarted=performance.now();
    const requestBody=JSON.stringify(restoreActionImage(input,body.image));
    serializeMs=performance.now()-serializeStarted;
    signal.throwIfAborted();
    dispatched=true;
    response=await (env.MODEL_FETCH||fetch)('https://api.openai.com/v1/chat/completions',{method:'POST',redirect:'error',
      headers:{Authorization:'Bearer '+localKey,'Content-Type':'application/json'},
      body:requestBody,signal});
    const text=await readModelText(response);
    const parseStarted=performance.now();
    raw=redactProviderEchoes(text,[[localKey,'[redacted]'],[body.image.data_url,VISUAL_IMAGE_REFERENCE],
      [body.image.data_url.slice(body.image.data_url.indexOf(',')+1),VISUAL_IMAGE_REFERENCE]]);
    try {provider=JSON.parse(raw);} catch {}
    parseMs=performance.now()-parseStarted;
  } catch {
    const code=request.signal.aborted?'cancelled':deadline.aborted?'timeout':'connection_unavailable';
    return json({error:{code,message:'战略层请求未完成'},trace:trace()},deadline.aborted?504:502);
  }
  if (!response.ok) {
    const unavailable=response.status===404 || provider?.error?.code==='model_not_found';
    const code=unavailable?'provider_model_unavailable':response.status===429?'provider_rate_limit':'provider_error';
    return json({error:{code,message:unavailable?'战略层配置的模型不可用':'战略层模型服务请求失败'},
      trace:trace()},response.status===429?429:502);
  }
  return json(trace());
}

function redactProviderEchoes(text,replacements,depth=0) {
  if (depth<2 && text.includes('\\')) {
    text=text.replace(/"[^"\\]*(?:\\[\s\S][^"\\]*)*"/g,token=>{
      if (!token.includes('\\')) return token;
      let decoded; try {decoded=JSON.parse(token);} catch {return token;}
      const safe=redactProviderEchoes(decoded,replacements,depth+1);
      return safe===decoded ? token : JSON.stringify(safe);
    });
  }
  for (const [value,replacement] of replacements) text=text.replaceAll(value,replacement).replaceAll(JSON.stringify(value).slice(1,-1),replacement);
  return text;
}

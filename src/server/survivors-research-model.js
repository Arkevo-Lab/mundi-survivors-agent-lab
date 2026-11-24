import {survivorsResearchStrategyRoute} from './survivors-research-strategy.js';
import {COMBAT_CONTEXT_SCHEMA, validCombatContext} from '../client/survivors-research/models/combat-context.js';
import {CONTROL_BRIEF_MODE_V3, CONTROL_BRIEF_MODE_V2, CONTROL_BRIEF_SCHEMA, isControlBriefMode, validControlBrief} from '../client/survivors-research/models/control-brief.js';
import {CARDINAL_ADVISOR_MODE,CARDINAL_MEMORY_WITH_HEADING} from '../client/survivors-research/models/action-cardinal.js';
import { RESEARCH_SLOTS_PROFILE, SLOT_PROMPT_VERSION, TRAJECTORY_PROMPT_VERSION, validateSlotSample, validTrainingControls } from '../client/survivors-research/models/action-slots.js';
import { WHOLE_PATH_COMPACT_SEQUENCE_FORMAT, WHOLE_PATH_MODE, WHOLE_PATH_ONLY_QUESTION_MODE, WHOLE_PATH_TICK_ROTATION, isWholePathMode, wholePathChoiceOffset, wholePathQuestionDigest } from '../client/survivors-research/models/action-whole-path.js';
import { SEQUENCE_ACTION_PROFILE } from '../client/survivors-research/models/action-sequence.js';
import { ACTION_CONNECTION, ACTION_PROMPT_VERSION, ACTION_PROVIDER, COMPATIBLE_GENERATION_PROFILE, OPENAI_GENERATION_PROFILE, actionGenerationParameters, actionModelInput, isOpenAIMini, restoreActionImage } from '../client/survivors-research/models/action-prompt.js';
import { DECISIONS_MODEL, DECISIONS_PATH, DECISIONS_PROFILE, DECISIONS_PROMPT_VERSION, DECISIONS_PROVIDER,
  SLOT_MOVEMENT_PROMPT_SUFFIX, TACTICAL_MOVEMENT_PROMPT_SUFFIX, TRAINING_TACTICS_CONDITION,
  decisionAnswer, decisionModelInput, restoreDecisionImage, validTrainingStrategy } from '../client/survivors-research/models/decisions.js';
import { ADVISOR_MODE, ADVISOR_TIMEOUT_MS } from '../client/survivors-research/models/action-advisor.js';
import { validateTimeout } from '../client/survivors-research/models/common.js';
import { GOAL_QUESTION, STATELESS_CURRENT_CONTEXT, TWO_RATE_GOAL_MODE, wholePathContextDigest } from '../client/survivors-research/models/action-goal.js';
import { MAX_VISUAL_BASE64_LENGTH, STRUCTURED_TRAIL_PROFILE, VISUAL_IMAGE_REFERENCE } from '../client/survivors-research/models/visual-input.js';
import { RESEARCH_CLOSED_PLAN_FEEDBACK, RESEARCH_CLOSED_PLAN_HISTORY_FEEDBACK, RESEARCH_EXECUTED_PLAN_FEEDBACK, RESEARCH_COVERAGE_SEQUENCE_PROFILE } from '../shared/survivors-research-contract.js';
import { resolveModelKey } from './model-settings.js';
import { JOINT_GENERATED_PLAN_PROFILE, jointGeneratedPlanInput } from '../client/survivors-research/models/joint-generated-plan.js';

import {DREX_WEAPON_MICRO_PROJECTION_SCHEMA,isDrexLocalMicroProjectionSchema,LOCAL_MICRO_PROJECTION_SCHEMA} from '../client/survivors-research/models/local-micro.js';
import { DREX_TACTICS_DIRECTION_PROMPT_SUFFIX, DREX_TACTICS_MICRO_PROMPT_VERSION, DREX_SHARED_DIRECTION_PROMPT_SUFFIX, DREX_SHARED_MICRO_PROMPT_VERSION, DREX_BRIEF_DIRECTION_PROMPT_SUFFIX, DREX_BRIEF_MICRO_PROMPT_VERSION, DREX_COMBAT_DIRECTION_PROMPT_SUFFIX, DREX_DIRECTION_PROMPT_SUFFIX, DREX_PATH_MICRO_PROMPT_VERSION, DREX_TARGET_DIRECTION_PROMPT_SUFFIX, DREX_TARGET_MICRO_PROMPT_VERSION, DREX_TARGET_PROVIDER_INPUT_PROFILE, DREX_TIMING_MICRO_PROMPT_VERSION, DREX_COVERAGE_MICRO_PROMPT_VERSION, DREX_WEAPON_MICRO_PROMPT_VERSION, DREX_TIMING_PROVIDER_INPUT_PROFILE, DREX_CAPPED_TIMING_PROVIDER_INPUT_PROFILE, hasMicroTimingContext, DREX_PROVIDER_MICRO_INPUT_PROFILE, LOCAL_PATH_MICRO_MODE, localPathMicroInput, drexPathMicroInput, providerDirectionInput } from '../client/survivors-research/models/local-path-micro.js';
import { NACE_ACTION_PATH, NACE_ENDPOINT, NACE_MODEL, NACE_PROFILE, NACE_PROVIDER, naceDecisionInput, naceDirectionInput, naceUpgradeInput } from '../client/survivors-research/models/nace-decisions.js';

export async function survivorsResearchModelRoute(request, env, account, { first, rate, fail, json, readBody, modelEndpoint, readModelText, localKey: openAIKey, allowJointPlan, naceKey }) {
  const path = new URL(request.url).pathname;
  const nace = path === NACE_ACTION_PATH;
  const localKey = nace ? naceKey : openAIKey;
  if (nace && (!naceKey || openAIKey || account)) fail(404, '接口不存在');
  if (!account && !localKey) fail(401, '请先登录');
  if (path === '/api/survivors-research/model/strategy') return survivorsResearchStrategyRoute(request,env,{localKey,rate,fail,json,readBody,readModelText});
  const base = '/api/survivors-research/model';
  const decisions = nace || path === base + '/decisions' || path === base + '/decisions/action';
  const route = decisions ? base + '/decisions' : base;
  const statusRequest = request.method === 'GET' && path === route;
  if (!statusRequest && (request.method !== 'POST' || path !== (nace ? NACE_ACTION_PATH : route + '/action'))) fail(404, '接口不存在');
  const connection = localKey ? {
    model: null, endpoint: 'https://api.openai.com/v1/chat/completions', profile: OPENAI_GENERATION_PROFILE,
  } : researchConnection(env, modelEndpoint, fail);
  const official = connection.profile === OPENAI_GENERATION_PROFILE;
  let { model, endpoint, profile } = nace
    ? {model:NACE_MODEL, endpoint:NACE_ENDPOINT, profile:NACE_PROFILE}
    : decisions ? {model:DECISIONS_MODEL, endpoint:'https://api.openai.com' + DECISIONS_PATH, profile:DECISIONS_PROFILE}
      : connection;
  const provider = nace ? NACE_PROVIDER : decisions ? DECISIONS_PROVIDER : ACTION_PROVIDER;
  const endpointPath = nace ? '/v1/systemone' : decisions ? DECISIONS_PATH : official ? '/v1/chat/completions' : undefined;
  if (statusRequest) {
    const describe = {
      kind: decisions ? 'openai-decisions' : 'generative', provider, model,
      prompt_version: decisions ? DECISIONS_PROMPT_VERSION : ACTION_PROMPT_VERSION,
      generation_profile: profile, generation_parameters: decisions ? null : actionGenerationParameters(model, profile),
      connection_ref: ACTION_CONNECTION,
      ...(endpointPath && {endpoint: endpointPath}),
    };
    const saved = await first(env.DB, 'SELECT mode, credential IS NOT NULL AND credential <> ? AS has_key FROM agent_model_settings WHERE owner_id=?', '', account.id);
    const enabled = !decisions || official;
    const available = enabled && saved?.mode === 'custom' && !!saved.has_key;
    return json({
      ...describe,
      available,
      visual_status: 'unverified',
      status: !enabled ? 'official_openai_required'
        : available ? 'configured' : saved?.mode === 'coding' ? 'coding_plan_unsupported' : 'key_required',
    });
  }
  if (decisions && !official) {
    return json({ error: { code: 'official_openai_required', message: 'Decisions 需要启用研究专属官方 OpenAI 连接' } }, 503);
  }

  // Full information can contain every visible entity. The other profiles keep their original text limit.
  const fullTextLimit = 4 * 1024 * 1024;
  const body = await readBody(request, fullTextLimit + MAX_VISUAL_BASE64_LENGTH + 512 + 4096);
  const { observation, candidates, image, ...parameters } = body;
  const allowed = ['observation', 'candidates', 'model', 'timeout_ms', 'image', 'generation_profile', 'action_profile', 'slot_sample', 'movement_prompt_sample', 'training_strategy', 'training_controls', 'movement_protocol', 'path_question_guidance', 'whole_path_context', 'path_choice_order', 'path_choice_format', 'movement_feedback', 'whole_path_question_mode', 'advisor_role', 'advisor_context', 'strategy_context', 'local_feedback', 'local_facing', 'local_projection', 'local_path_micro', 'provider_profile', 'combat_context'];
  if (Object.keys(body).some(key => !allowed.includes(key))) fail(400, '研究观测或候选动作格式无效');
  const advisorRole = body.advisor_role;
  const pathMicro = body.local_path_micro === true;
  const providerProfile = body.provider_profile;
  const naceDirection=nace&&advisorRole==='cardinal-advisor';
  const naceUpgrade=nace&&Boolean(observation?.upgrade_offer)&&advisorRole===undefined&&!pathMicro;
  const coverage=body.action_profile===RESEARCH_COVERAGE_SEQUENCE_PROFILE;
  const sequence=coverage||body.action_profile===SEQUENCE_ACTION_PROFILE;
  if(naceUpgrade&&(!sequence||Object.keys(body).some(key=>
      !['observation','candidates','model','timeout_ms','image','generation_profile','action_profile'].includes(key))||
      observation?.profile!=='state-detail-v1'||observation?.terminal!==false||
      image?.profile!=='structured-v1'||image.mime_type!=='image/png'||
      request.headers.get('x-mundi-local-connection')!=='1'||request.headers.has('x-mundi-research-key')))fail(400,'Nace 升级仅支持本机公开升级选项与结构图');
  const targetMicro=isDrexLocalMicroProjectionSchema(body.local_projection?.schema);
  const weaponMicro=body.local_projection?.schema===DREX_WEAPON_MICRO_PROJECTION_SCHEMA;
  if(weaponMicro&&!(nace&&pathMicro&&coverage))fail(400,'武器读数需要原生 Drex 600 毫秒局部微操');
  const coveragePrompt=weaponMicro?DREX_WEAPON_MICRO_PROMPT_VERSION:DREX_COVERAGE_MICRO_PROMPT_VERSION;
  const timedMicro=hasMicroTimingContext(providerProfile);
  const cappedMicro=Object.hasOwn(providerProfile??{},'provider_processing_cap_ms');
  if(timedMicro&&!(nace&&pathMicro&&targetMicro))fail(400,'微操时序档案需要 Nace 局部微操');
  const targetDirection=naceDirection&&body.advisor_context?.schema===CARDINAL_MEMORY_WITH_HEADING;
  const combatDirection=Object.hasOwn(body,'combat_context');
  if (combatDirection&&(!targetDirection||!coverage||!validCombatContext(body.combat_context,observation?.tick))) {
    fail(400,'战斗信息仅适用于同帧 Drex 方向判断');
  }
  const briefMode=providerProfile?.brief_mode;
  const knownBriefMode=isControlBriefMode(briefMode);
  const briefMicro=knownBriefMode&&nace&&pathMicro&&weaponMicro&&timedMicro&&cappedMicro&&advisorRole==='local-micro';
  const briefDirection=knownBriefMode&&combatDirection;
  const sharedBriefMode=briefMode===CONTROL_BRIEF_MODE_V2;
  const tacticsBriefMode=briefMode===CONTROL_BRIEF_MODE_V3;
  if(Object.hasOwn(providerProfile??{},'brief_mode')&&!(briefMicro||briefDirection)) {
    fail(400,'战略短交接模式仅适用于原生 Drex 三层研究连接');
  }
  const includesControlBrief=Object.hasOwn(body.advisor_context??{},'control_brief');
  const controlBrief=body.advisor_context?.control_brief;
  if(includesControlBrief&&(!briefMicro||(controlBrief!==null&&
      (!validControlBrief(controlBrief,observation?.tick)||controlBrief.accepted_tick>body.advisor_context.source_tick)))) {
    fail(400,'战略短交接仅适用于当前帧的 Drex 局部微操');
  }
  if(coverage&&!(naceUpgrade||targetDirection||(nace&&pathMicro&&targetMicro&&timedMicro)))
    fail(400,'600 毫秒动作档需要原生 Drex 三层研究连接');
  if(targetMicro&&!(nace&&pathMicro&&providerProfile))fail(400,'局部目标交接需要 Nace 供应商计时微操');
  // Older open tabs may still send raw_image. Only the validated original image is used.
  if (providerProfile !== undefined && (!localKey || !providerProfile ||
      !Number.isInteger(providerProfile.phase) || providerProfile.phase<0 || providerProfile.phase>3 ||
      (nace&&!naceDirection ? Object.keys(providerProfile).some(key=>!['phase','interval','raw_image','remaining_plan','recent_micro_processing','provider_processing_cap_ms','brief_mode'].includes(key))
        : advisorRole!=='cardinal-advisor' || Object.keys(providerProfile).length!==(briefDirection?2:1)))) {
    fail(400,'研究供应商输入档案无效');
  }
  if ((nace && !pathMicro && !naceDirection && !naceUpgrade) || (naceDirection && !providerProfile) || (body.local_path_micro !== undefined && (!pathMicro || advisorRole !== 'local-micro'))) {
    fail(400, '65 项路径仅支持本机三层局部微操');
  }
  if (advisorRole !== 'local-micro' && ['local_feedback','local_facing','local_projection'].some(key=>Object.hasOwn(body,key))) fail(400,'局部微操参数仅适用于微操层');
  if (body.strategy_context !== undefined && advisorRole !== 'cardinal-advisor') fail(400,'战略仅可传给方向层');
  const cardinal = advisorRole === 'cardinal-advisor' || advisorRole === 'cardinal-micro' || advisorRole === 'local-micro';
  const advisorOnly = advisorRole === 'advisor' || advisorRole === 'cardinal-advisor';
  if (Object.hasOwn(body, 'advisor_role') || Object.hasOwn(body, 'advisor_context')) {
    const permitted = ['observation', 'candidates', 'model', 'timeout_ms', 'image', 'generation_profile', 'action_profile',
      'advisor_role', 'advisor_context', 'strategy_context', 'local_feedback', 'local_facing', 'local_projection', 'local_path_micro', 'provider_profile',
      ...(combatDirection?['combat_context']:[])];
    if ((body.strategy_context !== undefined && advisorRole !== 'cardinal-advisor') || !['advisor', 'micro', 'cardinal-advisor', 'cardinal-micro', 'local-micro'].includes(advisorRole) || !Object.hasOwn(body, 'advisor_context') ||
        !localKey || !decisions || request.headers.get('x-mundi-local-connection') !== '1' ||
        request.headers.has('x-mundi-research-key') || body.model !== model ||
        body.generation_profile !== profile || !sequence ||
        observation?.profile !== 'state-detail-v1' || observation?.terminal !== false || observation.upgrade_offer ||
        ((cardinal || advisorRole==='local-micro') ? Object.hasOwn(observation, 'direction_context') : !Object.hasOwn(observation, 'direction_context')) || image?.profile !== (advisorRole==='local-micro'?'local-micro-v1':'structured-v1') ||
        (advisorOnly && (image.mime_type !== 'image/png' || body.timeout_ms !== ADVISOR_TIMEOUT_MS)) ||
        Object.keys(body).some(key => !permitted.includes(key))) {
      fail(400, '中期指导仅支持已保存的本机方向模型和结构图');
    }
  }
  // A validated advisor snapshot may include four closed windows and one ongoing window.
  const textLimit = advisorOnly ? 192 * 1024
    : observation?.profile === 'state-full-v1' ? fullTextLimit : 65_536;
  const slots = body.action_profile === RESEARCH_SLOTS_PROFILE;
  const joint = body.generation_profile === JOINT_GENERATED_PLAN_PROFILE;
  if (joint) {
    if (!allowJointPlan || !localKey || request.headers.get('x-mundi-local-connection') !== '1' ||
        request.headers.has('x-mundi-research-key') || decisions || !slots || body.model !== DECISIONS_MODEL ||
        image !== undefined || body.slot_sample !== undefined || body.movement_prompt_sample !== undefined ||
        body.training_controls !== undefined || !validTrainingStrategy(body.training_strategy)) {
      fail(400, '联合目标与动作只支持本机诊断');
    }
    model = DECISIONS_MODEL;
    profile = JOINT_GENERATED_PLAN_PROFILE;
  }
  if (body.action_profile !== undefined && !sequence && !(slots && (decisions || joint))) {
    fail(400, '研究动作协议无效');
  }
  if (image?.profile === 'trajectory-v1' && !slots) fail(400, '轨迹图仅支持固定时间槽');
  const promptSample = body.movement_prompt_sample;
  const strategy = body.training_strategy;
  const controls = body.training_controls;
  const movementProtocol = body.movement_protocol;
  const wholePath = isWholePathMode(movementProtocol);
  const direction = Object.hasOwn(observation ?? {}, 'direction_context');
  if (direction && (!localKey || !decisions || request.headers.get('x-mundi-local-connection') !== '1' ||
      request.headers.has('x-mundi-research-key'))) {
    fail(400, '方向判断仅支持本地 Decisions 研究连接');
  }
  const originalWholePath = movementProtocol === WHOLE_PATH_MODE;
  if (movementProtocol !== undefined && (!wholePath || !localKey || !decisions ||
      request.headers.get('x-mundi-local-connection') !== '1' || request.headers.has('x-mundi-research-key'))) {
    fail(400, '完整路径仅支持本地 Decisions 研究连接');
  }
  const movementFeedback = body.movement_feedback;
  const singlePlanFeedback = movementFeedback === RESEARCH_EXECUTED_PLAN_FEEDBACK || movementFeedback === RESEARCH_CLOSED_PLAN_FEEDBACK;
  const planHistory = movementFeedback === RESEARCH_CLOSED_PLAN_HISTORY_FEEDBACK;
  const pathChoiceFormat = body.path_choice_format;
  const structuredTrail = image?.profile === STRUCTURED_TRAIL_PROFILE;
  if (structuredTrail && (!planHistory || pathChoiceFormat !== undefined)) {
    fail(400, '移动轨迹图仅适用于本地完整路径的已结束动作记录模式');
  }
  if (pathChoiceFormat !== undefined && (pathChoiceFormat !== WHOLE_PATH_COMPACT_SEQUENCE_FORMAT || !planHistory)) {
    fail(400, '简写路径仅适用于本地完整路径的已结束动作记录模式');
  }
  const hasPreviousMovement = observation?.player != null && Object.hasOwn(observation.player, 'previous_movement');
  const hasMovementHistory = observation?.player != null && Object.hasOwn(observation.player, 'movement_history');
  if ((movementFeedback !== undefined && !planHistory || hasPreviousMovement) &&
      (!originalWholePath || !singlePlanFeedback || observation?.upgrade_offer)) {
    fail(400, '已执行移动反馈仅适用于已启用反馈的本地完整路径移动');
  }
  const pathChoiceOrder = body.path_choice_order;
  if (pathChoiceOrder !== undefined && (!originalWholePath || pathChoiceOrder !== WHOLE_PATH_TICK_ROTATION || observation?.upgrade_offer)) {
    fail(400, '路径顺序仅适用于完整路径移动');
  }
  const wholePathContext = body.whole_path_context;
  if (wholePathContext !== undefined && (!originalWholePath || wholePathContext !== STATELESS_CURRENT_CONTEXT || observation?.upgrade_offer)) {
    fail(400, '无状态上下文仅适用于完整路径移动');
  }
  const wholePathQuestionMode = body.whole_path_question_mode;
  const pathOnly = wholePathQuestionMode === WHOLE_PATH_ONLY_QUESTION_MODE;
  if ((planHistory || hasMovementHistory) &&
      (!planHistory || !originalWholePath || body.action_profile !== SEQUENCE_ACTION_PROFILE ||
        (image?.profile !== 'structured-v1' && !structuredTrail) || observation?.profile !== 'state-detail-v1' ||
        observation.terminal !== false || observation.upgrade_offer ||
        observation.training_intent?.mode !== 'goal-stateless-v1' || observation.training_intent.prior !== null ||
        Object.hasOwn(observation, 'training_tactics') || !validTrainingStrategy(strategy) ||
        wholePathQuestionMode !== undefined || wholePathContext !== undefined || pathChoiceOrder !== undefined ||
        controls !== undefined || body.slot_sample !== undefined || promptSample !== undefined)) {
    fail(400, '已结束动作记录仅适用于本地完整路径移动和结构图');
  }
  if (wholePathQuestionMode !== undefined &&
      (!pathOnly || !originalWholePath || body.action_profile !== SEQUENCE_ACTION_PROFILE || image?.profile !== 'structured-v1' ||
        observation?.upgrade_offer || Object.hasOwn(observation ?? {}, 'training_intent') ||
        Object.hasOwn(observation ?? {}, 'training_tactics') || movementFeedback !== undefined ||
        wholePathContext !== undefined || pathChoiceOrder !== undefined || controls !== undefined ||
        body.slot_sample !== undefined || promptSample !== undefined)) {
    fail(400, '单路径题仅适用于本地原始完整路径移动和结构图');
  }
  if (body.path_question_guidance !== undefined && !wholePath) {
    fail(400, '路径题提示仅适用于完整路径移动');
  }
  if (!joint && strategy !== undefined && (!localKey || request.headers.get('x-mundi-local-connection') !== '1' ||
      request.headers.has('x-mundi-research-key') || !decisions || !(slots || wholePath) || observation?.upgrade_offer ||
      body.slot_sample !== undefined || promptSample !== undefined || !validTrainingStrategy(strategy))) {
    fail(400, '训练策略只支持本地研究移动决策');
  }
  if (controls !== undefined && (strategy === undefined || !validTrainingControls(controls))) {
    fail(400, '训练选项或问题数量无效');
  }
  if (promptSample !== undefined && (!localKey || request.headers.get('x-mundi-local-connection') !== '1' ||
      request.headers.has('x-mundi-research-key') || !decisions || !(slots || body.action_profile === SEQUENCE_ACTION_PROFILE) ||
      observation?.upgrade_offer || body.slot_sample !== undefined || !['baseline', 'tactical'].includes(promptSample))) {
    fail(400, '移动提示对照采样仅支持本地研究连接和冻结移动观测');
  }
  if (body.slot_sample !== undefined) {
    if (!slots) fail(400, '仅固定时间槽支持冻结观测采样');
    try { validateSlotSample(body.slot_sample); } catch { fail(400, '固定时间槽采样参数无效'); }
  }
  if (new TextEncoder().encode(JSON.stringify({ observation, candidates, ...parameters })).length > textLimit) {
    fail(413, '研究文本请求内容过大');
  }
  if (localKey && !decisions && !joint) {
    if (!isResearchChatModel(body.model)) fail(400, '请选择可用于 Chat 模式的 OpenAI 模型');
    model = body.model;
  }
  if (body.model !== model) fail(409, '已配置模型发生变化，请刷新模型连接');
  if (body.generation_profile !== undefined && body.generation_profile !== profile) {
    return json({ error: { code: 'generation_profile_changed', message: '模型推理参数配置已变化，请刷新模型连接' } }, 409);
  }
  let timeout, input, nativeNace;
  const tacticalMovement = !observation?.upgrade_offer && !body.slot_sample && promptSample !== 'baseline';
  try { timeout = validateTimeout(body.timeout_ms); } catch { fail(400, '模型超时设置无效'); }
  const requestPreparationStarted = performance.now();
  try {
    const context = { observation, candidates, image, action_profile: body.action_profile,
      slot_sample: body.slot_sample, movement_prompt_sample: promptSample, training_strategy: strategy,
      training_controls: controls, movement_protocol: movementProtocol, path_question_guidance: body.path_question_guidance,
      whole_path_context: wholePathContext, path_choice_order: pathChoiceOrder, movement_feedback: movementFeedback,
      whole_path_question_mode: wholePathQuestionMode, path_choice_format: pathChoiceFormat,
      ...(combatDirection&&{combat_context:body.combat_context}),
      ...(advisorRole && {advisor_role: advisorRole, advisor_context: body.advisor_context, strategy_context:body.strategy_context,local_feedback:body.local_feedback,local_facing:body.local_facing,local_projection:body.local_projection}) };
    input = joint ? jointGeneratedPlanInput(context)
      : decisions ? decisionModelInput(nace ? DECISIONS_MODEL : model, context) : actionModelInput(model, context, profile);
    if (pathMicro) input = nace ? drexPathMicroInput(input,providerProfile,body.action_profile) : localPathMicroInput(input);
    if (providerProfile&&!pathMicro) input=providerDirectionInput(input,providerProfile.phase,{
      targetHandoff:targetDirection,combatAware:combatDirection,...(briefDirection&&{briefMode})});
    if (nace) {
      const fullInput=restoreDecisionImage(input,image);
      nativeNace=naceDirection?naceDirectionInput(fullInput):naceUpgrade?naceUpgradeInput(fullInput):naceDecisionInput(fullInput);
    }
    const question = decisions && input.questions.length === 1 ? input.questions[0] : null;
    const onlyChoice = question?.choices.length === 1 ? question.choices[0].value : null;
    if (!naceUpgrade && onlyChoice?.startsWith('choose:') && (slots || body.action_profile === SEQUENCE_ACTION_PROFILE)) {
      return json({ input: null, raw_response: null, usage: null, local_action_id: onlyChoice,
        backend_metadata: { provider, model, action_profile: body.action_profile,
          prompt_version: slots ? SLOT_PROMPT_VERSION : DECISIONS_PROMPT_VERSION + '-sequence-upgrade-v1',
          upstream_dispatched: false, local_reason: 'only-upgrade-option' } });
    }
  }
  catch (error) {
    if (error.code === 'invalid_visual_input') return json({
      error: { code: error.code, message: '研究图像的格式、尺寸、档位或帧号无效' },
    }, 400);
    fail(400, '研究观测或候选动作格式无效');
  }
  const requestPrepareMs = performance.now() - requestPreparationStarted;
  const trainingCondition = observation.training_intent?.mode ??
    (observation.training_tactics ? TRAINING_TACTICS_CONDITION : undefined);
  const goalQuestions = Number(decisions && input.questions.at(-1)?.name === GOAL_QUESTION);
  const strategyHash = strategy === undefined ? null : Array.from(new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(strategy))), byte => byte.toString(16).padStart(2, '0')).join('');
  const pathQuestionHash = wholePath && body.path_question_guidance?.guidance ?
    await wholePathQuestionDigest(body.path_question_guidance, movementProtocol) : null;
  const wholePathContextHash = wholePathContext ? await wholePathContextDigest(input) : null;
  const apiKey = localKey ?? await resolveModelKey(env, account.id, fail);
  // Budget for the 60 Hz sampling ceiling without sharing the strategy generation quota.
  await rate(env.DB, nace ? 'survivors-research-local-nace' : localKey ? 'survivors-research-local-key' : 'survivors-research-action:' + account.id, 3600, 60_000);
  const deadline = AbortSignal.timeout(timeout);
  const signal = AbortSignal.any([request.signal, deadline]);
  let providerRequestBytes = null;
  let providerResponseBytes = null;
  let providerRoundTripMs = null;
  let requestSerializeMs = null;
  let responseProcessMs = null;
  let dispatched = false;
  let response;
  let rawResponse = null;
  let providerData;
  const trace = () => ({
    input: nativeNace ? {...nativeNace, images:[VISUAL_IMAGE_REFERENCE]} : input,
    raw_response: rawResponse,
    usage: providerData?.usage ?? null,
    backend_metadata: {
      provider,
      ...(endpointPath && { endpoint: endpointPath }),
      ...(promptSample && { movement_prompt_sample: promptSample }),
      ...(strategyHash && { training_strategy_sha256: strategyHash }),
      ...(controls && {training_controls: controls}),
      ...(trainingCondition && {training_condition: trainingCondition}),
      ...(trainingCondition === TWO_RATE_GOAL_MODE && {training_intent_phase: observation.training_intent.phase}),
      ...(joint && {action_profile: RESEARCH_SLOTS_PROFILE, prompt_version: JOINT_GENERATED_PLAN_PROFILE, slot_question_count: 10}),
      ...(slots && !joint && { action_profile: RESEARCH_SLOTS_PROFILE,
        prompt_version: (observation.player?.movement_receipts ? TRAJECTORY_PROMPT_VERSION : SLOT_PROMPT_VERSION) +
          (tacticalMovement ? (strategyHash ? TACTICAL_MOVEMENT_PROMPT_SUFFIX : SLOT_MOVEMENT_PROMPT_SUFFIX) : '') +
          (controls ? '-training-v2' : strategyHash ? '-training-v1' : '') +
          (trainingCondition ? '-' + trainingCondition : ''),
        slot_sample: body.slot_sample ?? null, slot_question_count: input.questions.length - goalQuestions,
        ...(observation.training_intent && {goal_question_count: goalQuestions}) }),
      ...(sequence && {
        action_profile: body.action_profile,
        prompt_version: decisions ? DECISIONS_PROMPT_VERSION + (advisorRole ? (cardinal ? '-' + CARDINAL_ADVISOR_MODE : '-direction-v1-' + ADVISOR_MODE) + '-' + advisorRole : direction ? '-direction-v1' : wholePath ? '-' + movementProtocol : observation.upgrade_offer ? (naceUpgrade ? '-nace-upgrade-v1' : '-sequence-upgrade-v1')
          : '-sequence-v2' + (tacticalMovement ? TACTICAL_MOVEMENT_PROMPT_SUFFIX : ''))
          : ACTION_PROMPT_VERSION + '-sequence-v1',
      }),
      ...(pathChoiceOrder && { path_choice_order: pathChoiceOrder, path_choice_offset: wholePathChoiceOffset(observation.tick) }),
      ...(pathChoiceFormat && { path_choice_format: pathChoiceFormat }),
      ...(movementFeedback && { movement_feedback: movementFeedback }),
      ...(wholePathContextHash && { whole_path_context: wholePathContext, whole_path_context_sha256: wholePathContextHash }),
      ...(pathQuestionHash && { path_question_instructions_sha256: pathQuestionHash }),
      ...(wholePath && { movement_protocol: movementProtocol, path_question_count: 1, goal_question_count: goalQuestions }),
      ...(pathOnly && { whole_path_question_mode: wholePathQuestionMode }),
      ...(direction && !advisorOnly && { movement_question_mode: 'direction-v1' }),
      ...(cardinal && !advisorOnly && {movement_question_mode: pathMicro ? LOCAL_PATH_MICRO_MODE
        : advisorRole === 'local-micro' ? 'local-cardinal-v1' : 'cardinal-v2'}),
      ...(pathMicro && {prompt_version:DECISIONS_PROMPT_VERSION + '-' + (briefMicro
        ? (tacticsBriefMode?DREX_TACTICS_MICRO_PROMPT_VERSION:sharedBriefMode?DREX_SHARED_MICRO_PROMPT_VERSION:DREX_BRIEF_MICRO_PROMPT_VERSION):
        nace ? timedMicro?(coverage?coveragePrompt:DREX_TIMING_MICRO_PROMPT_VERSION):targetMicro?DREX_TARGET_MICRO_PROMPT_VERSION:DREX_PATH_MICRO_PROMPT_VERSION : LOCAL_PATH_MICRO_MODE)}),
      ...(advisorRole==='local-micro' && {local_projection_schema:targetMicro?body.local_projection.schema:LOCAL_MICRO_PROJECTION_SCHEMA}),
      ...(nace && pathMicro && providerProfile && {provider_input_profile:cappedMicro?DREX_CAPPED_TIMING_PROVIDER_INPUT_PROFILE:
        timedMicro?DREX_TIMING_PROVIDER_INPUT_PROFILE:targetMicro?DREX_TARGET_PROVIDER_INPUT_PROFILE:DREX_PROVIDER_MICRO_INPUT_PROFILE}),
      ...(!pathMicro && providerProfile && {
        prompt_version: DECISIONS_PROMPT_VERSION + '-' + CARDINAL_ADVISOR_MODE + '-cardinal-advisor' +
          (briefDirection?(tacticsBriefMode?DREX_TACTICS_DIRECTION_PROMPT_SUFFIX:sharedBriefMode?DREX_SHARED_DIRECTION_PROMPT_SUFFIX:DREX_BRIEF_DIRECTION_PROMPT_SUFFIX):
            combatDirection?DREX_COMBAT_DIRECTION_PROMPT_SUFFIX:
            targetDirection?DREX_TARGET_DIRECTION_PROMPT_SUFFIX:DREX_DIRECTION_PROMPT_SUFFIX),
      }),
      ...(combatDirection&&{combat_context_schema:COMBAT_CONTEXT_SCHEMA}),
      ...(briefDirection||briefMicro?{control_brief_mode:briefMode}:{}),
      ...(briefMicro&&{control_brief_schema:CONTROL_BRIEF_SCHEMA,control_brief_present:Boolean(controlBrief)}),
      ...(advisorRole && {advisor_mode: cardinal ? CARDINAL_ADVISOR_MODE : ADVISOR_MODE, advisor_role: advisorRole, advisor_question_count: advisorOnly ? 1 : 0}),
      ...(decisions && ((slots || sequence)
        ? { decision_answers: providerData?.answers ?? null,
          decision_slot_semantics: pathMicro ? 'whole-path-only' : advisorOnly ? 'direction-guidance' : cardinal ? 'single-action' : wholePath ? (pathOnly ? 'whole-path-only' : 'whole-path-and-independent-goal')
            : !slots && observation.upgrade_offer ? 'single-upgrade' : 'independent-shared-input' }
        : { decision_answer: decisionAnswer(providerData) })),
      model,
      generation_profile: profile,
      simulated: false,
      ...(image && { visual_profile: image.profile, visual_tick: image.tick }),
      upstream_status: response?.status ?? null,
      ...(official && !nace && { upstream_openai_processing_ms: openAIProcessingMs(response) }),
      ...(nace && {upstream_nace_evaluation_time_ms: Number.isFinite(providerData?.evaluation_time_ms) &&
        providerData.evaluation_time_ms >= 0 ? providerData.evaluation_time_ms : null}),
      upstream_body_complete: response ? rawResponse !== null : null,
      provider_model: typeof providerData?.model === 'string' ? providerData.model : null,
      provider_response_id: nace ? (typeof providerData?.request_id === 'string' ? providerData.request_id : null)
        : typeof providerData?.id === 'string' ? providerData.id : null,
      upstream_dispatched: response ? true : dispatched ? null : false,
      upstream_request_bytes: providerRequestBytes, upstream_response_bytes: providerResponseBytes,
      upstream_round_trip_ms: providerRoundTripMs,
      upstream_request_prepare_ms: requestPrepareMs,
      upstream_request_serialize_ms: requestSerializeMs,
      upstream_response_process_ms: responseProcessMs,
    },
  });
  const error = (status, code, message) => json({ error: { code, message }, trace: trace() }, status);
  try {
    const serializationStarted = performance.now();
    const restoreImage = decisions ? restoreDecisionImage : restoreActionImage;
    const providerBody = JSON.stringify(nativeNace ?? (image ? restoreImage(input, image) : input));
    providerRequestBytes = new TextEncoder().encode(providerBody).length;
    requestSerializeMs = performance.now() - serializationStarted;
    if (nace && providerRequestBytes > 4 * 1024 * 1024) return error(413, 'provider_input_too_large', 'Nace 图像请求超过大小限制');
    signal.throwIfAborted();
    dispatched = true;
    const providerStartedAt = performance.now();
    let text;
    try {
      response = await (env.MODEL_FETCH || fetch)(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: providerBody,
        signal,
      });
      text = await readModelText(response);
    } finally {
      providerRoundTripMs = performance.now() - providerStartedAt;
    }
    // Never return headers or credential echoes from a provider or gateway.
    const responseProcessStarted = performance.now();
    providerResponseBytes = new TextEncoder().encode(text).length;
    const replacements = [[apiKey, '[redacted]']];
    if (image) replacements.push(
      [image.data_url, VISUAL_IMAGE_REFERENCE],
      [image.data_url.slice(image.data_url.indexOf(',') + 1), VISUAL_IMAGE_REFERENCE],
    );
    rawResponse = redactProviderEchoes(text, replacements);
    try { providerData = JSON.parse(rawResponse); } catch { /* retained as raw text */ }
    responseProcessMs = performance.now() - responseProcessStarted;
    signal.throwIfAborted();
  } catch {
    if (request.signal.aborted) return error(499, 'cancelled', '模型请求已取消');
    if (deadline.aborted) return error(504, 'timeout', '模型请求超时');
    if (response?.ok) return error(502, 'invalid_provider_response', '模型返回读取失败');
    if (!response) return error(502, 'disconnected', '模型连接中断');
  }
  if (!response.ok) {
    if (nace && response.status === 402) return error(429, 'provider_quota', 'Nace 项目的可用额度不足');
    if (!nace && official && response.status === 429 && providerData?.error?.code === 'insufficient_quota') {
      return error(429, 'provider_quota', 'OpenAI 项目的额度不足');
    }
    if (response.status === 429) return error(429, 'provider_rate_limit', '模型服务限流');
    if ([401, 403].includes(response.status)) return error(502, 'provider_auth', '模型服务拒绝了当前 API Key');
    if (response.status === 404 || providerData?.error?.code === 'model_not_found') {
      return error(502, 'provider_model_unavailable', '模型服务无法使用所配置的模型');
    }
    if (image && [400, 415, 422].includes(response.status)) {
      return error(502, 'provider_visual_rejected', '模型网关拒绝了图像请求，请确认已配置模型与网关支持视觉输入');
    }
    return error(502, 'provider_error', '模型服务请求失败');
  }
  return json(trace());
}

function isResearchChatModel(model) {
  return typeof model === 'string' && model.length <= 150 &&
    /^(?:gpt-[a-z0-9.-]+|o[1-9][a-z0-9.-]*)$/.test(model) && model !== DECISIONS_MODEL &&
    !/audio|realtime|transcri|tts|instruct|search|image|codex|moderation|pro(?:-|$)/.test(model);
}

// Called only by the loopback preview server with a browser-supplied key.
export async function listResearchKeyModels(key, signal, readModelText, fetchModels = fetch) {
  const response = await fetchModels('https://api.openai.com/v1/models', {
    redirect: 'error', signal, headers: {Authorization: 'Bearer ' + key},
  });
  if (!response.ok) {
    await response.body?.cancel();
    return Response.json({error: {message: response.status === 401 || response.status === 403
      ? 'OpenAI 拒绝了这个 API Key，请检查密钥或模型读取权限。' : '暂时无法读取 OpenAI 模型列表。'}},
    {status: response.status === 401 || response.status === 403 ? 401 : 502});
  }
  const {data} = JSON.parse(await readModelText(response, 1024 * 1024));
  const models = [];
  for (const id of new Set((Array.isArray(data) ? data : []).map(model => model?.id))) {
    if (id === key) continue;
    if (id === DECISIONS_MODEL) models.push({model: id, kind: 'openai-decisions', generation_profile: DECISIONS_PROFILE});
    else if (isResearchChatModel(id)) models.push({model: id, kind: 'generation', generation_profile: OPENAI_GENERATION_PROFILE});
  }
  return Response.json({models: models.sort((a, b) => a.model.localeCompare(b.model))});
}

function researchConnection(env, modelEndpoint, fail) {
  const base = env.SURVIVORS_RESEARCH_OPENAI_BASE_URL;
  const model = env.SURVIVORS_RESEARCH_OPENAI_MODEL;
  if (!base && !model) {
    return {
      model: env.OPENAI_MODEL || 'glm-5.3',
      endpoint: modelEndpoint(env),
      profile: COMPATIBLE_GENERATION_PROFILE,
    };
  }
  if (!base || !isOpenAIMini(model)) fail(503, '研究 OpenAI 配置需要官方端点和受支持的 GPT-5.4 mini 模型');
  const endpoint = modelEndpoint({ OPENAI_BASE_URL: base });
  if (endpoint !== 'https://api.openai.com/v1/chat/completions') fail(503, '研究 OpenAI 配置只允许官方 Chat Completions 端点');
  return { model, endpoint, profile: OPENAI_GENERATION_PROFILE };
}

function openAIProcessingMs(response) {
  const raw = response?.headers.get('openai-processing-ms');
  if (!raw || !/^[0-9]+(?:\.[0-9]+)?$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function redactProviderEchoes(text, replacements, depth = 0) {
  if (depth < 2 && text.includes('\\')) {
    text = text.replace(/"[^"\\]*(?:\\[\s\S][^"\\]*)*"/g, token => {
      if (!token.includes('\\')) return token;
      let decoded;
      try { decoded = JSON.parse(token); } catch { return token; }
      const safe = redactProviderEchoes(decoded, replacements, depth + 1);
      return safe === decoded ? token : JSON.stringify(safe);
    });
  }
  for (const [value, replacement] of replacements) {
    text = text.replaceAll(value, replacement).replaceAll(JSON.stringify(value).slice(1, -1), replacement);
  }
  return text;
}

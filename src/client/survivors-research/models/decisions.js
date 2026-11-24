import {DREX_WEAPON_MICRO_PROJECTION_SCHEMA,isDrexLocalMicroProjectionSchema,projectLocalMicro,validLocalFeedback,localMicroQuestion} from './local-micro.js';
import {validStrategyEnvelope} from './action-strategy.js';
import {CARDINAL_MEMORY_WITH_HEADING,cardinalAdvisorQuestion, cardinalGuidance, cardinalMicroQuestion, decodeCardinal, validCardinalContext} from './action-cardinal.js';
import {ADVISOR_TIMEOUT_MS, MICRO_ADVICE_INSTRUCTIONS, advisorQuestion, decodeAdvisorChoice, validAdvisorContext} from './action-advisor.js';
import {directionAction, directionCandidatesMatch, directionQuestions} from './action-direction.js';
import { RESEARCH_SLOTS_PROFILE, isDefaultTrainingControls, slotObservation, slotQuestionNames, slotQuestions, validateSlotSample,
  validTrainingControls } from './action-slots.js';
import { RESEARCH_COVERAGE_SEQUENCE_PROFILE } from '../../../shared/survivors-research-contract.js';
import { MAX_ACTION_SEGMENTS, SEQUENCE_ACTION_PROFILE, SEQUENCE_END, SEQUENCE_POLICY, validActionSequence } from './action-sequence.js';
import { WHOLE_PATH_COMPACT_SEQUENCE_FORMAT, WHOLE_PATH_EIGHT_DIRECTION_MODE, WHOLE_PATH_MODE, WHOLE_PATH_ONLY_QUESTION_MODE, WHOLE_PATH_STAGGERED_MODE, WHOLE_PATH_TICK_ROTATION, isWholePathMode,
  validateWholePathQuestionGuidance, wholePathChoiceOffset, wholePathDirections, wholePathHoldDurations, wholePathQuestion } from './action-whole-path.js';
import { ACTION_CONNECTION, ACTION_POLICY, structuredImageLegend } from './action-prompt.js';
import { validActionContext } from './action-observation.js';
import {validCombatContext} from './combat-context.js';
import { asksGoal, GOAL_QUESTION, GOAL_MOVEMENT_GUIDANCE, goalQuestion, isGoalPlan,
  STATELESS_CURRENT_CONTEXT, STATELESS_CURRENT_MOVEMENT_GUIDANCE, TWO_RATE_GOAL_MODE, TWO_RATE_MOVEMENT_GUIDANCE } from './action-goal.js';
import { ResearchModelError, timedModel } from './common.js';
import { modelProviderRequest } from './provider-http.js';
import { STRUCTURED_NEAR_PROFILE, STRUCTURED_TRAIL_PROFILE, validateVisualImage, VISUAL_IMAGE_REFERENCE } from './visual-input.js';
import { RESEARCH_CLOSED_PLAN_FEEDBACK, RESEARCH_CLOSED_PLAN_HISTORY_FEEDBACK, RESEARCH_EXECUTED_PLAN_FEEDBACK,
  RESEARCH_SLOTS_COUNT, RESEARCH_SLOT_MS, researchCandidates } from '../../../shared/survivors-research-contract.js';

import { DREX_PATH_MICRO_PROMPT_VERSION, LOCAL_PATH_MICRO_MODE, DREX_TIMING_MICRO_PROMPT_VERSION, DREX_COVERAGE_MICRO_PROMPT_VERSION, DREX_WEAPON_MICRO_PROMPT_VERSION, DREX_BRIEF_MICRO_PROMPT_VERSION, DREX_SHARED_MICRO_PROMPT_VERSION, DREX_TACTICS_MICRO_PROMPT_VERSION, localPathMicroChoices, localPathMicroInput, drexPathMicroInput, providerDirectionInput, localPathMicroPlan } from './local-path-micro.js';
import { NACE_ACTION_PATH, NACE_MODEL, NACE_PROFILE, NACE_PROVIDER, naceDirectionAnswer, nacePathAnswer, naceUpgradeAnswer } from './nace-decisions.js';

export const DECISIONS_MODEL = 'gpt-6-luna';
export const DECISIONS_PROVIDER = 'openai-decisions';
export const DECISIONS_PROFILE = 'openai-decisions-choice-v1';
export const DECISIONS_PROMPT_VERSION = 'survivors-openai-decisions-choice-v5';
export const DECISIONS_PATH = '/v1/decisions';
export const TACTICAL_MOVEMENT_PROMPT_SUFFIX = '-tactical-v2';
export const SLOT_MOVEMENT_PROMPT_SUFFIX = '-tactical-v3';
export const STRUCTURED_TRAIL_PATH_GUIDANCE = [
  'In the structured image, control the central near-white diamond.',
  'Green diamonds are experience gems; pink or red circles are enemies.',
  'The amber chevron shows facing, not a target. Right is +x and down is +y.',
  'Choose the path that keeps you safe and makes progress toward collecting experience gems.',
  'If an un-attracted experience gem is safely reachable, choose a path that enters its pickup radius.',
  'If it is farther away, choose a safe path that reduces its distance and reassess at the next observation.',
  'If none is safely approachable, keep a clear exit and look for a safe opportunity to fight nearby enemies for drops.',
].join(' ');
const PLAN_FEEDBACK_FIELDS = 'dx and dy are signed displacement in world units, executed_ticks counts the simulated ticks in that prefix, and hp_delta is the net HP change during those same ticks. age_ticks counts simulated ticks since the last executed tick, with 0 meaning this observation tick. The receipt omits unexecuted steps and does not identify the cause of any HP change.';
export const EXECUTED_PLAN_FEEDBACK_GUIDANCE = 'When present, player.previous_movement summarizes the latest applied plan through its last executed tick. ' + PLAN_FEEDBACK_FIELDS;
export const CLOSED_PLAN_FEEDBACK_GUIDANCE = 'When present, player.previous_movement summarizes the most recently ended movement plan through its last executed tick, excluding the current unfinished plan. ' + PLAN_FEEDBACK_FIELDS;
export const CLOSED_PLAN_HISTORY_GUIDANCE = [
  'player.movement_history lists up to four closed movement plans, oldest first.',
  'dx and dy are signed net displacement in world units. Turns may cancel out in net displacement.',
  'executed_ticks counts actual movement ticks (1 tick = 1/60 second), and hp_delta is net HP change over those ticks.',
  'age_ticks counts ticks since the last executed tick, with 0 meaning this observation tick.',
  'These past outcomes describe distance over time and do not recommend continuing a direction.',
].join(' ');
const planFeedbackGuidance = new Map([
  [RESEARCH_EXECUTED_PLAN_FEEDBACK, EXECUTED_PLAN_FEEDBACK_GUIDANCE],
  [RESEARCH_CLOSED_PLAN_FEEDBACK, CLOSED_PLAN_FEEDBACK_GUIDANCE],
]);
export const TRAINING_TACTICS_CONDITION = 'tactical-observation-v1';

const SEQUENCE_MOVEMENT_STRATEGY = [
  'Repeatedly standing still leaves you nearly immobile and lets approaching enemies deal damage or kill you.',
  'If enemies are in contact, closing to contact, or your HP is falling, move away from the threat or through a clear gap.',
  'When the path is safe, move toward visible experience gems that are not already being collected.',
  'Stand still only for a specific safe tactical reason, such as letting an already attracted gem reach you.',
].join(' ');
export const DEFAULT_MOVEMENT_STRATEGY = [
  'Repeatedly standing still leaves you nearly immobile and lets approaching enemies deal damage or kill you.',
  'If enemies are in contact, closing to contact, or your HP is falling, move away from the threat or through a clear gap.',
  'If you observe HP falling while already moving, reassess your direction using the latest observation.',
  'When the path is safe, move toward visible experience gems that are not already being collected.',
  'Select a wait only for a specific safe tactical reason, such as letting an already attracted gem reach you.',
].join(' ');
export const WHIP_GUIDANCE = 'If you have a whip, its first lash strikes left or right according to your facing, which follows the horizontal part of your last move and stays the same when moving straight up or down or standing still, while extra lashes can strike behind you.';
const TRAINING_TACTICS_GUIDANCE = [
  'The training_tactics field describes this observation tick. Facing is current. For the primary whip, next_ticks counts simulation ticks until its next first lash.',
  'The left and right arrays give the full-size lash bounds [minX, minY, maxX, maxY] relative to the player at emission.',
  'Each heading measures a straight 500 ms segment at the observed speed, with visible enemies and gems held stationary.',
  'Gem approach is the largest reduction in distance to any visible uncollected experience gem along the segment.',
  'Enemy clearance is the smallest distance from the path to any visible enemy circle and is negative inside a circle. Null means no matching visible entity.',
  'Use these measurements with the current offsets and account for approaching enemies and elapsed time before application.',
].join(' ');

export function validTrainingStrategy(value) {
  return typeof value === 'string' && value.trim().length > 0 && new TextEncoder().encode(value).length <= 4096 &&
    !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
}

function movementGuidance(slots, observation, strategy = slots ? DEFAULT_MOVEMENT_STRATEGY : SEQUENCE_MOVEMENT_STRATEGY, controls) {
  const intent = observation.training_intent;
  const goalGuidance = intent?.mode === TWO_RATE_GOAL_MODE ? TWO_RATE_MOVEMENT_GUIDANCE : GOAL_MOVEMENT_GUIDANCE;
  const tactics = strategy + ' ' + WHIP_GUIDANCE + (observation.training_tactics ? ' ' + TRAINING_TACTICS_GUIDANCE : '') +
    (intent ? ' ' + goalGuidance : '');
  if (!slots) return tactics + ' Use up to six ordered segments with the listed durations within the 300 ms budget. ' +
    'Choose a hold long enough to make progress while the path stays safe. Stop intentionally stands still. END finishes the plan.';
  const scale = observation.player?.movement_distance;
  if (controls) return 'The ' + controls.question_count + ' ordered choices cover one 500 ms movement plan. ' +
    'Each choice governs its entire time window. Repeat safe headings or turn across windows when available. ' + tactics;
  return 'One plan contains ' + RESEARCH_SLOTS_COUNT + ' consecutive ' + RESEARCH_SLOT_MS + ' ms slots (' +
    (RESEARCH_SLOTS_COUNT * RESEARCH_SLOT_MS) + ' ms total). A single move covers a short distance.' +
    (Number.isFinite(scale?.unobstructed_50_ms) ? ' Your unobstructed 50 ms distance is ' + scale.unobstructed_50_ms + ' world units.' : '') +
    ' Repeat a safe heading across slots to accumulate distance. Use a direct diagonal or change headings across slots to turn or arc around a threat.' +
    ' Each question shares the same observation and cannot see earlier answers. Wait means standing still for that slot. ' + tactics;
}

function sequenceUpgradeCandidates(observation, candidates) {
  const offer = observation.upgrade_offer;
  if (!offer) return null;
  if (!Array.isArray(offer.options) || !offer.options.length) {
    throw new ResearchModelError('invalid_observation', 'Expected a nonempty public upgrade offer');
  }
  const expected = researchCandidates(SEQUENCE_ACTION_PROFILE, offer)
    .filter(candidate => candidate.id.startsWith('choose:'));
  const upgrades = candidates.filter(candidate => candidate.id.startsWith('choose:'));
  if (upgrades.length !== expected.length || !expected.every(option =>
    validActionSequence([option.id], upgrades) && upgrades.some(candidate =>
      candidate.id === option.id && candidate.description === option.description))) {
    throw new ResearchModelError('invalid_observation', 'Upgrade choices must match the public upgrade offer');
  }
  return expected;
}

export function decisionModelInput(model, { observation, candidates, image, action_profile, slot_sample, movement_prompt_sample, training_strategy, training_controls, movement_protocol, path_question_guidance, whole_path_context, path_choice_order, movement_feedback, whole_path_question_mode, path_choice_format, advisor_role, advisor_context, strategy_context, combat_context, local_feedback, local_facing, local_projection }) {
  if(combat_context!==undefined && (advisor_role!=='cardinal-advisor'||!validCombatContext(combat_context,observation?.tick))) throw new ResearchModelError('invalid_combat_context','Invalid same-tick combat context');
  if (strategy_context !== undefined && (advisor_role !== 'cardinal-advisor' || !validStrategyEnvelope(strategy_context,observation?.tick))) throw new ResearchModelError('invalid_strategy_context', 'Invalid strategic context');
  const coverage=action_profile===RESEARCH_COVERAGE_SEQUENCE_PROFILE;
  if (advisor_role === 'local-micro') {
    const weaponAware=local_projection?.schema===DREX_WEAPON_MICRO_PROJECTION_SCHEMA;
    if (model!==DECISIONS_MODEL || (!coverage && action_profile!==SEQUENCE_ACTION_PROFILE) || observation?.profile!=='state-detail-v1' ||
        observation.upgrade_offer || image?.profile!=='local-micro-v1' || !validActionContext({observation,candidates},{min:2,max:255,allowWeaponState:weaponAware}) ||
        !directionCandidatesMatch(candidates,action_profile) || !validCardinalContext('cardinal-micro',advisor_context,observation) ||
        !validLocalFeedback(local_feedback) || ![null,-1,1].includes(local_facing) || strategy_context!==undefined)
      throw new ResearchModelError('invalid_local_micro','Invalid local micro input');
    validateVisualImage(image,observation.tick,'local-micro-v1');
    const targetHandoff=isDrexLocalMicroProjectionSchema(local_projection?.schema);
    const projection=projectLocalMicro({observation,advisorHint:advisor_context,feedback:local_feedback,facing:local_facing,targetHandoff,weaponAware});
    if (JSON.stringify(projection)!==JSON.stringify(local_projection)) throw new ResearchModelError('invalid_local_micro','Local projection mismatch');
    let legend=`The near-white diamond at the center is the only player. Green diamonds are the experience gems in local_gems; near_gems is the subset that can enter pickup range with one 100 ms step. Gems marked being_collected are already moving toward the player. Pink or red marks are threats. The amber chevron shows the current left or right facing; moving vertically or stopping retains the last horizontal facing. The image shows only supplied local entities. Right is +x and down is +y. Scale ${projection.viewport.scale_px_per_unit} pixels per world unit.`;
    if(targetHandoff)legend+=' Match guidance.target.id to the selected local_gems id. Only a currently visible target inside the local circle has coordinates.';
    if(weaponAware)legend+=' Blue outlines mark current player whip hitboxes clipped to the local circle.';
    return {model,input:[{role:'user',content:[{type:'input_text',text:JSON.stringify(projection)},
      {type:'input_image',image_url:VISUAL_IMAGE_REFERENCE},{type:'input_text',text:legend}]}],questions:[localMicroQuestion(projection)]};
  }
  if (local_feedback!==undefined || local_facing!==undefined || local_projection!==undefined) throw new ResearchModelError('invalid_local_micro','Unexpected local fields');
  const slots = action_profile === RESEARCH_SLOTS_PROFILE;
  const wholePath = isWholePathMode(movement_protocol);
  const direction = Object.hasOwn(observation ?? {}, 'direction_context');
  const cardinal = advisor_role === 'cardinal-advisor' || advisor_role === 'cardinal-micro';
  const advisory = !cardinal && (advisor_role !== undefined || advisor_context !== undefined);
  if (cardinal && (observation?.upgrade_offer || direction || !validCardinalContext(advisor_role, advisor_context, observation) ||
      [slot_sample, movement_prompt_sample, training_strategy, training_controls, movement_protocol, path_question_guidance,
        whole_path_context, path_choice_order, movement_feedback, whole_path_question_mode, path_choice_format]
        .some(value => value !== undefined))) {
    throw new ResearchModelError('invalid_advisor_context', 'Cardinal requests require a current-frame observation');
  }
  if (advisory && (observation?.upgrade_offer || !direction || !validAdvisorContext(advisor_role, advisor_context, observation) ||
      [slot_sample, movement_prompt_sample, training_strategy, training_controls, movement_protocol, path_question_guidance,
        whole_path_context, path_choice_order, movement_feedback, whole_path_question_mode, path_choice_format]
        .some(value => value !== undefined))) {
    throw new ResearchModelError('invalid_advisor_context', 'Advisor requests require an original directional movement observation');
  }
  const pathOnly = whole_path_question_mode === WHOLE_PATH_ONLY_QUESTION_MODE;
  const planHistory = movement_feedback === RESEARCH_CLOSED_PLAN_HISTORY_FEEDBACK;
  const trail = image?.profile === STRUCTURED_TRAIL_PROFILE;
  if (trail && (!planHistory || whole_path_question_mode !== undefined || path_choice_format !== undefined)) {
    throw new ResearchModelError('invalid_visual_input', 'Actual trail images require original whole-path Decisions with closed plan history');
  }
  if (path_choice_format !== undefined && (path_choice_format !== WHOLE_PATH_COMPACT_SEQUENCE_FORMAT ||
      movement_feedback !== RESEARCH_CLOSED_PLAN_HISTORY_FEEDBACK || whole_path_question_mode !== undefined)) {
    throw new ResearchModelError('invalid_path_choice_format', 'Compact choices require the closed plan history movement profile');
  }
  if (whole_path_question_mode !== undefined && (!pathOnly || model !== DECISIONS_MODEL ||
      movement_protocol !== WHOLE_PATH_MODE || image?.profile !== 'structured-v1' || observation?.upgrade_offer ||
      Object.hasOwn(observation ?? {}, 'training_intent') || movement_feedback !== undefined ||
      whole_path_context !== undefined || path_choice_order !== undefined ||
      Object.hasOwn(observation?.player ?? {}, 'previous_movement') ||
      Object.hasOwn(observation?.player ?? {}, 'movement_receipts') ||
      Object.hasOwn(observation?.player ?? {}, 'movement_receipt_offset'))) {
    throw new ResearchModelError('invalid_whole_path_question_mode', 'Path-only Decisions requires the original structured whole-path movement profile');
  }
  const near = image?.profile === STRUCTURED_NEAR_PROFILE;
  if (near && (action_profile !== SEQUENCE_ACTION_PROFILE || observation?.profile !== 'state-detail-v1' ||
      (!observation.upgrade_offer && (movement_protocol !== WHOLE_PATH_MODE || observation.training_intent?.prior !== null)) ||
      slot_sample !== undefined || movement_prompt_sample !== undefined || training_controls !== undefined ||
      movement_feedback !== undefined || whole_path_context !== undefined || path_choice_order !== undefined ||
      Object.hasOwn(observation.player ?? {}, 'previous_movement') ||
      Object.hasOwn(observation.player ?? {}, 'movement_receipts') ||
      Object.hasOwn(observation.player ?? {}, 'movement_receipt_offset'))) {
    throw new ResearchModelError('invalid_movement_protocol', 'Near-view Decisions requires the original stateless sequence profile');
  }
  const eightDirection = movement_protocol === WHOLE_PATH_EIGHT_DIRECTION_MODE;
  const staggered = movement_protocol === WHOLE_PATH_STAGGERED_MODE;
  if (movement_protocol !== undefined && (!wholePath || action_profile !== SEQUENCE_ACTION_PROFILE ||
      (!near && !trail && image?.profile !== 'structured-v1') || observation?.profile !== 'state-detail-v1' || observation.upgrade_offer ||
      (!pathOnly && observation.training_intent?.mode !== 'goal-stateless-v1') || !validTrainingStrategy(training_strategy) ||
      slot_sample !== undefined || movement_prompt_sample !== undefined || training_controls !== undefined)) {
    throw new ResearchModelError('invalid_movement_protocol', 'Whole-path movement requires a structured stateless sequence observation');
  }
  if ((eightDirection || staggered) && (observation.training_intent?.prior !== null || movement_feedback !== undefined ||
      whole_path_context !== undefined || path_choice_order !== undefined ||
      Object.hasOwn(observation.player ?? {}, 'movement_receipts') || Object.hasOwn(observation.player ?? {}, 'movement_receipt_offset'))) {
    throw new ResearchModelError('invalid_movement_protocol', eightDirection
      ? 'Eight-direction paths require unmodified stateless whole-path movement'
      : '50/50/200 ms paths require unmodified stateless whole-path movement');
  }
  const feedbackGuidance = planFeedbackGuidance.get(movement_feedback);
  if (movement_feedback !== undefined && (!(feedbackGuidance || planHistory) || !wholePath ||
      observation.training_intent?.prior !== null || Object.hasOwn(observation.player ?? {}, 'movement_receipts') ||
      Object.hasOwn(observation.player ?? {}, 'movement_receipt_offset'))) {
    throw new ResearchModelError('invalid_movement_feedback', 'Plan feedback requires structured stateless whole-path movement');
  }
  if (planHistory && (model !== DECISIONS_MODEL || movement_protocol !== WHOLE_PATH_MODE ||
      observation.terminal !== false || whole_path_context !== undefined || path_choice_order !== undefined ||
      Object.hasOwn(observation, 'training_tactics') || Object.hasOwn(observation.player ?? {}, 'previous_movement'))) {
    throw new ResearchModelError('invalid_movement_feedback', 'Closed plan history requires the original stateless whole-path movement profile');
  }
  if (path_choice_order !== undefined && (!wholePath || path_choice_order !== WHOLE_PATH_TICK_ROTATION)) {
    throw new ResearchModelError('invalid_path_choice_order', 'Expected a supported whole-path choice order');
  }
  if (whole_path_context !== undefined && (!wholePath || whole_path_context !== STATELESS_CURRENT_CONTEXT ||
      observation.training_intent?.prior !== null)) {
    throw new ResearchModelError('invalid_whole_path_context', 'Expected the stateless current-observation context');
  }
  if (path_question_guidance !== undefined && !wholePath) {
    throw new ResearchModelError('invalid_movement_protocol', 'Path question guidance requires whole-path movement');
  }
  let pathQuestionGuidance;
  try { pathQuestionGuidance = validateWholePathQuestionGuidance(path_question_guidance); }
  catch { throw new ResearchModelError('invalid_path_question_guidance', 'Invalid path question guidance'); }
  if (trail && pathQuestionGuidance?.guidance !== STRUCTURED_TRAIL_PATH_GUIDANCE) {
    throw new ResearchModelError('invalid_path_question_guidance', 'Actual trail Decisions requires the original path question guidance');
  }
  if (training_strategy !== undefined && (!(slots || wholePath) || slot_sample || movement_prompt_sample || !validTrainingStrategy(training_strategy))) {
    throw new ResearchModelError('invalid_training_strategy', 'Expected a bounded fixed-slot training strategy');
  }
  if (training_controls !== undefined && (training_strategy === undefined || observation?.upgrade_offer ||
      !validTrainingControls(training_controls))) throw new ResearchModelError('invalid_training_controls', 'Invalid training choices or question count');
  const customControls = isDefaultTrainingControls(training_controls) ? undefined : training_controls;
  const trainingVisualAllowed = image === undefined || (image?.profile === 'structured-v1' &&
    observation?.training_intent?.mode === 'goal-stateless-v1');
  const allowTraining = slots && training_strategy !== undefined && training_controls === undefined &&
    trainingVisualAllowed && slot_sample === undefined && movement_prompt_sample === undefined &&
    observation?.profile === 'state-detail-v1' && !observation.upgrade_offer &&
    Number.isFinite(observation.player?.movement_distance?.unobstructed_500_ms) &&
    observation.player.movement_distance.unobstructed_500_ms >= 0;
  if (!validActionContext({ observation, candidates }, { min: slots ? 1 : 2, max: 255, allowTraining: allowTraining || wholePath,
    allowPlanFeedback: Boolean(feedbackGuidance), allowPlanHistory: planHistory, allowDirection: direction })) {
    throw new ResearchModelError('invalid_observation', 'Decisions requires 2–255 unique research candidates');
  }
  const content = [{ type: 'input_text', text: JSON.stringify(slots ? slotObservation(observation, slot_sample) : observation) }];
  if (image?.profile === 'trajectory-v1' && (!slots || !Number.isFinite(observation.player?.movement_distance?.unobstructed_50_ms))) {
    throw new ResearchModelError('invalid_visual_input', 'Trajectory image requires visible fixed-slot movement data');
  }
  if (image !== undefined) {
    validateVisualImage(image, observation.tick);
    content.push({ type: 'input_image', image_url: VISUAL_IMAGE_REFERENCE });
    const legend = structuredImageLegend(image.profile);
    if (legend) content.push({type: 'input_text', text: legend});
  }
  if (cardinal) {
    if (model !== DECISIONS_MODEL || (!coverage && action_profile !== SEQUENCE_ACTION_PROFILE) ||
        image?.profile !== 'structured-v1' || observation.profile !== 'state-detail-v1' ||
        !observation.player?.movement || !directionCandidatesMatch(candidates,action_profile) ||
        Object.hasOwn(observation, 'training_intent') || Object.hasOwn(observation, 'training_tactics') ||
        Object.hasOwn(observation.player, 'movement_receipts') || Object.hasOwn(observation.player, 'movement_receipt_offset')) {
      throw new ResearchModelError('invalid_observation', 'Cardinal mode requires the original structured sequence observation');
    }
    if (advisor_context !== null) content.push({type:'input_text', text:JSON.stringify({advisor_context})});
    if (strategy_context !== undefined) content.push({type:'input_text',text:JSON.stringify({strategy_context})});
    if (combat_context !== undefined) content.push({type:'input_text',text:JSON.stringify({combat_context})});
    const question = advisor_role === 'cardinal-advisor' ? cardinalAdvisorQuestion(advisor_context) : cardinalMicroQuestion();
    if (strategy_context !== undefined) {
      question.instructions = question.instructions.replace(
        'Choose a known crystal target and a cardinal direction that progresses toward collecting it.',
        'Choose a cardinal direction and a target or no target to carry out the current strategy, including creating collection opportunities by fighting when appropriate.');
      question.instructions += ' Use the supplied strategy_context as the current high-level plan. Reassess it against actual observations and progress; choose the direction and target yourself.';
    }
    return {model, input:[{role:'user', content}], questions:[question]};
  }
  if (direction) {
    const prior = observation.direction_context;
    if (model !== DECISIONS_MODEL || action_profile !== SEQUENCE_ACTION_PROFILE || image?.profile !== 'structured-v1' ||
        observation.profile !== 'state-detail-v1' || observation.upgrade_offer || !observation.player?.movement ||
        !directionCandidatesMatch(candidates) || (prior && prior.applied_tick > observation.tick) ||
        wholePath || slot_sample !== undefined || movement_prompt_sample !== undefined ||
        training_strategy !== undefined || training_controls !== undefined ||
        Object.hasOwn(observation, 'training_intent') || Object.hasOwn(observation, 'training_tactics') ||
        Object.hasOwn(observation.player, 'movement_receipts') ||
        Object.hasOwn(observation.player, 'movement_receipt_offset')) {
      throw new ResearchModelError('invalid_observation', 'Directional decisions require the original structured sequence observation');
    }
    const questions = advisor_role === 'advisor' ? [advisorQuestion(advisor_context)] : directionQuestions();
    if (advisory) content.push({type: 'input_text', text: JSON.stringify({advisor_context})});
    if (advisor_role === 'micro') questions.at(-1).instructions = MICRO_ADVICE_INSTRUCTIONS;
    return {model, input: [{role: 'user', content}], questions};
  }
  if (wholePath) {
    const expected = researchCandidates(SEQUENCE_ACTION_PROFILE);
    if (candidates.length !== expected.length || !expected.every(({ id, description }, index) =>
      candidates[index].id === id && candidates[index].description === description)) {
      throw new ResearchModelError('invalid_observation', 'Whole-path movement requires the exact sequence catalog');
    }
    const speed = observation.player?.speed;
    if (!Number.isFinite(speed) || speed < 0) {
      throw new ResearchModelError('invalid_observation', 'Whole-path movement requires current player speed');
    }
    const distance = ms => Number((speed * ms / 1000).toFixed(4));
    const policy = ACTION_POLICY.replace('Choose one action', 'Choose one ordered movement plan')
      .replace('Stop cancels movement. ', '')
      .replace('They are blue crystals and have kind "experience" in loot.', 'They have kind "experience" in loot.');
    const [firstHold, , thirdHold] = wholePathHoldDurations(movement_protocol);
    const planTiming = eightDirection
      ? 'One plan contains two consecutive 150 ms steps (300 ms total). Directions are up, up-right, right, down-right, down, down-left, left and up-left. Diagonal and cardinal movement have the same speed.'
      : (staggered
        ? 'One plan contains three consecutive steps of 50 ms, 50 ms and 200 ms (300 ms total). Only up, down, left and right are available.'
        : 'One plan contains three consecutive 100 ms steps (300 ms total). Only up, down, left and right are available.');
    const stepDistance = staggered
      ? 'each of the first two steps can travel ' + distance(firstHold) + ' world units, the third step can travel ' + distance(thirdHold)
      : 'one step can travel ' + distance(firstHold);
    content.push({ type: 'input_text', text: [policy, planTiming,
      'The steps begin at application. A new plan replaces any unfinished plan.',
      'At the observed speed, ' + stepDistance + ' world units and ' +
        (eightDirection ? 'two straight steps' : 'three straight steps') + ' can travel ' + distance(300) + ' world units.',
      training_strategy, WHIP_GUIDANCE,
      ...(!pathOnly ? [whole_path_context === STATELESS_CURRENT_CONTEXT ? STATELESS_CURRENT_MOVEMENT_GUIDANCE
        : GOAL_MOVEMENT_GUIDANCE.replace('Each movement answer', 'The movement answer')] : []),
      ...(observation.player?.previous_movement ? [feedbackGuidance] : []),
      ...(planHistory && observation.player?.movement_history ? [CLOSED_PLAN_HISTORY_GUIDANCE] : []),
    ].join(' ') });
    const offset = path_choice_order === WHOLE_PATH_TICK_ROTATION ? wholePathChoiceOffset(observation.tick) : 0;
    const questions = [wholePathQuestion(pathQuestionGuidance, offset, movement_protocol, path_choice_format)];
    if (!pathOnly) questions.push(goalQuestion(observation, whole_path_context));
    return { model, input: [{ role: 'user', content }], questions };
  }
  if ((slots || action_profile === SEQUENCE_ACTION_PROFILE) && !observation.upgrade_offer &&
      !slot_sample && movement_prompt_sample !== 'baseline') {
    content.push({ type: 'input_text', text: isGoalPlan(observation) ? training_strategy + ' ' + WHIP_GUIDANCE
      : movementGuidance(slots, observation, training_strategy, customControls) });
  }
  if (slots) {
    const questions = slotQuestions(observation, candidates, slot_sample, ACTION_POLICY, customControls);
    if (isGoalPlan(observation)) return {model, input: [{role: 'user', content}], questions: [goalQuestion(observation)]};
    if (asksGoal(observation)) questions.push(goalQuestion(observation));
    return { model, input: [{ role: 'user', content }], questions };
  }
  const choices = candidates.map(({ id, description }) => ({ value: id, description }));
  const sequence = action_profile === SEQUENCE_ACTION_PROFILE || (coverage && Boolean(observation.upgrade_offer));
  const upgrades = sequence ? sequenceUpgradeCandidates(observation, candidates) : null;
  if (upgrades) {
    return { model, input: [{ role: 'user', content }], questions: [{
      type: 'choice', name: 'action', instructions: ACTION_POLICY + ' Choose one offered upgrade now. An upgrade is executed by itself.',
      choices: upgrades.map(({id, description}) => ({ value: id, description })),
    }] };
  }
  const questions = sequence ? Array.from({ length: MAX_ACTION_SEGMENTS }, (_, index) => ({
    type: 'choice',
    name: 'action_' + (index + 1),
    instructions: [
      ACTION_POLICY, SEQUENCE_POLICY,
      'Choose only the action for ordered segment ' + (index + 1) + ' of the same short plan.',
      'Stop cancels movement and intentionally stands still. END marks the end of the movement plan.',
      index === 0 ? 'Choose the first action to take now.'
        : 'Choose END if your plan is complete by this slot. After the first END all remaining slots should also choose END. After an initial stop, every later slot must choose END.',
    ].join(' '),
    choices: index === 0 ? choices : [...choices, { value: SEQUENCE_END, description: 'End the plan without another action.' }],
  })) : [{ type: 'choice', name: 'action', instructions: ACTION_POLICY, choices }];
  return { model, input: [{ role: 'user', content }], questions };
}

export function restoreDecisionImage(input, image) {
  const [message] = input.input;
  const [text, attachment, ...rest] = message.content;
  if (attachment?.type !== 'input_image' || attachment.image_url !== VISUAL_IMAGE_REFERENCE) {
    throw new ResearchModelError('invalid_visual_input', 'Missing image reference in the Decisions request');
  }
  return { ...input, input: [{ ...message, content: [text, { ...attachment, image_url: image.data_url }, ...rest] }] };
}

export function decisionAnswer(data) {
  const answer = data?.answers?.[0];
  return Array.isArray(data?.answers) && data.answers.length === 1 && answer?.name === 'action' ? answer : null;
}

const probability = value => Number.isFinite(value) && value >= 0 && value <= 1;

function validateDecision(answer, choices) {
  if (answer?.type === 'refusal') throw new ResearchModelError('provider_refusal', 'Decisions declined to choose an action');
  const ids = new Set(choices);
  if (answer?.type !== 'choice' || !ids.has(answer.choice) || !probability(answer.confidence) ||
      !Array.isArray(answer.probabilities) || answer.probabilities.length !== ids.size ||
      !answer.probabilities.every(row => ids.delete(row?.value) && probability(row?.probability))) {
    throw new ResearchModelError('malformed', 'Decisions did not return a valid choice and probability for every candidate');
  }
  return answer.choice;
}

function selectDecision(raw, candidates, actionProfile, sample, observation, localActionId, controls, movementProtocol, wholePathQuestionMode, context) {
  if (context?.advisor_role === 'cardinal-micro' || context?.advisor_role === 'local-micro') {
    return decodeCardinal(raw, cardinalMicroQuestion(), validateDecision, 'cardinal-micro');
  }
  let data;
  try { data = JSON.parse(raw); } catch { /* invalid provider response */ }
  const choices = candidates.map(({ id }) => id);
  if (Object.hasOwn(observation, 'direction_context')) {
    const questions = directionQuestions();
    if (!Array.isArray(data?.answers) || data.answers.length !== questions.length ||
        !data.answers.every((answer, index) => answer?.name === questions[index].name)) {
      throw new ResearchModelError('malformed', 'Decisions did not return the threat, crystal and direction answers in order');
    }
    const movement = questions.map((question, index) =>
      validateDecision(data.answers[index], question.choices.map(({value}) => value))).at(-1);
    return [directionAction(movement)];
  }
  if (isWholePathMode(movementProtocol) && !observation.upgrade_offer) {
    const pathOnly = wholePathQuestionMode === WHOLE_PATH_ONLY_QUESTION_MODE;
    const questions = [wholePathQuestion(undefined, 0, movementProtocol)];
    if (!pathOnly) questions.push(goalQuestion(observation));
    if (!Array.isArray(data?.answers) || data.answers.length !== questions.length ||
        !data.answers.every((answer, index) => answer?.name === questions[index].name)) {
      throw new ResearchModelError('malformed', pathOnly ? 'Decisions did not return one path answer'
        : 'Decisions did not return the path and goal answers in order');
    }
    const [path, goalId] = questions.map((question, index) =>
      validateDecision(data.answers[index], question.choices.map(({ value }) => value)));
    const holds = wholePathHoldDurations(movementProtocol);
    const actions = wholePathDirections(path, movementProtocol)
      .map((direction, index) => 'move:' + direction + ':hold:' + holds[index]);
    if (!validActionSequence(actions, candidates)) {
      throw new ResearchModelError('invalid_action_sequence', 'Decisions returned an invalid whole-path plan');
    }
    return { action_ids: actions, ...(!pathOnly && { goal_id: goalId }) };
  }
  if (actionProfile === RESEARCH_SLOTS_PROFILE) {
    if (choices.length === 1 && choices[0].startsWith('choose:')) return [choices[0]];
    const plan = isGoalPlan(observation);
    const names = plan ? [] : slotQuestionNames(candidates, sample, controls);
    const goal = asksGoal(observation) && goalQuestion(observation);
    if (goal) names.push(GOAL_QUESTION);
    if (!Array.isArray(data?.answers) || data.answers.length !== names.length ||
        !data.answers.every((answer, index) => answer?.name === names[index])) {
      throw new ResearchModelError('malformed', 'Decisions did not return the complete ordered slot choices');
    }
    const movement = goal ? data.answers.slice(0, -1) : data.answers;
    const selected = movement.map(answer => validateDecision(answer, controls?.action_ids ?? choices));
    if (goal) return {...(!plan && {action_ids: selected}),
      goal_id: validateDecision(data.answers.at(-1), goal.choices.map(({value}) => value))};
    return controls ? selected.flatMap(id => Array(RESEARCH_SLOTS_COUNT / controls.question_count).fill(id)) : selected;
  }
  if (actionProfile !== SEQUENCE_ACTION_PROFILE) return validateDecision(decisionAnswer(data), choices);
  const upgrades = sequenceUpgradeCandidates(observation, candidates);
  if (upgrades) {
    if (upgrades.length === 1 && raw === null && localActionId === upgrades[0].id) return [localActionId];
    return [validateDecision(decisionAnswer(data), upgrades.map(({id}) => id))];
  }
  if (!Array.isArray(data?.answers) || data.answers.length !== MAX_ACTION_SEGMENTS ||
      !data.answers.every((answer, index) => answer?.name === 'action_' + (index + 1))) {
    throw new ResearchModelError('malformed', 'Decisions did not return all six ordered action answers');
  }
  const slots = data.answers.map((answer, index) => validateDecision(answer, index ? [...choices, SEQUENCE_END] : choices));
  const end = slots.indexOf(SEQUENCE_END);
  const actions = end < 0 ? slots : slots.slice(0, end);
  if ((end >= 0 && slots.slice(end).some(slot => slot !== SEQUENCE_END)) || !validActionSequence(actions, candidates)) {
    throw new ResearchModelError('invalid_action_sequence', 'Decisions returned an invalid ordered plan');
  }
  return actions;
}

export function createOpenAIDecisionsModel(config) {
  if (config.model !== DECISIONS_MODEL || config.generation_profile !== DECISIONS_PROFILE) {
    throw new TypeError('Load the saved OpenAI Decisions model connection first');
  }
  validateSlotSample(config.slot_sample);
  const trainingStrategy = config.training_strategy;
  const trainingControls = config.training_controls;
  const movementProtocol = config.movement_protocol;
  const wholePathQuestionMode = config.whole_path_question_mode;
  if (wholePathQuestionMode !== undefined && (wholePathQuestionMode !== WHOLE_PATH_ONLY_QUESTION_MODE ||
      movementProtocol !== WHOLE_PATH_MODE || config.localConnection !== true || config.apiKey ||
      config.whole_path_context !== undefined || config.path_choice_order !== undefined || config.movement_feedback !== undefined ||
      config.training_controls !== undefined || config.slot_sample !== undefined || config.movement_prompt_sample !== undefined)) {
    throw new TypeError('Path-only Decisions requires the saved local original whole-path mode');
  }
  const wholePathContext = config.whole_path_context;
  const pathChoiceOrder = config.path_choice_order;
  const pathChoiceFormat = config.path_choice_format;
  const movementFeedback = config.movement_feedback;
  const planHistory = movementFeedback === RESEARCH_CLOSED_PLAN_HISTORY_FEEDBACK;
  if (pathChoiceFormat !== undefined && (pathChoiceFormat !== WHOLE_PATH_COMPACT_SEQUENCE_FORMAT || !planHistory)) {
    throw new TypeError('Compact choices require the closed plan history movement profile');
  }
  if (movementProtocol === WHOLE_PATH_EIGHT_DIRECTION_MODE &&
      (movementFeedback !== undefined || wholePathContext !== undefined || pathChoiceOrder !== undefined)) {
    throw new TypeError('Eight-direction paths require unmodified stateless whole-path movement');
  }
  if (movementFeedback !== undefined &&
      (movementProtocol !== WHOLE_PATH_MODE || !(planHistory || planFeedbackGuidance.has(movementFeedback)))) {
    throw new TypeError('Invalid whole-path plan feedback');
  }
  if (planHistory && (config.localConnection !== true || config.apiKey !== undefined ||
      wholePathContext !== undefined || pathChoiceOrder !== undefined || config.movement_prompt_sample !== undefined)) {
    throw new TypeError('Closed plan history requires the saved local original whole-path mode');
  }
  if (pathChoiceOrder !== undefined && (movementProtocol !== WHOLE_PATH_MODE || pathChoiceOrder !== WHOLE_PATH_TICK_ROTATION)) {
    throw new TypeError('Invalid whole-path choice order');
  }
  if (wholePathContext !== undefined && (movementProtocol !== WHOLE_PATH_MODE || wholePathContext !== STATELESS_CURRENT_CONTEXT)) {
    throw new TypeError('Invalid whole-path context');
  }
  const pathQuestionGuidance = validateWholePathQuestionGuidance(config.path_question_guidance);
  if (pathQuestionGuidance && !isWholePathMode(movementProtocol)) {
    throw new TypeError('Path question guidance requires whole-path movement');
  }
  if (movementProtocol !== undefined && (!isWholePathMode(movementProtocol) || !trainingStrategy ||
      trainingControls !== undefined || config.slot_sample !== undefined)) {
    throw new TypeError('Whole-path movement requires the local training strategy');
  }
  if (trainingStrategy !== undefined && (!config.localConnection || config.apiKey || config.slot_sample || !validTrainingStrategy(trainingStrategy))) {
    throw new TypeError('Training strategy requires a configured local connection');
  }
  if (trainingControls !== undefined && (!trainingStrategy || !validTrainingControls(trainingControls))) {
    throw new TypeError('Training controls require a valid training strategy and options');
  }
  const slotSample = config.slot_sample && Object.freeze({ ...config.slot_sample });
  const metadata = {
    provider: DECISIONS_PROVIDER, model: DECISIONS_MODEL, simulated: false, upstream_dispatched: null,
  };
  const model = timedModel({
    kind: 'openai-decisions', provider: DECISIONS_PROVIDER, model: DECISIONS_MODEL, endpoint: DECISIONS_PATH,
    connection_ref: (config.apiKey || config.localConnection) ? 'local-research-key' : ACTION_CONNECTION, prompt_version: DECISIONS_PROMPT_VERSION,
    generation_profile: DECISIONS_PROFILE, generation_parameters: null, timeout_ms: config.timeout_ms, ...(movementProtocol && { movement_protocol: movementProtocol }),
    ...(wholePathQuestionMode && { whole_path_question_mode: wholePathQuestionMode }),
    ...(wholePathContext && { whole_path_context: wholePathContext }),
    ...(movementFeedback && { movement_feedback: movementFeedback }),
    ...(pathChoiceFormat && { path_choice_format: pathChoiceFormat }),
    ...(pathChoiceOrder && { path_choice_order: pathChoiceOrder }), ...(slotSample && { slot_sample: slotSample }),
  }, modelProviderRequest('/api/survivors-research/model/decisions/action', {
    model: DECISIONS_MODEL, configuredProfile: DECISIONS_PROFILE, timeout_ms: config.timeout_ms, metadata, apiKey: config.apiKey,
    localConnection: config.localConnection, slotSample, trainingStrategy, trainingControls, movementProtocol, wholePathQuestionMode, pathQuestionGuidance, wholePathContext, pathChoiceOrder, movementFeedback, pathChoiceFormat,
  }), (raw, candidates, actionProfile, observation, localActionId, context) =>
    selectDecision(raw, candidates, actionProfile, slotSample, observation, localActionId,
      observation.upgrade_offer ? undefined : trainingControls, movementProtocol, wholePathQuestionMode, context), {
    prepare: input => decisionModelInput(DECISIONS_MODEL, { ...input, slot_sample: slotSample,
      training_strategy: input.observation.upgrade_offer ? undefined : trainingStrategy,
      training_controls: input.observation.upgrade_offer ? undefined : trainingControls,
      movement_protocol: input.observation.upgrade_offer ? undefined : movementProtocol,
      whole_path_question_mode: input.observation.upgrade_offer ? undefined : wholePathQuestionMode,
      path_question_guidance: input.observation.upgrade_offer ? undefined : pathQuestionGuidance,
      whole_path_context: input.observation.upgrade_offer ? undefined : wholePathContext,
      path_choice_order: input.observation.upgrade_offer ? undefined : pathChoiceOrder,
      path_choice_format: input.observation.upgrade_offer ? undefined : pathChoiceFormat,
      movement_feedback: input.observation.upgrade_offer ? undefined : movementFeedback }),
    metadata, transportMeasuredByRequest: true,
  });
  return {...model, decide(context) {
    if (context.advisor_role === 'advisor') throw new TypeError('Advisor requests require the read-only adapter');
    if (isGoalPlan(context.observation)) throw new TypeError('Goal-only requests require planGoal');
    return model.decide(context);
  }, planGoal(context) {
    if (!isGoalPlan(context.observation)) throw new TypeError('Expected a two-rate goal planning observation');
    return model.decide(context);
  }};
}

export function createNaceUpgradeModel(){
  const timeout_ms=10000;
  const metadata={provider:NACE_PROVIDER,model:NACE_MODEL,simulated:false,upstream_dispatched:null};
  return timedModel({timeout_ms},modelProviderRequest(NACE_ACTION_PATH,{
    model:NACE_MODEL,configuredProfile:NACE_PROFILE,timeout_ms,metadata,localConnection:true,
  }),(raw,candidates,profile,observation)=>{
    const choices=sequenceUpgradeCandidates(observation,candidates);
    if(!choices)throw new ResearchModelError('invalid_observation','Missing public upgrade offer');
    return [naceUpgradeAnswer(JSON.parse(raw),choices.map(({id})=>({value:id}))).choice];
  },{
    prepare:context=>decisionModelInput(DECISIONS_MODEL,context),metadata,transportMeasuredByRequest:true,
  });
}

export function createLocalPathMicroModel(model,{targetHandoff=false,actionProfile,weaponAware=false,briefAware=false,sharedFactsAware=false,tacticsAware=false}={}) {
  if (model !== DECISIONS_MODEL && model !== NACE_MODEL) throw new TypeError('Unknown local path micro model');
  const nace = model === NACE_MODEL;
  const provider = nace ? NACE_PROVIDER : DECISIONS_PROVIDER;
  const profile = nace ? NACE_PROFILE : DECISIONS_PROFILE;
  const endpoint = nace ? '/v1/systemone' : DECISIONS_PATH;
  const timeout_ms = 10000;
  const metadata = {provider, model, simulated:false, upstream_dispatched:null};
  const coveragePrompt = tacticsAware ? DREX_TACTICS_MICRO_PROMPT_VERSION : sharedFactsAware ? DREX_SHARED_MICRO_PROMPT_VERSION : briefAware ? DREX_BRIEF_MICRO_PROMPT_VERSION : weaponAware ? DREX_WEAPON_MICRO_PROMPT_VERSION : DREX_COVERAGE_MICRO_PROMPT_VERSION;
  return timedModel({
    kind:provider, provider, model, endpoint, connection_ref:nace ? 'local-nace-key' : 'local-research-key', generation_profile:profile,
    generation_parameters:null, timeout_ms, movement_question_mode:LOCAL_PATH_MICRO_MODE,
    prompt_version:DECISIONS_PROMPT_VERSION + '-' + (nace ? targetHandoff?(actionProfile===RESEARCH_COVERAGE_SEQUENCE_PROFILE?coveragePrompt:DREX_TIMING_MICRO_PROMPT_VERSION):DREX_PATH_MICRO_PROMPT_VERSION : LOCAL_PATH_MICRO_MODE),
  }, modelProviderRequest(nace ? NACE_ACTION_PATH : '/api/survivors-research/model/decisions/action', {
    model, configuredProfile:profile, timeout_ms, metadata, localConnection:true, localPathMicro:true,
  }), raw => {
    const data = JSON.parse(raw);
    if (nace) return localPathMicroPlan(nacePathAnswer(data, localPathMicroChoices).choice,actionProfile);
    if (!Array.isArray(data?.answers) || data.answers.length !== 1 || data.answers[0]?.name !== 'path') {
      throw new ResearchModelError('malformed', 'Decisions did not return one path answer');
    }
    return localPathMicroPlan(validateDecision(data.answers[0], localPathMicroChoices.map(({value}) => value)));
  }, {
    prepare:context => {
      const input=decisionModelInput(DECISIONS_MODEL,context);
      return nace ? drexPathMicroInput(input,context.provider_profile,context.action_profile) : localPathMicroInput(input);
    },
    metadata, transportMeasuredByRequest:true,
  });
}

export function createDirectionalAdvisor() {
  const metadata = {provider: DECISIONS_PROVIDER, model: DECISIONS_MODEL, simulated: false, upstream_dispatched: null};
  const transport = modelProviderRequest('/api/survivors-research/model/decisions/action', {
    model: DECISIONS_MODEL, configuredProfile: DECISIONS_PROFILE, timeout_ms: ADVISOR_TIMEOUT_MS,
    metadata, localConnection: true,
  });
  const adapter = timedModel({timeout_ms: ADVISOR_TIMEOUT_MS}, transport,
    (raw, candidates, profile, observation, local, context) =>
      ({guidance: decodeAdvisorChoice(raw, context.advisor_context, validateDecision)}),
    {prepare: context => decisionModelInput(DECISIONS_MODEL, context), metadata, transportMeasuredByRequest: true});
  return {advise: context => adapter.decide({...context, advisor_role: 'advisor'})};
}

export function createCardinalAdvisor(model=DECISIONS_MODEL) {
  if(model!==DECISIONS_MODEL&&model!==NACE_MODEL)throw new TypeError('Unknown cardinal advisor model');
  const nace=model===NACE_MODEL;
  const provider=nace?NACE_PROVIDER:DECISIONS_PROVIDER;
  const metadata={provider,model,simulated:false,upstream_dispatched:null};
  const transport=modelProviderRequest(nace?NACE_ACTION_PATH:'/api/survivors-research/model/decisions/action', {
    model,configuredProfile:nace?NACE_PROFILE:DECISIONS_PROFILE,timeout_ms:ADVISOR_TIMEOUT_MS,
    metadata,localConnection:true,
  });
  const adapter=timedModel({timeout_ms:ADVISOR_TIMEOUT_MS},transport,
    (raw,candidates,profile,observation,local,context)=>{
      const question=cardinalAdvisorQuestion(context.advisor_context);
      if(!nace)return decodeCardinal(raw,question,validateDecision,'cardinal-advisor');
      return {guidance:cardinalGuidance(naceDirectionAnswer(JSON.parse(raw),question.choices).choice)};
    },
    {prepare:context => {
      const input=decisionModelInput(DECISIONS_MODEL,context);
      return context.provider_profile ? providerDirectionInput(input,context.provider_profile.phase,{targetHandoff:nace&&context.advisor_context.schema===CARDINAL_MEMORY_WITH_HEADING,combatAware:context.combat_context!==undefined,briefMode:context.provider_profile.brief_mode}) : input;
    }, metadata, transportMeasuredByRequest:true});
  return {provider,advise:context=>adapter.decide({...context,advisor_role:'cardinal-advisor'})};
}

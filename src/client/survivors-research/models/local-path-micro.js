import { WHOLE_PATH_DIRECTIONS, wholePathDirections, wholePathHoldDurations, wholePathQuestion } from './action-whole-path.js';
import {RESEARCH_COVERAGE_SEQUENCE_DURATIONS_MS, RESEARCH_COVERAGE_SEQUENCE_PROFILE, RESEARCH_SEQUENCE_MAX_SEGMENTS, RESEARCH_SEQUENCE_PROFILE, researchSequenceTicks} from '../../../shared/survivors-research-contract.js';
import {DREX_WEAPON_MICRO_PROJECTION_SCHEMA,isDrexLocalMicroProjectionSchema} from './local-micro.js';
import { ResearchModelError } from './common.js';
import {PROVIDER_PROCESSING_CAP_MS} from '../provider-clock.js';
import {WHIP_KNOWLEDGE} from './whip-knowledge.js';
import {COMBAT_CONTEXT_INSTRUCTIONS} from './combat-context.js';
import {CONTROL_BRIEF_MODE,CONTROL_BRIEF_MODE_V2,CONTROL_BRIEF_MODE_V3,isControlBriefMode} from './control-brief.js';
import {R162_DIRECTION_PROMPT,R162_MICRO_PROMPT} from './r162-prompts.js';
import {R165_DIRECTION_PROMPT,R165_MICRO_PROMPT} from './r165-prompts.js';
import {R160_DIRECTION_PROMPT,R160_MICRO_PROMPT} from './r160-prompts.js';

export const LOCAL_PATH_MICRO_MODE = 'local-path-micro-v1';
export const DREX_PATH_MICRO_PROMPT_VERSION = 'local-path-micro-v2';
export const DREX_PROVIDER_MICRO_INPUT_PROFILE = 'provider-path-micro-local-context-v1';
export const DREX_DIRECTION_PROMPT_SUFFIX = '-combat-v1';
export const DREX_TARGET_MICRO_PROMPT_VERSION='local-path-micro-v3';
export const DREX_TARGET_PROVIDER_INPUT_PROFILE='provider-path-micro-local-context-v2';
export const DREX_TIMING_MICRO_PROMPT_VERSION='local-path-micro-v4';
export const DREX_COVERAGE_MICRO_PROMPT_VERSION='local-path-micro-v7';
export const DREX_WEAPON_MICRO_PROMPT_VERSION='local-path-micro-v9';
export const DREX_TIMING_PROVIDER_INPUT_PROFILE='provider-path-micro-local-context-v3';
export const DREX_CAPPED_TIMING_PROVIDER_INPUT_PROFILE='provider-path-micro-local-context-v4';
export const DREX_TARGET_DIRECTION_PROMPT_SUFFIX='-target-progress-v3';
export const DREX_COMBAT_DIRECTION_PROMPT_SUFFIX='-target-progress-v4';
export const DREX_BRIEF_DIRECTION_PROMPT_SUFFIX='-target-progress-v5';
export const DREX_BRIEF_MICRO_PROMPT_VERSION='local-path-micro-v10';
export const DREX_SHARED_DIRECTION_PROMPT_SUFFIX='-target-progress-v6';
export const DREX_SHARED_MICRO_PROMPT_VERSION='local-path-micro-v11';
export const DREX_TACTICS_DIRECTION_PROMPT_SUFFIX='-target-progress-v7';
export const DREX_TACTICS_MICRO_PROMPT_VERSION='local-path-micro-v12';

const choices = Object.freeze([...wholePathQuestion().choices, Object.freeze({value:'stop', description:'Stop moving.'})]);

// The guided and unguided question text comes from the frozen R111 65-choice experiment.
const UNGUIDED_INSTRUCTIONS = [
  "Choose one ordered three-step movement plan, 100 ms per step, or stop. ",
  "Direction guidance is unavailable. ",
  "Continue actual movement when appropriate, avoid imminent local contact, and collect a nearby gem only when it needs a small local detour. ",
  "Stop means stay still. ",
  "A newly applied action replaces the remaining plan. ",
  "Enemies keep approaching while you stop; stopping does not evade them. ",
].join('');

const GUIDED_INSTRUCTIONS = [
  "Choose one ordered three-step movement plan, 100 ms per step, or stop. ",
  "Treat guidance.heading as the continuing travel direction, not a requirement for net progress in every three-step plan; a short lateral or backward step may make room around approaching threats, then resume the heading. ",
  "The heading need not dictate every step. ",
  "When near_gems contains a gem reachable with a small local move, prioritize picking it up while avoiding imminent local contact, even if the move is sideways or opposite the heading, then resume guidance after the short pickup movement. ",
  "Stop means stay still. ",
  "A newly applied action replaces the remaining plan. ",
  "Guidance is a direction to make progress toward, not a command to walk through threats. ",
  "If threats are closing from that direction, first create sideways clearance, then turn back toward guidance. ",
  "Enemies keep approaching while you stop; stopping does not evade them. ",
  "For threat-avoidance detours, keep the detour only as long as needed for local clearance. ",
  "Once a short step toward guidance has clearance, start returning within this plan; this return rule does not override a short local pickup movement. ",
].join('');

const FEEDBACK_INSTRUCTIONS = [
  "Feedback previous_plan_first_ack_action and consecutive_first_ack_deviations describe only the first acknowledged segment, not the whole executed path. ",
  "If executed_since_previous_observation is present, it contains only already executed actions and hits since the previous observation; one executed tick is 1/60 second. ",
  "Displacement is the net movement over that interval.\n",
  "For each of the three steps, consider how its movement and approaching threats affect clearance along that segment; do not assume a safe first step makes later steps safe or treat later steps as filler.\n",
].join('');

const TARGET_MICRO_INSTRUCTIONS=[
  'Choose three ordered movement steps of 100 ms each, or stop. A new plan replaces unexecuted steps.',
  'Use the current local threats, crystals and direction guidance to make safe progress.',
  'When guidance.target.status is visible, match its id to the selected gem and use its current dx and dy.',
  'You can approach a visible local target over several steps or successive decisions, even when it is outside near_gems.',
  'Treat guidance.heading as the continuing travel direction. If the target has no current local coordinates, make progress along the heading without guessing its position.',
  'When near contact blocks the route, briefly sidestep or retreat, then resume the target or heading when a path opens. An individual 300 ms plan need not make net progress.',
  'An attracted gem is already being collected.',
  'Resume feasible progress when a path opens. You may collect another opportunistic local gem or retreat when appropriate.',
  'Stop means remain still while enemies can continue approaching. ',
].join(' ');

const RAW_HISTORY_INSTRUCTION = 'recent_micro_processing summarizes only earlier successful micro provider processing times in this run. Its median and range are estimates for planning, not a guarantee for this response. Null means unknown.';
const CAPPED_HISTORY_INSTRUCTION = 'recent_micro_processing summarizes only earlier successful micro requests after limiting each reported processing time to provider_processing_cap_ms. It estimates game time passing while the request is pending. The game counts at most provider_processing_cap_ms per request. Excess processing time and network or framework waits are paused. The current processing time is unknown, and null history means no estimate.';
const TIMING_INSTRUCTIONS=[
  'When the selected local crystal is visible and uncollected, use its current ID and relative position. It can be approached safely over several steps or requests, even outside near_gems. An attracted crystal is already being collected.',
  'If the target has no current position, follow the available heading without guessing coordinates. Keep the next approach flexible if threats still block it.',
  'remaining_plan describes the confirmed movements remaining after the sampled frame. Counts are game ticks, one tick is 1/60 second. An active plan can continue or expire while the new request is processing. Idle means no confirmed movement plan remains. Unknown does not mean idle.',
  RAW_HISTORY_INSTRUCTION,
  'Use that timing estimate, the confirmed plan remainder and visible threat velocities to anticipate where the player and nearby threats could be when the new choice takes effect. The new choice cannot change movement during the current wait. Evaluate clearance for each of its three steps from the estimated position.',
].join(' ')+' ';

const COVERAGE_MOTION_SEMANTICS = [
  "`dx` and `dy` are the entity's position relative to the player in world units; right is +x and down is +y.",
  "Distances, `radius`, `current_clearance`, and `step_distance` use world units.",
  "Player `speed` and enemy `velocity` use world units per second.",
  "Enemy `velocity` is a world-space vector measured from its most recent simulation tick, not velocity relative to the player or a fixed future trajectory.",
  "Ordinary pursuing enemies continually turn toward the player's current position; their future movement can change as you move.",
  "For a circular enemy, `radius` is the contact threshold from the player center, and `current_clearance` is center distance minus that radius; do not add a separate player radius.",
  "Use the recent median processing time as a working estimate and also check whether a recent slower time makes any part of the plan an obvious contact path.",
  "Future processing time is uncertain; keep making feasible progress and pursuing pickups.",
].join(' ');

const WEAPON_OBSERVATION_INSTRUCTIONS = [
  'Weapons, enemy IDs and enemy HP describe the same sampled frame. Null means unknown. Weapon damage is per non-critical hit; an evolved whip can critically hit. Enemy HP and damage do not guarantee contact or defeat.',
  'The next whip round cooldown and already queued strikes are separate. An empty list means none; a null list means unknown. Queued entries show only their index and ticks to emission.',
  'A whip strike uses the facing at its emission; odd indices reverse that facing. At emission the center is offset from the player then by (side × center_forward, (index + 1) × center_y_step) world units.',
  'An emitted strike stays at its world position. Its dx and dy are relative to the sampled player. Bounds are current half extents in world units, and max_half_width and max_half_height are the full-grown half extents. The rectangle grows during the first six ticks and is active at ages 1–11 ticks. Null bounds mean no current rectangle is known.',
  'Pending strikes, cooldown and remaining lifetime advance while the request is processing; a currently active strike can expire before the new movement takes effect.',
  'already_hit_enemy_ids lists local enemies already hit by that strike. The same strike cannot hit them again.',
].join(' ');

const DIRECTION_PRIORITY = '请严格优先考虑方向层给的方向建议';

export const localPathMicroChoices = choices;

export function localPathMicroInput(input,{strictDirectionPriority=true,timingAware=false,cappedTiming=false}={}) {
  const [state, image, legend] = input.input[0].content;
  const projection = JSON.parse(state.text);
  const {previous_action, consecutive_deviations, ...feedback} = projection.feedback;
  projection.feedback = {...feedback, previous_plan_first_ack_action: previous_action,
    consecutive_first_ack_deviations: consecutive_deviations};
  const baseline=projection.guidance?GUIDED_INSTRUCTIONS:UNGUIDED_INSTRUCTIONS;
  const instruction=timingAware?baseline+(cappedTiming?TIMING_INSTRUCTIONS.replace(RAW_HISTORY_INSTRUCTION,CAPPED_HISTORY_INSTRUCTION):TIMING_INSTRUCTIONS)
    :isDrexLocalMicroProjectionSchema(projection.schema)?TARGET_MICRO_INSTRUCTIONS:baseline;
  const instructions = instruction + FEEDBACK_INSTRUCTIONS + (strictDirectionPriority ? DIRECTION_PRIORITY : '');
  return {...input,
    input:[{role:'user', content:[{...state, text:JSON.stringify(projection)}, image, legend]}],
    questions:[{name:'path', type:'choice', instructions, choices}]};
}

const coverageChoices = choices.map(choice => Object.freeze({...choice,
  description: choice.description.replace('200–300 ms', '200–600 ms'),
}));
const threatColumns = ['type','dx','dy','shape','radius','half_width','half_height','velocity','current_clearance','touching_now'];
const pathsByProfile = new Map([[RESEARCH_SEQUENCE_PROFILE, choices], [RESEARCH_COVERAGE_SEQUENCE_PROFILE, coverageChoices]]
  .map(([profile, entries]) => [profile, new Map(entries.map(choice => [choice.value, choice]))]));

export const hasMicroTimingContext=profile=>Object.hasOwn(profile??{},'remaining_plan')||
  Object.hasOwn(profile??{},'recent_micro_processing')||Object.hasOwn(profile??{},'provider_processing_cap_ms');

const exactKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));

function validRemainingPlan(plan,tick,actionProfile){
  const coverage=actionProfile===RESEARCH_COVERAGE_SEQUENCE_PROFILE;
  return exactKeys(plan,['status','as_of_tick','segments'])&&plan.as_of_tick===tick&&
    ['active','idle','unknown'].includes(plan.status)&&Array.isArray(plan.segments)&&
    (plan.status==='active' ? plan.segments.length>0&&plan.segments.length<=(coverage ? RESEARCH_COVERAGE_SEQUENCE_DURATIONS_MS.length : RESEARCH_SEQUENCE_MAX_SEGMENTS)&&
      plan.segments.every((s,index)=>exactKeys(s,['direction','remaining_ticks'])&&['up','down','left','right'].includes(s.direction)&&
        Number.isSafeInteger(s.remaining_ticks)&&s.remaining_ticks>0&&(!coverage ||
          s.remaining_ticks<=RESEARCH_COVERAGE_SEQUENCE_DURATIONS_MS.at(index-plan.segments.length)*60/1000))&&
      plan.segments.reduce((sum,s)=>sum+s.remaining_ticks,0)<=researchSequenceTicks(actionProfile)
      :plan.segments.length===0);
}

function validMicroProcessing(estimate){
  if(estimate===null)return true;
  if(!exactKeys(estimate,['median_ms','count','min_ms','max_ms']))return false;
  const {median_ms,count,min_ms,max_ms}=estimate;
  return Number.isSafeInteger(count)&&count>=1&&count<=5&&[min_ms,median_ms,max_ms].every(Number.isFinite)&&
    min_ms>=0&&min_ms<=median_ms&&median_ms<=max_ms&&(count!==1||min_ms===max_ms);
}

export const validMicroTimingContext=(context,tick,actionProfile=RESEARCH_SEQUENCE_PROFILE)=>
  validRemainingPlan(context?.remaining_plan,tick,actionProfile)&&
  validMicroProcessing(context?.recent_micro_processing)&&
  (!Object.hasOwn(context,'provider_processing_cap_ms')||
    context.provider_processing_cap_ms===PROVIDER_PROCESSING_CAP_MS&&
      (context.recent_micro_processing===null||context.recent_micro_processing.max_ms<=PROVIDER_PROCESSING_CAP_MS));

export function providerPathMicroInput(input,profile,actionProfile=RESEARCH_SEQUENCE_PROFILE) {
  const coverage=actionProfile===RESEARCH_COVERAGE_SEQUENCE_PROFILE;
  const pathByValue=pathsByProfile.get(actionProfile);
  const {phase,interval=null,strictDirectionPriority=true,remaining_plan,recent_micro_processing}=profile;
  if (!Number.isInteger(phase) || phase<0 || phase>3) throw new TypeError('Invalid micro choice phase');
  const timingAware=hasMicroTimingContext(profile);
  const cappedTiming=Object.hasOwn(profile,'provider_processing_cap_ms');
  const native=localPathMicroInput(input,{strictDirectionPriority,timingAware,cappedTiming});
  const [state]=native.input[0].content;
  const projection=JSON.parse(state.text);
  const briefAware=isControlBriefMode(profile.brief_mode);
  if(profile.brief_mode!==undefined&&!briefAware || briefAware&&projection.schema!==DREX_WEAPON_MICRO_PROJECTION_SCHEMA)throw new TypeError('Invalid control brief mode');
  if(coverage && !timingAware)throw new TypeError('Coverage mode requires micro timing context');
  if(timingAware){
    if(!isDrexLocalMicroProjectionSchema(projection.schema)||!validMicroTimingContext(profile,projection.tick,actionProfile))throw new TypeError('Invalid micro timing context');
    projection.remaining_plan=remaining_plan;
    projection.recent_micro_processing=recent_micro_processing;
    if(cappedTiming)projection.provider_processing_cap_ms=PROVIDER_PROCESSING_CAP_MS;
  }
  if (interval !== null) {
    const {from_tick_exclusive:from,through_tick_inclusive:through,segments,hits_taken:hits} = interval;
    if (!Number.isSafeInteger(from) || from<0 || through!==projection.tick || from>=through ||
        !Number.isSafeInteger(hits) || hits<0 || hits>through-from || !Array.isArray(segments) ||
        !segments.every(row=>['up','down','left','right','stop'].includes(row?.action) &&
          Number.isSafeInteger(row.executed_ticks) && row.executed_ticks>0) ||
        segments.reduce((duration,row)=>duration+row.executed_ticks,0)>through-from) {
      throw new TypeError('Invalid executed movement interval');
    }
    projection.feedback.executed_since_previous_observation = interval;
  }
  const columns=projection.schema===DREX_WEAPON_MICRO_PROJECTION_SCHEMA ? [...threatColumns,'id','hp'] : threatColumns;
  projection.threats = {columns,rows:projection.threats.map(item=>columns.map(key=>item[key]))};
  state.text = JSON.stringify(projection);
  const directions = [...WHOLE_PATH_DIRECTIONS.slice(phase),...WHOLE_PATH_DIRECTIONS.slice(0,phase)];
  if(coverage) native.questions[0].instructions = native.questions[0].instructions.replace(
    '100 ms per step', '100 ms, 100 ms, then up to 400 ms') +
    ' The final direction can continue for the full 400 ms. Check clearance throughout it. A newly applied choice can interrupt it.' +
    ' ' + COVERAGE_MOTION_SEMANTICS;
  if (projection.schema===DREX_WEAPON_MICRO_PROJECTION_SCHEMA) {
    native.questions[0].instructions=native.questions[0].instructions.replace(
      'Once a short step toward guidance has clearance, start returning within this plan; this return rule does not override a short local pickup movement.',
      'One clear short step does not prove the route is open. Continue a useful detour or engagement as needed, and turn back toward guidance when the actual approach becomes useful; this does not override a short local pickup movement.');
    native.questions[0].instructions += ' '+WEAPON_OBSERVATION_INSTRUCTIONS+' While following the current guidance, avoid contact. When fighting is needed to open a route, use the attack rectangle, cooldown and enemy contact clearance to maintain or restore positions that can enable hits. Do not chase enemies when a safe collection route is available; moving farther away can be useful to open a route. Judge progress from actual results, not a fixed distance.';
  }
  if(briefAware)native.questions[0].instructions=profile.brief_mode===CONTROL_BRIEF_MODE_V3?R165_MICRO_PROMPT:profile.brief_mode===CONTROL_BRIEF_MODE_V2?R162_MICRO_PROMPT:R160_MICRO_PROMPT;
  native.questions[0].choices = [...directions.flatMap(a=>directions.flatMap(b=>directions
    .map(c=>pathByValue.get([a,b,c].join(':'))))),pathByValue.get('stop')];
  return native;
}

export function drexPathMicroInput(input,providerProfile,actionProfile=RESEARCH_SEQUENCE_PROFILE) {
  return providerProfile
    ? providerPathMicroInput(input,{...providerProfile,strictDirectionPriority:false},actionProfile)
    : localPathMicroInput(input,{strictDirectionPriority:false});
}

const DIRECTION_COMBAT_REPLACEMENTS = [
  ['Plan a medium-term direction to collect experience crystals.',
    'Plan a medium-term direction to create sustained weapon hits and collect experience crystals.'],
  ['When no crystal is available, use the automatic weapon to defeat enemies and create experience opportunities.',
    'Consider how pursuing enemies can form on the same side and, when advantageous, align with a useful side of the equipped weapon. Once an opportunity to hit is established, avoid moving so far away that attacks no longer connect; create drops and collect them. Do not force grouping or follow a fixed route.'],
];

export function providerDirectionInput(input,phase,{targetHandoff=false,combatAware=false,briefAware=false,briefMode=undefined}={}) {
  if (!Number.isInteger(phase) || phase<0 || phase>3) throw new TypeError('Invalid direction choice phase');
  const [question] = input.questions;
  if (question?.name!=='guidance' || question.choices.length%4!==0) throw new TypeError('Invalid direction choice groups');
  const choices = [];
  for (let i=0;i<question.choices.length;i+=4) {
    const group = question.choices.slice(i,i+4);
    choices.push(...group.slice(phase),...group.slice(0,phase));
  }
  const facts = "A new direction request becomes eligible no earlier than 60 simulated ticks (1 simulated second) after the previous direction observation, and may happen later if a request is pending or an eligible observation is unavailable. An accepted hint expires no later than 120 simulated ticks (2 simulated seconds) after its source observation and may be replaced or become invalid earlier. The local controller receives the heading but not the selected target's coordinates; it observes local threats and gems reachable by a short local step.";
  if(targetHandoff){
    if(briefAware||isControlBriefMode(briefMode)){
      if(!combatAware)throw new TypeError('Control brief direction needs combat facts');
      return {...input,questions:[{...question,choices,instructions:briefMode===CONTROL_BRIEF_MODE_V3?R165_DIRECTION_PROMPT:briefMode===CONTROL_BRIEF_MODE_V2?R162_DIRECTION_PROMPT:R160_DIRECTION_PROMPT}]};
    }
    const instructions=[
      'Select a crystal target or no target and one cardinal route leg using this public observation.',
      'When a strategic intent is supplied, evaluate its observable transition condition each round against current threats, same-target range, pickups and hits. Without one, decide from the current observation and recent results.',
      'Use combat to create recoverable experience when useful. Open a safe collection route or collect existing crystals when the current observations warrant it.',
      'In history and ongoing, heading is the guidance that was accepted at the time. Compare it with actual net displacement, target range and pickup or damage changes.',
      'An unknown heading or range carries no evidence of progress or of the reason for a detour.',
      'You may temporarily move farther to avoid threats. If the route repeatedly fails to open an approach or provide a useful result, reassess the route leg or change target.',
      'The immediate controller handles near threats. It gets the selected target position only if currently visible, uncollected and within one second of player movement, and can approach it over several steps.',
      'Outside that circle the controller has heading and target status, without a target position. Unknown targets are not confirmed collected.',
      'Right is +x and down is +y.',
      WHIP_KNOWLEDGE,
      'Direction is eligible at intervals of at least 60 ticks; guidance expires by 120 ticks or earlier if invalidated or replaced.',
    ].join(' ');
    const combatInstructions=combatAware ? ' '+COMBAT_CONTEXT_INSTRUCTIONS+' Keep a useful target and assess whether the chosen leg improves approach, attack or collection using actual progress. When combat is needed to open a route, use the attack rectangle, cooldown and enemy contact boundary to maintain or recover positions that can enable hits, without requiring permanent proximity. A longer retreat may draw enemies away and open a collection route; reachable crystals can take priority. A momentary gap is not proof a route is open. Reassess an unproductive route, without assuming a fixed safe distance or exact future positions.' : '';
    return {...input,questions:[{...question,choices,instructions:instructions+combatInstructions}]};
  }
  let instructions = question.instructions;
  for (const [original, combat] of DIRECTION_COMBAT_REPLACEMENTS) {
    const parts = instructions.split(original);
    if (parts.length !== 2) throw new TypeError('Invalid direction prompt anchor');
    instructions = parts.join(combat);
  }
  return {...input,questions:[{...question,choices,instructions:instructions+' '+facts}]};
}

export function localPathMicroPlan(choice,actionProfile) {
  if (choice === 'stop') return ['stop'];
  const directions = wholePathDirections(choice);
  if (!directions) throw new ResearchModelError('malformed', 'The model returned an unknown movement path');
  const durations = actionProfile===RESEARCH_COVERAGE_SEQUENCE_PROFILE
    ? RESEARCH_COVERAGE_SEQUENCE_DURATIONS_MS : wholePathHoldDurations();
  return directions.map((direction, index) => 'move:' + direction + ':hold:' + durations[index]);
}

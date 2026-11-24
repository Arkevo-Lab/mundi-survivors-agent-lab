import {validActionContext} from './action-observation.js';
import {actionGenerationParameters, OPENAI_GENERATION_PROFILE, structuredImageLegend} from './action-prompt.js';
import {validateVisualImage, VISUAL_IMAGE_REFERENCE} from './visual-input.js';
import {STRATEGY_MODEL,STRATEGY_GENERATION_PARAMETERS} from './strategy-config.js';
import {WHIP_KNOWLEDGE} from './whip-knowledge.js';
import {validCombatContext,COMBAT_CONTEXT_INSTRUCTIONS} from './combat-context.js';
import {R160_STRATEGY_PROMPT} from './r160-prompts.js';
import {R162_STRATEGY_PROMPT} from './r162-prompts.js';
import {R165_STRATEGY_PROMPT} from './r165-prompts.js';

export const STRATEGY_REFRESH_TICKS = 600;
export const STRATEGY_PROMPT = [
  'You are the strategic planner in a real-time survival game. The tactical advisor and controller select and execute all actions.',
  'Use only the current public observation, same-tick image and supplied past movement and results. Never infer future outcomes or use a fixed route.',
  'Balance survival and experience collection. Horizontal weapon attacks can create collection opportunities. When useful, pull enemies away, defeat them, then return to collect; fighting can also be useful while crystals are visible.',
  'Give a short general approach, current phase, observable condition for changing phase, and observable success and failure signals. The previous strategy is an intention, not evidence of an action; compare it with the observed trajectory and results.',
  'If a target gets farther over multiple observed windows without progress, reassess obstacles and an approach rather than repeating a direction indefinitely.',
  'Do not output specific targets, coordinates, fixed direction sequences, durations, or direct actions.',
  'Return only a JSON object with exactly schema, approach, phase, transition, success_signal, failure_signal. The schema must be survivors-strategy-v1; other fields are short nonempty strings in Simplified Chinese.'
].join(' ');
export const STRATEGY_TRANSITION_INPUT_SCHEMA='survivors-strategy-input-v2';
export const STRATEGY_TRANSITION_PROMPT_VERSION='strategy-v3';
export const STRATEGY_COMBAT_INPUT_SCHEMA='survivors-strategy-input-v3';
export const STRATEGY_COMBAT_PROMPT_VERSION='strategy-v4';
export const STRATEGY_BRIEF_INPUT_SCHEMA='survivors-strategy-input-v4';
export const STRATEGY_BRIEF_PROMPT_VERSION='strategy-v5';
export const STRATEGY_SHARED_INPUT_SCHEMA='survivors-strategy-input-v5';
export const STRATEGY_SHARED_PROMPT_VERSION='strategy-v6';
export const STRATEGY_TACTICS_INPUT_SCHEMA='survivors-strategy-input-v6';
export const STRATEGY_TACTICS_PROMPT_VERSION='strategy-v7';
const STRATEGY_TRANSITION_PROMPT=[
  'Give a flexible short-term intention for a survival game. Direction and micro models choose all targets and actions.',
  'Treat defeating enemies as a way to make experience that can be recovered. Balance survival, making a safe approach, and collecting available crystals.',
  WHIP_KNOWLEDGE,
  'Use current public observations, the image and past results. A previous strategy is an intention, not evidence that it happened.',
  'Describe the current phase. State transition explicitly as an observable condition and what to do when it occurs.',
  'Direction rechecks this condition each round using approach progress, pickups, hits and enemy changes. Do not prescribe targets, coordinates, fixed routes or durations.',
  'Return only JSON with exactly schema, approach, phase, transition, success_signal, failure_signal. The schema is survivors-strategy-v1 and the remaining fields are short nonempty Simplified Chinese strings.',
].join(' ');
const STRATEGY_COMBAT_PROMPT=STRATEGY_TRANSITION_PROMPT.replace(
  'Direction rechecks this condition each round using approach progress, pickups, hits and enemy changes. Do not prescribe targets, coordinates, fixed routes or durations.',
  'Direction rechecks this condition each round using approach progress, pickups, hits and enemy changes.') + ' ' + [
  COMBAT_CONTEXT_INSTRUCTIONS,
  'Identify the current constraint and explain a conditional approach to reposition, defeat threats or recover experience, with observable phase changes and adjustments when progress fails. You may reason about relative positions and staged tactics, but do not prescribe fixed coordinates, timed routes or a fixed action sequence.',
  'Judge whether movement improves attack opportunities, approach or collection. Opening space by moving far can be useful; do not require staying near enemies when reachable experience can be collected safely. Do not assume a fixed safe distance or guaranteed hit.',
  'When combat is needed to open a route, use the attack rectangle, cooldown and enemy contact boundary to maintain or recover positions that can enable hits without requiring permanent proximity.',
].join(' ');

const fields=['schema','approach','phase','transition','success_signal','failure_signal'];
export function parseStrategy(text) {
  let value;
  try {value=JSON.parse(text);} catch {throw new TypeError('Invalid strategy JSON');}
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length ||
      fields.some(k => !Object.hasOwn(value,k)) || value.schema !== 'survivors-strategy-v1' ||
      fields.slice(1).some(k => typeof value[k] !== 'string' || !value[k].trim() || !/[\u3400-\u9fff]/u.test(value[k]) || [...value[k]].length > 240)) {
    throw new TypeError('Invalid strategy fields');
  }
  return Object.freeze({...value});
}

// The server reconstructs this payload from validated public facts; it does not accept arbitrary prompt text.
export function strategyModelInput(model, {schema,observation,image,history,prior_strategy,combat_context}) {
  const h=history;
  const keys=['schema','run_id','from_tick','to_tick','coverage_ticks','window_ticks','displacement','hp_delta','hits_delta','pickups_delta','action_counts','trajectory'];
  const validInt=n=>Number.isSafeInteger(n) && n>=0;
  if (!['gpt-5.4-mini',STRATEGY_MODEL].includes(model) || !validActionContext({observation,candidates:[{id:'stop',description:'Stop.'}]}) ||
      !h || Object.keys(h).length!==keys.length || keys.some(k=>!Object.hasOwn(h,k)) ||
      h.schema!=='survivors-strategy-history-v1' || h.run_id!==observation.run_id || h.to_tick!==observation.tick ||
      !validInt(h.from_tick) || !validInt(h.to_tick) || h.from_tick>h.to_tick ||
      h.window_ticks!==STRATEGY_REFRESH_TICKS || h.coverage_ticks!==h.to_tick-h.from_tick ||
      h.coverage_ticks>h.window_ticks || !h.displacement || Object.keys(h.displacement).length!==2 ||
      !Number.isFinite(h.displacement.dx) || !Number.isFinite(h.displacement.dy) ||
      !Number.isFinite(h.hp_delta) || !validInt(h.hits_delta) || !validInt(h.pickups_delta) ||
      !h.action_counts || Array.isArray(h.action_counts) || typeof h.action_counts!=='object' ||
      Object.entries(h.action_counts).some(([k,v])=>!/^([a-zA-Z0-9:_.-]{1,180})$/.test(k) || !validInt(v)) ||
      !Array.isArray(h.trajectory) || h.trajectory.length<1 || h.trajectory.length>21 ||
      h.trajectory.some((v,i)=>!v || Object.keys(v).length!==3 || !validInt(v.tick) || v.tick<h.from_tick || v.tick>h.to_tick ||
        !Number.isFinite(v.dx) || !Number.isFinite(v.dy) || i>0 && v.tick<=h.trajectory[i-1].tick) ||
      h.trajectory[0].tick!==h.from_tick || h.trajectory.at(-1).tick!==h.to_tick ||
      h.trajectory.at(-1).dx!==0 || h.trajectory.at(-1).dy!==0 ||
      (prior_strategy!==null && !validStrategyEnvelope(prior_strategy,observation.tick)) ||
      ([STRATEGY_COMBAT_INPUT_SCHEMA,STRATEGY_BRIEF_INPUT_SCHEMA,STRATEGY_SHARED_INPUT_SCHEMA,STRATEGY_TACTICS_INPUT_SCHEMA].includes(schema) ? !validCombatContext(combat_context,observation.tick) : combat_context!==undefined)) {
    throw new TypeError('Invalid strategy public input');
  }
  if (image?.profile!=='structured-v1') throw new TypeError('Strategy requires a same-tick structured image');
  validateVisualImage(image,observation.tick);
  const content=[{type:'text',text:JSON.stringify({observation,history,prior_strategy,...(combat_context!==undefined&&{combat_context})})},
    {type:'image_url',image_url:{url:VISUAL_IMAGE_REFERENCE}},
    {type:'text',text:structuredImageLegend(image.profile)}];
  const parameters=model===STRATEGY_MODEL ? STRATEGY_GENERATION_PARAMETERS : actionGenerationParameters(model,OPENAI_GENERATION_PROFILE);
  return {model,...parameters,messages:[
    {role:'system',content:schema===STRATEGY_TACTICS_INPUT_SCHEMA?R165_STRATEGY_PROMPT:schema===STRATEGY_SHARED_INPUT_SCHEMA?R162_STRATEGY_PROMPT:schema===STRATEGY_BRIEF_INPUT_SCHEMA?R160_STRATEGY_PROMPT:schema===STRATEGY_COMBAT_INPUT_SCHEMA?STRATEGY_COMBAT_PROMPT:schema===STRATEGY_TRANSITION_INPUT_SCHEMA?STRATEGY_TRANSITION_PROMPT:STRATEGY_PROMPT},{role:'user',content}]};
}

export function validStrategyEnvelope(value,tick) {
  try {
    if (!value || Object.keys(value).length!==5 || typeof value.strategy_id!=='string' || !value.strategy_id ||
        !Number.isSafeInteger(value.source_tick) || !Number.isSafeInteger(value.accepted_tick) ||
        value.source_tick<0 || value.source_tick>value.accepted_tick || value.accepted_tick>tick ||
        value.age_ticks!==tick-value.source_tick) return false;
    parseStrategy(JSON.stringify(value.strategy)); return true;
  } catch {return false;}
}

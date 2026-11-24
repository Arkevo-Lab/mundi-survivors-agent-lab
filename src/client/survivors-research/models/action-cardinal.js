import {directionAction} from './action-direction.js';
import {ResearchModelError} from './common.js';
import {validControlBrief} from './control-brief.js';

export const CARDINAL_ADVISOR_MODE = 'advisory-cardinal-v2';
export const CARDINAL_MEMORY_WITH_HEADING='survivors-cardinal-memory-v3';
export const CARDINAL_HEADINGS = Object.freeze(['up', 'down', 'left', 'right']);
export const CARDINAL_ADVISOR_PROMPT = [
  'Plan a medium-term direction to collect experience crystals.',
  'Choose a known crystal target and a cardinal direction that progresses toward collecting it.',
  'Keep a useful crystal target across planning rounds, even when its direct bearing changes.',
  'Choose a cardinal route leg independently of the direct bearing; use enemy positions, sizes and motion to flank pursuers and return when an approach opens.',
  'You may temporarily increase distance to find an approach, without demanding that every step gets closer.',
  'Judge progress using actual displacement, same-target range changes, aggregate pickups and enemy formation.',
  'If continued travel increases target distance without creating an approach, revise the route leg or target.',
  'The immediate controller handles imminent contact.',
  'When no crystal is available, use the automatic weapon to defeat enemies and create experience opportunities.',
  'The whip attacks horizontally in the facing direction on its cooldown; turning alone does not cause a hit.',
  'Positions are relative to the current player. Positive x is right and positive y is down.',
  'Unknown targets use last-known positions; disappearance does not prove collection.',
].join(' ');
export const CARDINAL_MICRO_PROMPT = [
  'Choose the next action for up to 100 ms using the current observation and image.',
  'Follow the available medium-term direction to advance toward experience crystals.',
  'Predict pursuit and crossings from current enemy motion. When contact is imminent, briefly avoid it, then resume progress when space opens.',
  'A quieter direction alone is no reason to leave a valid route.',
  'Without guidance, assess nearby crystals and enemies to make progress.',
  'Stop only when it serves the route, then continue when possible.',
].join(' ');

const integer = value => Number.isSafeInteger(value) && value >= 0;
const number = Number.isFinite;
const nullable = check => value => value === null || check(value);
const exact = fields => value => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === Object.keys(fields).length &&
  Object.entries(fields).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]));
const status = value => ['visible', 'attracted', 'unknown', 'reobserved-absent'].includes(value);
const target = exact({id: integer, dx: number, dy: number, value: nullable(number), status,
  last_seen_tick: integer, age_ticks: integer});
const targetWindow = exact({id: integer, status_start: nullable(status), status_end: nullable(status),
  range_start: nullable(number), range_end: nullable(number), range_delta: nullable(number)});
const windowFields={from_tick: integer, to_tick: integer, displacement: exact({dx:number,dy:number}),
  hp_delta: nullable(number), hits_delta: nullable(integer), pickups_delta: nullable(integer),
  applied_action_count: integer, target: nullable(targetWindow),
  enemy_changes: value => Array.isArray(value) && value.length <= 16 &&
    value.every(exact({id:integer,dx:number,dy:number}))};
function snapshotSchema(schema,window){
  return exact({schema:value=>value===schema,
    coordinate_frame:value=>value==='current-player-relative',run_id:value=>typeof value==='string'&&value.length>0,
    tick:integer,player:exact({hp:nullable(number),hits_taken:nullable(integer),gems_collected:nullable(integer)}),
    active_target_id:nullable(integer),targets:value=>Array.isArray(value)&&value.length<=4&&value.every(target),
    history:value=>Array.isArray(value)&&value.length<=4&&value.every(window),ongoing:nullable(window)});
}
const legacySnapshot=snapshotSchema('survivors-cardinal-memory-v2',exact(windowFields));
const headingSnapshot=snapshotSchema(CARDINAL_MEMORY_WITH_HEADING,
  exact({...windowFields,heading:nullable(value=>CARDINAL_HEADINGS.includes(value))}));
const hintTarget = exact({id:integer,status,dx:number,dy:number,last_seen_tick:integer});
const hintFields={guidance_id: value => typeof value === 'string' && /^[\w-]{1,96}$/.test(value),
  source_tick:integer,accepted_tick:integer,expires_tick:integer,target:nullable(hintTarget),
  heading:value => CARDINAL_HEADINGS.includes(value)};
const hint = value => exact(hintFields)(value) || exact({...hintFields,control_brief:brief=>brief===null||typeof brief==='object'})(value);

export function validCardinalContext(role, context, observation) {
  if (role === 'cardinal-advisor') {
    if (!(legacySnapshot(context)||headingSnapshot(context)) || context.run_id !== observation.run_id || context.tick !== observation.tick ||
        new Set(context.targets.map(item => item.id)).size !== context.targets.length) return false;
    const windows = [...context.history, ...(context.ongoing ? [context.ongoing] : [])];
    return context.targets.every(item => item.age_ticks === context.tick - item.last_seen_tick &&
      (item.status !== 'visible' || item.age_ticks === 0)) &&
      (context.ongoing === null || context.ongoing.to_tick === context.tick) &&
      windows.every((entry, index) => entry.from_tick <= entry.to_tick && entry.to_tick <= context.tick &&
        (index === 0 || windows[index - 1].to_tick <= entry.from_tick) &&
        (!entry.target || [['start','range_start'],['end','range_end']].every(([endpoint,range]) => {
          const state = entry.target['status_' + endpoint], value = entry.target[range];
          return state === 'visible' ? value !== null :
            state === 'attracted' ? true : value === null;
        }) && (entry.target.range_start === null || entry.target.range_start >= 0) &&
          (entry.target.range_end === null || entry.target.range_end >= 0) &&
          (entry.target.range_delta === null ? entry.target.range_start === null || entry.target.range_end === null :
            entry.target.range_start !== null && entry.target.range_end !== null &&
            Math.abs(entry.target.range_delta - (entry.target.range_end - entry.target.range_start)) < 1e-8)));
  }
  if (role !== 'cardinal-micro') return false;
  if (context === null) return true;
  return hint(context) && (!Object.hasOwn(context,'control_brief')||context.control_brief===null||
    validControlBrief(context.control_brief,observation.tick)&&context.control_brief.accepted_tick<=context.source_tick) && context.source_tick <= context.accepted_tick && context.accepted_tick <= observation.tick &&
    context.expires_tick === context.source_tick + 120 && observation.tick < context.expires_tick &&
    (context.target === null || context.target.last_seen_tick <= observation.tick &&
      ['visible','unknown'].includes(context.target.status) &&
      (context.target.status === 'visible' ? context.target.last_seen_tick === observation.tick :
        context.target.last_seen_tick < observation.tick));
}

export function cardinalAdvisorQuestion(context) {
  const targets = context.targets.filter(item => ['visible','unknown'].includes(item.status));
  return {type:'choice', name:'guidance', instructions:CARDINAL_ADVISOR_PROMPT,
    choices:[...targets.map(item => item.id), null].flatMap(id => CARDINAL_HEADINGS.map(heading => ({
      value:(id === null ? 'none' : 'loot:' + id) + ':' + heading,
      description:(id === null ? 'Find or create experience opportunities' : 'Target experience crystal ' + id) +
        ' and navigate ' + heading + '.',
    })))};
}

export function cardinalMicroQuestion() {
  return {type:'choice', name:'action', instructions:CARDINAL_MICRO_PROMPT,
    choices:[...CARDINAL_HEADINGS, 'stop'].map(value => ({value,
      description:value === 'stop' ? 'Stop now.' : 'Move ' + value + ' for up to 100 ms.'}))};
}

export function decodeCardinal(raw, question, validateDecision, role) {
  let data;
  try { data = JSON.parse(raw); } catch { /* malformed response */ }
  if (!Array.isArray(data?.answers) || data.answers.length !== 1 || data.answers[0]?.name !== question.name) {
    throw new ResearchModelError('malformed', 'Decisions must return the expected single answer');
  }
  const value = validateDecision(data.answers[0], question.choices.map(choice => choice.value));
  if (role === 'cardinal-micro') return [directionAction(value)];
  return {guidance:cardinalGuidance(value)};
}

export function cardinalGuidance(value) {
  const parts=value.split(':');
  return {target_id:parts.length===3?Number(parts[1]):null,heading:parts.at(-1)};
}

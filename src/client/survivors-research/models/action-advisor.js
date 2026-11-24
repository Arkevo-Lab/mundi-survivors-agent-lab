import {directionAction} from './action-direction.js';
import {ResearchModelError} from './common.js';

export const ADVISOR_MODE = 'advisory-direction-v1';
export const ADVISOR_QUESTION = 'guidance';
export const ADVISOR_REFRESH_TICKS = 60;
export const ADVISOR_HORIZON_TICKS = 300;
export const ADVISOR_TTL_TICKS = 120;
export const ADVISOR_TIMEOUT_MS = 3000;
export const ADVISOR_HEADINGS = Object.freeze([
  'up', 'up-right', 'right', 'down-right', 'down', 'down-left', 'left', 'up-left', 'none',
]);

const finite = Number.isFinite;
const tick = value => Number.isSafeInteger(value) && value >= 0;
const id = tick;
const token = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(value);
const heading = value => ADVISOR_HEADINGS.includes(value);
const status = value => ['visible', 'attracted', 'unknown', 'reobserved-absent'].includes(value);
const nullable = check => value => value === null || check(value);
const list = (check, max) => value => Array.isArray(value) && value.length <= max && value.every(check);
const row = fields => {
  const entries = Object.entries(fields);
  return value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === entries.length &&
    entries.every(([key, check]) => Object.hasOwn(value, key) && check(value[key]));
};
const target = row({id, x: finite, y: finite, value: nullable(finite), status, last_seen_tick: tick, age_ticks: tick});
const enemyPrevious = row({x: finite, y: finite, tick});
const enemy = row({id, x: finite, y: finite, radius: nullable(finite), last_seen_tick: tick, age_ticks: tick,
  previous: nullable(enemyPrevious)});
const action = row({decision_id: token, applied_tick: tick, action_id: value => value === 'stop' ||
  typeof value === 'string' && directionAction(value.split(':')[1]) === value});
const targetId = nullable(id);
const window = row({
  guidance_id: token, source_tick: tick, accepted_tick: tick, target_id: targetId, heading,
  from_tick: tick, to_tick: tick, displacement: row({dx: finite, dy: finite}),
  hp_delta: nullable(finite), hits_delta: nullable(tick), pickups_delta: nullable(tick),
  actions: row({count: tick, last: list(action, 8)}),
  target: row({from: nullable(target), to: nullable(target)}),
  enemy_changes: list(row({id, dx: finite, dy: finite}), 16),
});
const snapshot = row({
  run_id: token, tick,
  player: row({x: finite, y: finite, hp: nullable(finite), hits_taken: nullable(tick), gems_collected: nullable(tick)}),
  targets: list(target, 4), enemies: list(enemy, 128), history: list(window, 4), ongoing: nullable(window),
});
const hint = row({
  guidance_id: token, source_tick: tick, accepted_tick: tick, expires_tick: tick,
  target: nullable(row({id, status, dx: finite, dy: finite, last_seen_tick: tick})), heading,
});

function validWindow(entry, latestTick) {
  return entry.source_tick <= entry.accepted_tick && entry.accepted_tick === entry.from_tick &&
    entry.from_tick <= entry.to_tick && entry.to_tick <= latestTick &&
    entry.actions.last.length <= entry.actions.count && entry.actions.last.every((item, index, actions) =>
      item.applied_tick > entry.from_tick && item.applied_tick <= entry.to_tick &&
      (index === 0 || actions[index - 1].applied_tick < item.applied_tick)) &&
    [['from', entry.from_tick], ['to', entry.to_tick]].every(([end, sample]) => {
      const point = entry.target[end];
      return point === null || point.id === entry.target_id && point.age_ticks === sample - point.last_seen_tick;
    });
}

export function validAdvisorContext(role, context, observation) {
  if (role === 'advisor') {
    if (!snapshot(context) || context.run_id !== observation.run_id || context.tick !== observation.tick ||
        new Set(context.targets.map(item => item.id)).size !== context.targets.length ||
        new Set(context.enemies.map(item => item.id)).size !== context.enemies.length) return false;
    const {tick: current, targets, enemies, history, ongoing} = context;
    return targets.every(item => item.age_ticks === current - item.last_seen_tick &&
      (item.status === 'visible' ? item.age_ticks === 0 : item.status === 'attracted' || item.age_ticks > 0)) &&
      enemies.every(item => item.age_ticks === current - item.last_seen_tick && item.age_ticks <= ADVISOR_TTL_TICKS &&
        (item.previous === null || item.previous.tick < item.last_seen_tick)) &&
      history.every((entry, index) => validWindow(entry, current) &&
        (index === 0 || history[index - 1].to_tick <= entry.from_tick)) &&
      (ongoing === null || validWindow(ongoing, current) && ongoing.to_tick === current &&
        (!history.length || history.at(-1).to_tick <= ongoing.from_tick));
  }
  if (role !== 'micro' || !hint(context)) return false;
  return context.source_tick <= context.accepted_tick && context.accepted_tick <= observation.tick &&
    context.expires_tick === context.source_tick + ADVISOR_TTL_TICKS && observation.tick < context.expires_tick &&
    (context.target === null || context.target.last_seen_tick <= observation.tick &&
      !['attracted', 'reobserved-absent'].includes(context.target.status) &&
      (context.target.status === 'visible' ? context.target.last_seen_tick === observation.tick :
        context.target.last_seen_tick < observation.tick));
}

export function advisorQuestion(context) {
  const eligible = context.targets.filter(item => item.status === 'visible' || item.status === 'unknown');
  const choices = [...eligible.map(item => item.id), null].flatMap(targetId =>
    ADVISOR_HEADINGS.map(heading => ({
      value: (targetId === null ? 'none' : 'loot:' + targetId) + ':' + heading,
      description: (targetId === null ? 'No particular crystal' : 'Keep experience crystal as target ' + targetId) +
        (heading === 'none' ? '; no compass preference.' : '; prefer ' + heading + ' if safe.'),
    })));
  return {type: 'choice', name: ADVISOR_QUESTION, choices, instructions: [
    'Give medium-term directional advice for up to ' + ADVISOR_HORIZON_TICKS + ' simulated ticks.',
    'The live controller alone selects each short action and must avoid immediate contact.',
    'Select a known crystal identity or no target, with a compass preference or none.',
    'Right is positive x and down is positive y. Map positions are relative to the first sampled player position.',
    'Continue toward the same useful, safe target across samples even if its current bearing changes.',
    'Keep the crystal target separate from the safest heading now. When many crystals and pursuers share a side, keep a valuable target without entering contact range.',
    'Use enemy positions, motion, and gaps to judge whether a lateral move or a wide arc could draw pursuers aside. Return when observations show a safe approach.',
    'With a whip, consider facing left or right toward pursuers while keeping distance. The whip fires automatically on cooldown and hits within its reach. Turning alone does not hit.',
    'Check the recorded movement and world changes for an opening, actual progress toward the target, or continued damage. Revise the heading or target if needed instead of continually moving away from crystals.',
    'A missing item may be out of view or omitted. Absence does not prove pickup.',
    'Skip attracted or reobserved-absent targets when choosing a useful objective.',
  ].join(' ')};
}

export function decodeAdvisorChoice(raw, context, validateDecision) {
  let data;
  try { data = JSON.parse(raw); } catch { /* handled by response validation */ }
  const question = advisorQuestion(context);
  if (!Array.isArray(data?.answers) || data.answers.length !== 1 || data.answers[0]?.name !== question.name) {
    throw new ResearchModelError('malformed', 'Decisions did not return the single guidance answer');
  }
  const choice = validateDecision(data.answers[0], question.choices.map(item => item.value));
  const parts = choice.split(':');
  return {target_id: parts.length === 3 ? Number(parts[1]) : null, heading: parts.at(-1)};
}

export const MICRO_ADVICE_INSTRUCTIONS = [
  'You alone choose the next action. Follow the current valid advised heading while keeping enough clearance to avoid imminent contact.',
  'Use observed enemy positions and motion to predict where pursuers will move toward you and avoid enemies in your path.',
  'A quieter direction alone is no reason to leave the advised heading. If contact is imminent along that heading, sidestep or retreat briefly, then resume useful advice when a gap opens.',
  'Follow a valid heading even without a crystal target. Treat an unknown target position as last known. Without a usable heading, assess nearby crystals and escape routes from this frame.',
  'The movement vector is actual motion. Check the last applied decision and subsequent hits in direction_context against this frame.',
].join(' ');

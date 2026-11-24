import {wholePathInput} from './whole-path-protocol.mjs';

export const PATH_PROMPT_TEMPLATE = [
  'You are choosing one complete three-step path, with 100 ms per step.',
  'Each step starts where the previous step ends, so add the displacement of the steps from the current observation origin. Right is +x and down is +y.',
  'For this observation, unobstructed travel per 100 ms step is {{step_distance}} world units and the circular gem pickup radius is {{pickup_radius}} world units.',
  'Compare the entire path, including the segments between turns, for contact risk from visible enemies and their observed motion.',
  'Check whether any segment enters the pickup circle of an experience gem that has not started following you. Entering the circle is enough.',
  'Consider both horizontal and vertical offsets. Turn when needed so progress on one axis does not leave the other axis too far away.',
  'When contact risk is similar, favor the path that starts attracting more un-attracted gems. If none are reachable this plan, choose a safe approach.',
  'Gems already being collected follow you, so keep moving toward the next opportunity.',
  'Select exactly one offered path through the native choice. Do not output reasoning.',
].join(' ');

export function pathPromptInput(observation, strategy, arm) {
  if (arm !== 'old' && arm !== 'new') throw new TypeError('Expected the old or new path prompt arm');
  const base = wholePathInput(observation, strategy, 'whole-path');
  if (arm === 'old') return base;
  const stepDistance = observation.player?.movement_distance?.unobstructed_100_ms;
  const pickupRadius = observation.player?.gem_pickup_radius;
  if (![stepDistance, pickupRadius].every(value => Number.isFinite(value) && value >= 0)) {
    throw new TypeError('Expected the observed 100 ms movement scale and gem pickup radius');
  }
  const text = PATH_PROMPT_TEMPLATE.replace('{{step_distance}}', String(stepDistance))
    .replace('{{pickup_radius}}', String(pickupRadius));
  const [message] = base.input;
  return {...base, input: [{...message, content: [...message.content, {type: 'input_text', text}]}]};
}

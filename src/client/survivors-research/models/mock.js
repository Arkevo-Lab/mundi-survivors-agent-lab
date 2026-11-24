import { RESEARCH_SLOTS_PROFILE, RESEARCH_SLOTS_COUNT, upgradeRound } from './action-slots.js';
import { SEQUENCE_ACTION_PROFILE } from './action-sequence.js';
import { parseAction } from './action-prompt.js';
import { validateVisualImage } from './visual-input.js';
import { delay, ResearchModelError, timedModel } from './common.js';

const directions = {
  up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
  'up-left': [-1, -1], 'up-right': [1, -1],
  'down-left': [-1, 1], 'down-right': [1, 1],
};

function ruleChoice({ observation, candidates }) {
  const enemy = observation.enemies?.find(item => Number.isFinite(item.dx) && Number.isFinite(item.dy));
  if (!enemy || (!enemy.dx && !enemy.dy)) return 'stop';
  let best = 'stop';
  let bestScore = 0;
  for (const { id } of candidates) {
    const [, direction, profile, length] = id.split(':');
    const vector = directions[direction];
    if (!id.startsWith('move:') || !vector) continue;
    if (profile === 'hold' && length !== '200') continue;
    if (profile === 'distance' && length !== '1') continue;
    const score = -(enemy.dx * vector[0] + enemy.dy * vector[1]) / Math.hypot(...vector);
    if (score > bestScore) {
      best = id;
      bestScore = score;
    }
  }
  return best;
}

export function createMockModel(config) {
  const kind = config.kind ?? 'mock';
  const strategy = config.strategy ?? (kind === 'mock' ? 'fixed' : kind);
  const delayMs = config.delay_ms ?? 0;
  const failure = config.failure ?? 'none';
  const seed = config.seed ?? 11;
  const fixedActionId = config.action_id ?? 'stop';
  if (!['fixed', 'random', 'rule'].includes(strategy)) throw new TypeError('Unknown baseline strategy');
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) throw new RangeError('Invalid mock delay');
  if (!['none', 'timeout', 'malformed', 'invalid', 'disconnect'].includes(failure)) {
    throw new TypeError('Unknown mock failure mode');
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('Invalid random seed');
  let randomState = seed;
  const randomChoice = candidates => {
    randomState = (Math.imul(1664525, randomState) + 1013904223) >>> 0;
    return candidates[Math.floor(randomState * candidates.length / 0x100000000)]?.id;
  };
  const choices = { fixed: () => fixedActionId, random: ({ candidates }) => randomChoice(candidates), rule: ruleChoice };
  const metadata = { simulated: true, provider: 'local-baseline', strategy };
  return timedModel(
    { kind, strategy, delay_ms: delayMs, failure, seed, action_id: fixedActionId, timeout_ms: config.timeout_ms },
    async ({ observation, candidates, action_profile }, signal) => {
      const input = { observation, candidates };
      await delay(delayMs, signal);
      if (failure === 'timeout') await delay(30_001, signal);
      if (failure === 'disconnect') throw new ResearchModelError('disconnected', 'Mock model disconnected');
      let actionId = failure === 'invalid' ? 'mock:invalid-action' : choices[strategy](input);
      if (action_profile === RESEARCH_SLOTS_PROFILE && actionId === 'stop') {
        actionId = candidates.find(candidate => candidate.id.startsWith('wait:'))?.id ?? candidates[0]?.id;
      }
      return {
        input,
        raw_response: failure === 'malformed' ? 'mock:malformed-json' : JSON.stringify({ action_id: actionId }),
        usage: null,
        backend_metadata: metadata,
      };
    },
    (raw, candidates, actionProfile) => {
      const action = parseAction(raw);
      if (actionProfile === RESEARCH_SLOTS_PROFILE) return Array(upgradeRound(candidates) ? 1 : RESEARCH_SLOTS_COUNT).fill(action);
      return actionProfile === SEQUENCE_ACTION_PROFILE ? [action] : action;
    },
    {
      metadata,
      transportKind: 'local_mock',
      prepare: ({ observation, candidates, image }) => {
        if (image !== undefined) validateVisualImage(image, observation.tick);
        return { observation, candidates };
      },
    },
  );
}

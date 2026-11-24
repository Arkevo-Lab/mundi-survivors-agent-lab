import { WHOLE_PATH_EIGHT_DIRECTION_MODE, WHOLE_PATH_MODE, WHOLE_PATH_ONLY_QUESTION_MODE, WHOLE_PATH_STAGGERED_MODE } from './action-whole-path.js';
import { ResearchModelError } from './common.js';
import { createOpenAIDecisionsModel, DECISIONS_MODEL, DECISIONS_PROFILE, validTrainingStrategy } from './decisions.js';

export const LOCAL_FARM_STRATEGY_SOURCE = "Start a repeatable local farm: keep one approaching pack on your horizontal whip side and near lash range, with a clear exit. Use short side steps or stand briefly when a pack is outside contact and about to enter attack range. Do not keep traveling away from enemies and drops. When contact is imminent, move through the clearest nearby gap for just long enough to open space, then reassess and circle back to fresh drops from the open side. As soon as you see a safe uncollected experience gem or cluster, aim at its relative dx/dy and plan to cross its pickup radius. A typical 500 ms plan at base speed can travel 1.6 world units, so commit several 50 ms slots to the same useful heading when the gem is farther away than one slot. Attract the next safe gem while collected ones follow. Use an adjacent safe drop as the next target instead of fleeing the farm or waiting for a following gem to finish. Secure early gems for the first upgrade and keep enough space to avoid repeated contact.\n";
export const LOCAL_FARM_STRATEGY_SOURCE_SHA256 = '782983fe79776f198a4aa58b69d4b4f94a376e638ae0eacc201fe08ee0dae4b0';
const SLOT_TIMING = "A typical 500 ms plan at base speed can travel 1.6 world units, so commit several 50 ms slots to the same useful heading when the gem is farther away than one slot.";
const PATH_TIMING = "A typical 300 ms plan at base speed can travel 0.96 world units, so commit several 100 ms steps to the same useful heading when the gem is farther away than one step.";
export const WHOLE_PATH_STRATEGY = LOCAL_FARM_STRATEGY_SOURCE.replace(SLOT_TIMING, PATH_TIMING);
export const WHOLE_PATH_STRATEGY_SHA256 = '349d87e38b1b590d22642b21c6fb5c3e5e7b26dd39c08423419665da91ccf2bc';

const FARM_COMBAT_GUIDANCE = "If no safe, reachable, un-attracted experience gem is available, deliberately engage a nearby pack from a safe distance to create new drops. With a whip, position so a nearby target is to your left or right and face that side while keeping a clear exit. The whip attacks automatically when its cooldown is ready. The first lash only reaches enemies inside its attack area on your current facing side. Extra lashes may strike behind you. Facing alone will not hit a distant enemy.";
export const WHOLE_PATH_FARM_STRATEGY = WHOLE_PATH_STRATEGY + FARM_COMBAT_GUIDANCE + '\n';
export const WHOLE_PATH_FARM_STRATEGY_SHA256 = 'fdbde5b6d704889f8717684e55218911a4acef96f70464cea78ee73b662ec1b0';

const EIGHT_DIRECTION_PATH_TIMING = "A typical 300 ms plan at base speed can travel 0.96 world units, so use both 150 ms steps in the same useful heading when the gem is farther away than one step.";
export const WHOLE_PATH_EIGHT_DIRECTION_FARM_STRATEGY = WHOLE_PATH_FARM_STRATEGY.replace(PATH_TIMING, EIGHT_DIRECTION_PATH_TIMING);
export const WHOLE_PATH_EIGHT_DIRECTION_FARM_STRATEGY_SHA256 = '51f12db8f091d9b8ca047d0cb7aae46b9e873543804ba7ee86ccfecbf44cf51b';

const STAGGERED_PATH_TIMING = "A typical 300 ms plan at base speed can travel 0.96 world units, so commit several steps to the same useful heading when the gem is farther away than one step.";
export const WHOLE_PATH_STAGGERED_FARM_STRATEGY = WHOLE_PATH_FARM_STRATEGY.replace(PATH_TIMING, STAGGERED_PATH_TIMING);
export const WHOLE_PATH_STAGGERED_FARM_STRATEGY_SHA256 = '64c706c7e66f4c5f521a779493d5721d2b7cb059f3aaaf2d88c382dd20f9a87d';

const farmStrategies = new Map([
  [WHOLE_PATH_EIGHT_DIRECTION_MODE, WHOLE_PATH_EIGHT_DIRECTION_FARM_STRATEGY],
  [WHOLE_PATH_STAGGERED_MODE, WHOLE_PATH_STAGGERED_FARM_STRATEGY],
]);

export const WHOLE_PATH_GUIDANCE_SCHEMA = 'survivors-whole-path-guidance-v1';
const encoder = new TextEncoder();

function effectiveStrategy(candidate, mode) {
  const base = farmStrategies.get(mode) ?? WHOLE_PATH_FARM_STRATEGY;
  if (candidate === undefined) return base;
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate) ||
      Object.keys(candidate).length !== 2 || !Object.hasOwn(candidate, 'schema') || !Object.hasOwn(candidate, 'guidance') ||
      candidate.schema !== WHOLE_PATH_GUIDANCE_SCHEMA || typeof candidate.guidance !== 'string' ||
      candidate.guidance.length === 0 || candidate.guidance.trim() !== candidate.guidance ||
      /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(candidate.guidance) ||
      encoder.encode(candidate.guidance).length > 800) {
    throw new TypeError('Expected one bounded plain-text whole-path guidance paragraph');
  }
  const strategy = base + candidate.guidance + '\n';
  if (!validTrainingStrategy(strategy)) throw new TypeError('Whole-path strategy exceeds the native route limits');
  return strategy;
}

export async function wholePathStrategyDigest(candidate, mode) {
  const bytes = encoder.encode(effectiveStrategy(candidate, mode));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createIteratedWholePathModel(candidate, pathQuestionGuidance, wholePathContext, pathChoiceOrder, movementFeedback, mode = WHOLE_PATH_MODE, wholePathQuestionMode, pathChoiceFormat) {
  const native = createOpenAIDecisionsModel({
    model: DECISIONS_MODEL, generation_profile: DECISIONS_PROFILE, localConnection: true, timeout_ms: 10000,
    training_strategy: effectiveStrategy(candidate, mode), movement_protocol: mode,
    path_question_guidance: pathQuestionGuidance, whole_path_context: wholePathContext, path_choice_order: pathChoiceOrder,
    movement_feedback: movementFeedback, whole_path_question_mode: wholePathQuestionMode,
    path_choice_format: pathChoiceFormat,
  });
  return { ...native, decide(args) {
    if (wholePathQuestionMode === WHOLE_PATH_ONLY_QUESTION_MODE) {
      if (Object.hasOwn(args.observation ?? {}, 'training_intent')) {
        throw new ResearchModelError('invalid_whole_path_question_mode', 'Path-only Decisions requires an observation without training intent');
      }
      return native.decide(args);
    }
    if (args.observation.upgrade_offer) return native.decide(args);
    const observation = { ...args.observation, training_intent: { mode: 'goal-stateless-v1', prior: null } };
    return native.decide({ ...args, observation });
  }};
}

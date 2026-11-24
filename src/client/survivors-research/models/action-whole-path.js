import { RESEARCH_SEQUENCE_PROFILE, researchCandidates } from '../../../shared/survivors-research-contract.js';

export const WHOLE_PATH_MODE = 'whole-path-v1';
export const WHOLE_PATH_ONLY_QUESTION_MODE = 'path-only-v1';
export const WHOLE_PATH_COMPACT_SEQUENCE_FORMAT = 'compact-sequence-v1';
export const WHOLE_PATH_EIGHT_DIRECTION_MODE = 'whole-path-8x2-v1';
export const WHOLE_PATH_STAGGERED_MODE = 'whole-path-50-50-200-v1';
export const isWholePathMode = mode => catalogs.has(mode);
export const WHOLE_PATH_TICK_ROTATION = 'tick-rotation-21-v1';
export const WHOLE_PATH_QUESTION_SCHEMA = 'survivors-whole-path-question-v1';
const encoder = new TextEncoder();

export function validateWholePathQuestionGuidance(candidate) {
  if (candidate === undefined) return undefined;
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate) ||
      Object.keys(candidate).length !== 2 || !Object.hasOwn(candidate, 'schema') || !Object.hasOwn(candidate, 'guidance') ||
      candidate.schema !== WHOLE_PATH_QUESTION_SCHEMA || typeof candidate.guidance !== 'string' ||
      candidate.guidance.trim() !== candidate.guidance || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(candidate.guidance) ||
      encoder.encode(candidate.guidance).length > 800) {
    throw new TypeError('Expected one bounded plain-text whole-path question paragraph');
  }
  return candidate.guidance ? { schema: WHOLE_PATH_QUESTION_SCHEMA, guidance: candidate.guidance } : undefined;
}

export const WHOLE_PATH_STEPS = Object.freeze(['0–100 ms', '100–200 ms', '200–300 ms']);
export const WHOLE_PATH_DIRECTIONS = Object.freeze(['up', 'down', 'left', 'right']);

const eightDirections = researchCandidates(RESEARCH_SEQUENCE_PROFILE)
  .map(({ id }) => /^move:([a-z-]+):hold:150$/.exec(id)?.[1]).filter(Boolean);
const pathCatalog = (directions, steps, instructions, holdDurations) => {
  const sequences = steps.reduce(paths => paths.flatMap(path =>
    directions.map(direction => [...path, direction])), [[]]);
  const paths = sequences.map(path => Object.freeze({
    value: path.join(':'),
    description: path.map((direction, index) => steps[index] + ': move ' + direction).join(', ') + '.',
  }));
  const byValue = new Map(paths.map(({ value }, index) => [value, Object.freeze(sequences[index])]));
  return { paths, byValue, instructions, holdDurations: Object.freeze(holdDurations) };
};
const catalogs = new Map([
  [WHOLE_PATH_MODE, pathCatalog(WHOLE_PATH_DIRECTIONS, WHOLE_PATH_STEPS,
    'Choose one complete ordered three-step plan. Execute its directions in order, 100 ms each.', [100, 100, 100])],
  [WHOLE_PATH_EIGHT_DIRECTION_MODE, pathCatalog(eightDirections, ['0–150 ms', '150–300 ms'],
    'Choose one complete ordered two-step plan. Execute its directions in order, 150 ms each.', [150, 150])],
  [WHOLE_PATH_STAGGERED_MODE, pathCatalog(WHOLE_PATH_DIRECTIONS, ['0–50 ms', '50–100 ms', '100–300 ms'],
    'Choose one complete ordered three-step plan. Execute its directions in order for 50 ms, 50 ms and 200 ms.', [50, 50, 200])],
]);
export const wholePathChoiceOffset = tick => (21 * (tick % catalogs.get(WHOLE_PATH_MODE).paths.length)) % catalogs.get(WHOLE_PATH_MODE).paths.length;

export function wholePathQuestion(candidate, offset = 0, mode = WHOLE_PATH_MODE, format) {
  if (format !== undefined && (format !== WHOLE_PATH_COMPACT_SEQUENCE_FORMAT || mode !== WHOLE_PATH_MODE || offset !== 0)) {
    throw new TypeError('Invalid whole-path choice format');
  }
  const { paths, instructions, byValue } = catalogs.get(mode);
  const ordered = [...paths.slice(offset), ...paths.slice(0, offset)];
  return {
    type: 'choice', name: 'path',
    instructions: candidate ? instructions + ' ' + candidate.guidance : instructions,
    choices: format === WHOLE_PATH_COMPACT_SEQUENCE_FORMAT
      ? ordered.map(({value}) => ({ value, description: byValue.get(value).join(' > ') }))
      : ordered,
  };
}

export async function wholePathQuestionDigest(candidate, mode = WHOLE_PATH_MODE) {
  const question = wholePathQuestion(validateWholePathQuestionGuidance(candidate), 0, mode);
  const bytes = encoder.encode(question.instructions);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export const wholePathDirections = (value, mode = WHOLE_PATH_MODE) => catalogs.get(mode).byValue.get(value);
export const wholePathHoldDurations = (mode = WHOLE_PATH_MODE) => catalogs.get(mode).holdDurations;

import { ResearchModelError } from './common.js';
import { validActionContext } from './action-observation.js';
import { SEQUENCE_ACTION_PROFILE, SEQUENCE_POLICY } from './action-sequence.js';
import { STRUCTURED_IMAGE_LEGEND, STRUCTURED_NEAR_IMAGE_LEGEND, STRUCTURED_NEAR_PROFILE,
  STRUCTURED_TRAIL_IMAGE_LEGEND, STRUCTURED_TRAIL_PROFILE, validateVisualImage, VISUAL_IMAGE_REFERENCE } from './visual-input.js';

export const ACTION_PROMPT_VERSION = 'survivors-direct-action-v6';
export const ACTION_PROVIDER = 'mundi-owned-chat-completions';
export const ACTION_CONNECTION = 'account-model-settings';
export const COMPATIBLE_GENERATION_PROFILE = 'compatible-chat-completions-v1';
export const OPENAI_GENERATION_PROFILE = 'openai-chat-completions-v1';
const responseFormat = Object.freeze({ type: 'json_object' });
const compatibleParameters = Object.freeze({ response_format: responseFormat, max_tokens: 1024, stream: false });
const openAIParameters = Object.freeze({ response_format: responseFormat, max_completion_tokens: 1024, stream: false });
const openAIMiniParameters = Object.freeze({ ...openAIParameters, reasoning_effort: 'none' });

export function isOpenAIMini(model) {
  return model === 'gpt-5.4-mini' || model === 'gpt-5.4-mini-2026-03-17';
}

export function actionGenerationParameters(model, profile = COMPATIBLE_GENERATION_PROFILE) {
  switch (profile) {
    case COMPATIBLE_GENERATION_PROFILE: return compatibleParameters;
    case OPENAI_GENERATION_PROFILE: return isOpenAIMini(model) ? openAIMiniParameters : openAIParameters;
    default: throw new TypeError('Unknown research model generation profile');
  }
}

export const ACTION_POLICY = [
  'Choose one action for the Mundi Survivors real-time research game.',
  'Stay alive until time runs out. Subject to survival, your highest priority is to collect as many experience gems as possible.',
  'Attacks fire automatically. Move to keep enemies in range without letting them touch you.',
  'Defeated monsters may drop experience gems. They are blue crystals and have kind "experience" in loot.',
  'Move close to a gem to start automatic pickup. If shown, player.gem_pickup_radius is the distance needed.',
  'When the path is safe, choose movement that takes you toward nearby gems or through a cluster to gain XP and unlock upgrades.',
  'If enemies block the path, circle around them and return to the gems when it is safe.',
  'Gems marked being_collected are already coming to you.',
  'The hostile field indicates whether an effect in hazards can threaten the player.',
  'Select upgrades using a listed upgrade action.',
  'Positions are relative to the player in world units. Right is +x and down is +y.',
  'Movement persists for its listed duration or distance, or until replaced. Stop cancels movement.',
  'The game continues while you decide. Use the supplied observation and candidate list, and the same-tick image when provided.',
].join(' ');

export function structuredImageLegend(profile) {
  if (profile === STRUCTURED_NEAR_PROFILE) return STRUCTURED_NEAR_IMAGE_LEGEND;
  if (profile === STRUCTURED_TRAIL_PROFILE) return STRUCTURED_TRAIL_IMAGE_LEGEND;
  if (profile === 'structured-v1') return STRUCTURED_IMAGE_LEGEND;
}

export function actionModelInput(model, { observation, candidates, image, action_profile }, profile) {
  if (image?.profile === STRUCTURED_TRAIL_PROFILE) {
    throw new ResearchModelError('invalid_visual_input', 'Actual trail images require whole-path Decisions');
  }
  if (!validActionContext({ observation, candidates })) {
    throw new ResearchModelError('invalid_observation', 'Expected only the public research observation and candidate fields');
  }
  const text = JSON.stringify({ observation, candidates });
  if (image !== undefined) validateVisualImage(image, observation.tick);
  const legend = structuredImageLegend(image?.profile);
  const content = image === undefined ? text : [
    { type: 'text', text },
    { type: 'image_url', image_url: { url: VISUAL_IMAGE_REFERENCE } },
    ...(legend ? [{type: 'text', text: legend}] : []),
  ];
  const system = action_profile === SEQUENCE_ACTION_PROFILE
    ? ACTION_POLICY + ' ' + SEQUENCE_POLICY + ' Return exactly one JSON object with only action_ids, an array of listed candidate IDs.'
    : ACTION_POLICY + ' Return exactly one JSON object containing only "action_id", copied verbatim from a listed candidate.';
  return {
    model,
    ...actionGenerationParameters(model, profile),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content },
    ],
  };
}

export function restoreActionImage(input, image) {
  const [systemMessage, userMessage] = input.messages;
  const [textPart, imagePart, ...rest] = userMessage.content;
  if (imagePart?.image_url?.url !== VISUAL_IMAGE_REFERENCE) {
    throw new ResearchModelError('invalid_visual_input', 'Missing image reference in the research request');
  }
  return {
    ...input,
    messages: [
      systemMessage,
      { ...userMessage, content: [textPart, { ...imagePart, image_url: { ...imagePart.image_url, url: image.data_url } }, ...rest] },
    ],
  };
}

export function parseAction(raw) {
  let action;
  try { action = JSON.parse(raw); } catch { /* invalid model output */ }
  if (!action || typeof action.action_id !== 'string' || Object.keys(action).length !== 1) {
    throw new ResearchModelError('malformed', 'Expected exactly one JSON action_id');
  }
  return action.action_id;
}

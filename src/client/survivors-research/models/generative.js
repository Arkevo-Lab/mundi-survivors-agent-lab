import { RESEARCH_SLOTS_PROFILE } from './action-slots.js';
import { parseActionSequence, SEQUENCE_ACTION_PROFILE } from './action-sequence.js';
import { ACTION_CONNECTION, ACTION_PROMPT_VERSION, ACTION_PROVIDER, COMPATIBLE_GENERATION_PROFILE, OPENAI_GENERATION_PROFILE, actionGenerationParameters, actionModelInput, parseAction } from './action-prompt.js';
import { ResearchModelError, timedModel } from './common.js';
import { modelProviderRequest } from './provider-http.js';

export function createGenerativeModel(config) {
  const { model, generation_profile: configuredProfile } = config;
  const profile = configuredProfile ?? COMPATIBLE_GENERATION_PROFILE;
  if (typeof model !== 'string' || !model) throw new TypeError('Load the saved research model connection first');
  const metadata = { provider: ACTION_PROVIDER, model, simulated: false, upstream_dispatched: null };
  return timedModel({
    kind: 'generative',
    provider: ACTION_PROVIDER, model,
    ...(profile === OPENAI_GENERATION_PROFILE && { endpoint: '/v1/chat/completions' }),
    connection_ref: (config.apiKey || config.localConnection) ? 'local-research-key' : ACTION_CONNECTION,
    prompt_version: ACTION_PROMPT_VERSION,
    generation_profile: profile,
    generation_parameters: actionGenerationParameters(model, profile),
    timeout_ms: config.timeout_ms,
  }, modelProviderRequest('/api/survivors-research/model/action', {
    model, timeout_ms: config.timeout_ms, configuredProfile, metadata, apiKey: config.apiKey, localConnection: config.localConnection,
  }), (raw, candidates, actionProfile) => {
    let reply;
    try { reply = JSON.parse(raw); } catch { /* invalid provider response */ }
    const choice = reply?.choices?.[0];
    if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') {
      throw new ResearchModelError('provider_refusal', 'The model declined to choose an action');
    }
    if (choice?.finish_reason === 'length') {
      throw new ResearchModelError('truncated', 'Model reached its response token limit');
    }
    if (typeof choice?.message?.content !== 'string') {
      throw new ResearchModelError('malformed', 'Provider response did not contain action text');
    }
    return actionProfile === SEQUENCE_ACTION_PROFILE ? parseActionSequence(choice.message.content, candidates)
      : parseAction(choice.message.content);
  }, {
    prepare: input => {
      if (input.action_profile === RESEARCH_SLOTS_PROFILE) {
        throw new ResearchModelError('unsupported_action_profile', 'Fixed slots require Decisions');
      }
      return actionModelInput(model, input, profile);
    },
    metadata,
    transportMeasuredByRequest: true,
  });
}

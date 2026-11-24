import { ResearchModelError, researchNow } from './common.js';
import { elapsed } from './decision-timing.js';

const endpoint = '/api/survivors-research/model';

export async function getResearchModelStatus({ kind, signal } = {}) {
  const response = await fetch(kind === 'openai-decisions' ? endpoint + '/decisions' : endpoint, { signal, mode: 'same-origin', cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new ResearchModelError(
    response.status === 401 ? 'sign_in_required' : 'connection_unavailable',
    typeof data.error === 'string' ? data.error : 'Could not load the saved model connection',
  );
  return data;
}

export function modelProviderRequest(path, { model, timeout_ms, configuredProfile, metadata, apiKey, localConnection, slotSample, trainingStrategy, trainingControls, movementProtocol, wholePathQuestionMode, pathQuestionGuidance, wholePathContext, pathChoiceOrder, movementFeedback, pathChoiceFormat, localPathMicro }) {
  return async ({ observation, candidates, image, action_profile, advisor_role, advisor_context, strategy_context, combat_context, local_feedback, local_facing, local_projection, provider_profile }, signal, timings) => {
    timings.input_serialize_started_at_ms = researchNow();
    let body;
    try { body = JSON.stringify({ observation, candidates, model, timeout_ms, image, action_profile, slot_sample: slotSample,
      training_strategy: observation.upgrade_offer ? undefined : trainingStrategy,
      training_controls: observation.upgrade_offer ? undefined : trainingControls,
      movement_protocol: observation.upgrade_offer ? undefined : movementProtocol,
      whole_path_question_mode: observation.upgrade_offer ? undefined : wholePathQuestionMode,
      path_question_guidance: observation.upgrade_offer ? undefined : pathQuestionGuidance,
      whole_path_context: observation.upgrade_offer ? undefined : wholePathContext,
      path_choice_order: observation.upgrade_offer ? undefined : pathChoiceOrder,
      path_choice_format: observation.upgrade_offer ? undefined : pathChoiceFormat,
      movement_feedback: observation.upgrade_offer ? undefined : movementFeedback, generation_profile: configuredProfile,
      advisor_role, advisor_context, strategy_context, combat_context, local_feedback, local_facing, local_projection, provider_profile,
      ...(localPathMicro === true && {local_path_micro:true}) }); }
    finally {
      timings.input_serialize_finished_at_ms = researchNow();
      timings.input_serialize_ms = elapsed(timings.input_serialize_started_at_ms, timings.input_serialize_finished_at_ms);
    }
    signal.throwIfAborted();
    timings.transport_kind = 'browser_http';
    timings.transport_started_at_ms = researchNow();
    let response;
    let responseText;
    try {
      response = await fetch(path, {
        method: 'POST',
        mode: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? {'X-Mundi-Research-Key': apiKey} : localConnection ? {'X-Mundi-Local-Connection': '1'} : {}) },
        body,
        signal,
      });
      responseText = await response.text();
    } finally {
      timings.transport_finished_at_ms = researchNow();
    }
    timings.response_decode_started_at_ms = researchNow();
    let data;
    try { data = JSON.parse(responseText); }
    finally {
      timings.response_decode_finished_at_ms = researchNow();
      timings.response_decode_ms = elapsed(timings.response_decode_started_at_ms, timings.response_decode_finished_at_ms);
    }
    if (!response.ok) {
      const detail = data?.error;
      throw new ResearchModelError(
        detail?.code ?? 'connection_unavailable',
        typeof detail === 'string' ? detail : detail?.message ?? 'Saved model connection unavailable',
        {
          ...data.trace,
          backend_metadata: {
            ...metadata,
            http_status: response.status,
            upstream_dispatched: response.status < 500 ? false : null,
            ...data.trace?.backend_metadata,
          },
        },
      );
    }
    return data;
  };
}

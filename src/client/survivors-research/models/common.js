import { elapsed } from './decision-timing.js';

export const researchNow = () => performance.timeOrigin + performance.now();
export const DEFAULT_TIMEOUT_MS = 30_000;

export class ResearchModelError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ResearchModelError';
    this.code = code;
    this.details = details;
  }
}

export function validateTimeout(timeout = DEFAULT_TIMEOUT_MS) {
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000) {
    throw new RangeError('Model timeout must be an integer from 1 to 30000 ms');
  }
  return timeout;
}

export function timedModel(config, request, select, {
  prepare = input => input, metadata = null, transportKind = null, transportMeasuredByRequest = false,
} = {}) {
  const timeout = validateTimeout(config.timeout_ms);
  return {
    config: { ...config, timeout_ms: timeout },
    async decide({ observation, candidates, image, signal, action_profile, advisor_role, advisor_context, strategy_context, combat_context, local_feedback, local_facing, local_projection, provider_profile }) {
      const context = image === undefined ? { observation, candidates } : { observation, candidates, image };
      if (action_profile !== undefined) context.action_profile = action_profile;
      if (advisor_role !== undefined || advisor_context !== undefined) Object.assign(context, {advisor_role, advisor_context});
      if (strategy_context !== undefined) context.strategy_context = strategy_context;
      if (combat_context !== undefined) context.combat_context = combat_context;
      if (advisor_role === 'local-micro') Object.assign(context,{local_feedback,local_facing,local_projection});
      if (provider_profile !== undefined) context.provider_profile = provider_profile;
      let input = null;
      const timings = {
        request_started_at_ms: researchNow(),
        response_completed_at_ms: null,
        parsed_at_ms: null,
      };
      const deadline = AbortSignal.timeout(timeout);
      const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
      let response;
      try {
        timings.input_prepare_started_at_ms = researchNow();
        try { input = prepare(context); }
        finally {
          timings.input_prepare_finished_at_ms = researchNow();
          timings.input_prepare_ms = elapsed(timings.input_prepare_started_at_ms, timings.input_prepare_finished_at_ms);
        }
        requestSignal.throwIfAborted();
        if (!transportMeasuredByRequest) {
          timings.transport_kind = transportKind;
          timings.transport_started_at_ms = researchNow();
        }
        try { response = await request(context, requestSignal, timings); }
        finally {
          if (!transportMeasuredByRequest) timings.transport_finished_at_ms = researchNow();
        }
        timings.response_completed_at_ms = researchNow();
        requestSignal.throwIfAborted();
        timings.output_parse_started_at_ms = researchNow();
        let actionId;
        let actionIds;
        let goalId;
        let guidance;
        try {
          const selection = select(response.raw_response, candidates, action_profile, observation, response.local_action_id, context);
          if (Array.isArray(selection)) actionIds = selection;
          else if (selection && typeof selection === 'object') {
            actionIds = selection.action_ids;
            goalId = selection.goal_id;
            if (advisor_role === 'advisor' || advisor_role === 'cardinal-advisor') guidance = selection.guidance;
          }
          actionId = actionIds ? actionIds[0] : typeof selection === 'string' ? selection : undefined;
          if ((actionId !== undefined || goalId === undefined && guidance === undefined) && !candidates.some(candidate => candidate.id === actionId)) {
            throw new ResearchModelError('invalid_action', 'Model selected an action outside the candidate list');
          }
        } finally {
          timings.parsed_at_ms = researchNow();
          timings.output_parse_ms = elapsed(timings.output_parse_started_at_ms, timings.parsed_at_ms);
        }
        return { ...response, input: response.input === null && response.local_action_id ? null : response.input ?? input,
          ...(actionId !== undefined && {action_id: actionId}), ...(actionIds && { action_ids: actionIds }),
          ...(goalId !== undefined && {goal_id: goalId}), ...(guidance !== undefined && {guidance}), timings };
      } catch (error) {
        const errorDetails = error instanceof ResearchModelError ? error.details : {};
        if (errorDetails.raw_response != null) timings.response_completed_at_ms ??= researchNow();
        const details = {
          input: response?.input ?? input,
          raw_response: response?.raw_response ?? null,
          usage: response?.usage ?? null,
          backend_metadata: response?.backend_metadata ?? metadata,
          ...errorDetails,
          timings: { ...timings, ...errorDetails.timings },
        };
        if (signal?.aborted) throw new ResearchModelError('cancelled', 'Model request cancelled', details);
        if (deadline.aborted) throw new ResearchModelError('timeout', 'Model request timed out', details);
        if (error instanceof ResearchModelError) throw new ResearchModelError(error.code, error.message, details);
        throw new ResearchModelError('model_unavailable', 'Model request failed', details);
      }
    },
  };
}

export function delay(ms, signal) {
  signal.throwIfAborted();
  if (ms === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

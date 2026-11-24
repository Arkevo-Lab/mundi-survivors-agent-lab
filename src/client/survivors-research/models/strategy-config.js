// Strategy settings are separate from the latency-sensitive action models.
export const STRATEGY_MODEL = 'gpt-6.1-terra';
export const STRATEGY_REASONING_EFFORT = 'high';
export const STRATEGY_MAX_COMPLETION_TOKENS = 8192;
export const STRATEGY_SERVER_TIMEOUT_MS = 60000;
export const STRATEGY_CLIENT_TIMEOUT_MS = 65000;
export const STRATEGY_GENERATION_PARAMETERS = Object.freeze({
  response_format: Object.freeze({type:'json_object'}),
  max_completion_tokens: STRATEGY_MAX_COMPLETION_TOKENS,
  stream: false,
  reasoning_effort: STRATEGY_REASONING_EFFORT,
});

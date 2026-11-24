import {readFile} from 'node:fs/promises';
import {readModelText} from '../../src/server/api.js';
import {DECISIONS_MODEL, DECISIONS_PATH} from '../../src/client/survivors-research/models/decisions.js';

const endpoint = 'https://api.openai.com' + DECISIONS_PATH;
const keyPath = new URL('../../.local/survivors-research-openai.key', import.meta.url);
const readSavedKey = async () => (await readFile(keyPath, 'utf8')).trim();
const probability = value => Number.isFinite(value) && value >= 0 && value <= 1;

export function matchesChoice(answer, choices) {
  if (!choices?.has(answer?.choice) || answer.type !== 'choice' || !probability(answer.confidence) ||
      !Array.isArray(answer.probabilities) || answer.probabilities.length !== choices.size) return false;
  const remaining = new Set(choices);
  return answer.probabilities.every(row => remaining.delete(row?.value) && probability(row.probability));
}

export async function openNativeDecisionsTransport({prepare, validate}, {readKey = readSavedKey, fetchModel = fetch, timeoutMs = 8000} = {}) {
  let key = await readKey();
  if (typeof key !== 'string' || !/^[!-~]{20,256}$/.test(key)) throw Error('Local research connection is unavailable');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw RangeError('Invalid Decisions timeout');
  let active = false;
  return {
    close() { key = null; },
    async request(input, {signal} = {}) {
      if (!key || active) throw Error('Use an open transport with one request at a time');
      const started = performance.now();
      const expected = prepare(input);
      const body = JSON.stringify(input);
      const credential = key;
      const timeout = AbortSignal.timeout(timeoutMs);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let dispatched = false;
      let response;
      let upstreamRoundTripMs = null;
      let rawResponse = null;
      let data;
      let error = null;
      let validated = {};
      active = true;
      try {
        requestSignal.throwIfAborted();
        const sent = performance.now();
        dispatched = true;
        try {
          response = await fetchModel(endpoint, {
            method: 'POST', redirect: 'error', signal: requestSignal,
            headers: {Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json'}, body,
          });
          rawResponse = await readModelText(response);
        } finally {
          upstreamRoundTripMs = performance.now() - sent;
        }
        requestSignal.throwIfAborted();
        try {
          const parsed = JSON.parse(rawResponse);
          if (rawResponse.includes(credential) || JSON.stringify(parsed).includes(credential)) rawResponse = null;
          else data = parsed;
        } catch {
          // Malformed bodies cannot be reliably checked for credential echoes.
          rawResponse = null;
        }
        if (!response.ok) error = {code: 'provider_error'};
        else validated = validate(data?.answers, expected);
      } catch {
        error = {code: signal?.aborted ? 'cancelled' : timeout.aborted ? 'timeout'
          : response ? 'invalid_provider_response' : 'disconnected'};
        rawResponse = null;
      } finally {
        active = false;
      }
      const processingHeader = response?.headers.get('openai-processing-ms');
      const processingMs = /^[0-9]+(?:\.[0-9]+)?$/.test(processingHeader ?? '') ? Number(processingHeader) : NaN;
      return {
        input, raw_response: rawResponse, answers: null, error, ...validated,
        usage: data?.usage ?? null, http_status: response?.status ?? null, end_to_end_ms: performance.now() - started,
        backend_metadata: {
          model: DECISIONS_MODEL, endpoint: DECISIONS_PATH, provider_model: typeof data?.model === 'string' ? data.model : null,
          upstream_status: response?.status ?? null, upstream_dispatched: dispatched,
          upstream_round_trip_ms: upstreamRoundTripMs,
          upstream_openai_processing_ms: Number.isFinite(processingMs) ? processingMs : null,
        },
      };
    },
  };
}

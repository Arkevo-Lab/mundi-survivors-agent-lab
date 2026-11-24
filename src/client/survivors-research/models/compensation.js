import { measured } from './decision-timing.js';

export const LINK_CALIBRATION_MAX_AGE_MS = 30 * 60 * 1000;
export const MAX_LINK_COMPENSATION_MS = 1000;
const sourceSchema = 'mundi-link-calibration-v1';
const calibrationSchema = 'survivors-link-calibration-v1';

function validText(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 240;
}

function lineBaseline(line, now) {
  const { schema, line_id, endpoint, measured_at, method, metric, collector, route, samples, expected_http_status } = line ?? {};
  if (schema !== sourceSchema || ![line_id, endpoint, collector].every(validText) ||
      !((method === 'HEAD' && metric === 'warm-https-headers-ms') ||
        (method === 'GET' && metric === 'warm-https-total-ms')) ||
      (route !== undefined && !validText(route)) ||
      (expected_http_status !== undefined && expected_http_status !== 401) ||
      !Array.isArray(samples) || samples.length > 1000) {
    throw new TypeError('Invalid warm HTTPS baseline report');
  }
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new TypeError('Baseline endpoint must be HTTPS without credentials, query or fragment');
  }
  const at = typeof measured_at === 'number' ? measured_at : Date.parse(measured_at);
  if (!Number.isFinite(at) || at > now || now - at >= LINK_CALIBRATION_MAX_AGE_MS) {
    throw new RangeError('Warm baseline is expired or its measurement time is invalid');
  }
  const evidence = samples.map(sample => {
    const { ms, http_status, connection, error } = sample ?? {};
    return {
      ms: measured(ms), http_status: Number.isInteger(http_status) ? http_status : null,
      connection: ['new', 'reused', 'unknown'].includes(connection) ? connection : 'unknown',
      ...(error && { error: true }),
    };
  });
  const warm = evidence.filter(sample => sample.connection === 'reused' && sample.ms !== null &&
    (expected_http_status === 401 ? sample.http_status === 401 : sample.http_status >= 200 && sample.http_status < 300) &&
    !sample.error);
  if (warm.length < 3 || new Set(warm.map(sample => sample.http_status)).size !== 1) {
    throw new RangeError('Warm baseline requires at least three successful reused requests with the same HTTP status');
  }
  const sorted = warm.map(sample => sample.ms).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const p50 = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Object.freeze({
    schema, line_id, endpoint: url.href, measured_at: at, method, metric, collector,
    ...(route !== undefined && { route }),
    ...(expected_http_status !== undefined && { expected_http_status }),
    samples: Object.freeze(evidence.map(Object.freeze)),
    stats: Object.freeze({ n: sorted.length, excluded: evidence.length - sorted.length, p50_ms: p50,
      min_ms: sorted[0], max_ms: sorted.at(-1), http_status: warm[0].http_status }),
  });
}

export function calibrateLink(current, target, { now = Date.now(), allowProxy = false } = {}) {
  if (!Number.isFinite(now)) throw new TypeError('Invalid calibration clock');
  const a = lineBaseline(current, now);
  const b = lineBaseline(target, now);
  if (a.line_id === b.line_id) throw new TypeError('Current and target lines require distinct identifiers');
  if (a.method !== b.method || a.metric !== b.metric) throw new TypeError('Warm baseline methods and metrics must match');
  if (a.stats.http_status !== b.stats.http_status) throw new TypeError('Baseline HTTP statuses must match');
  const sameProbe = a.endpoint === b.endpoint && a.collector === b.collector;
  if (!sameProbe && !allowProxy) throw new TypeError('Different probe endpoint or collector requires explicit proxy opt-in');
  const budget = Math.max(0, a.stats.p50_ms - b.stats.p50_ms);
  if (budget > MAX_LINK_COMPENSATION_MS) throw new RangeError('Measured link delta exceeds the supported 1000 ms budget');
  return Object.freeze({
    schema: calibrationSchema,
    budget_ms: budget,
    current: a, target: b, comparison: sameProbe ? 'matched-probe-estimate' : 'proxy-estimate',
    calibrated_at_ms: now,
    expires_at_ms: Math.min(a.measured_at, b.measured_at) + LINK_CALIBRATION_MAX_AGE_MS,
  });
}

export function freezeLinkCalibration(calibration, now = Date.now()) {
  if (calibration?.schema !== calibrationSchema || !Number.isFinite(calibration.calibrated_at_ms) ||
      calibration.calibrated_at_ms > now) {
    throw new TypeError('Expected a measured link calibration');
  }
  const checked = calibrateLink(calibration.current, calibration.target, {
    now, allowProxy: calibration.comparison === 'proxy-estimate',
  });
  if (checked.budget_ms !== calibration.budget_ms || checked.comparison !== calibration.comparison ||
      checked.expires_at_ms !== calibration.expires_at_ms) {
    throw new TypeError('Link calibration does not match its source measurements');
  }
  return Object.freeze({ ...checked, calibrated_at_ms: calibration.calibrated_at_ms });
}

export function requestLatency(rawMs, budgetMs = 0) {
  const budget = measured(budgetMs);
  if (budget === null) throw new TypeError('Link compensation budget must be a nonnegative duration');
  const raw = measured(rawMs);
  return {
    raw_request_ms: raw,
    estimated_adjusted_request_ms: raw === null ? null : Math.max(0, raw - budget),
    link_compensation_ms: budget,
  };
}

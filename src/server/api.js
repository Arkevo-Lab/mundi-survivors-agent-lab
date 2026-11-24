// Minimal local adapter for the original R165 provider protocol. No account DB.
import {survivorsResearchModelRoute} from './survivors-research-model.js';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const json = (value, status = 200) => Response.json(value, {status, headers: {'Cache-Control':'no-store'}});

async function boundedText(body, limit) {
  if (!body) return '';
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); fail(413, 'Payload is too large'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder('utf-8', {fatal:true}).decode(bytes);
  } finally { reader.releaseLock(); }
}
export async function readModelText(response, maxBytes = 100000) {
  return boundedText(response.body, maxBytes);
}
async function readBody(request, maxBytes) {
  try { return JSON.parse(await boundedText(request.body, maxBytes)); }
  catch (error) { if (error instanceof HttpError) throw error; fail(400, 'Invalid JSON'); }
}
const windows = new Map();
async function rate(_db, key, limit, duration) {
  const now = Date.now();
  for (const [name, row] of windows) if (row.until <= now) windows.delete(name);
  const row = windows.get(key) ?? {until:now + duration, count:0};
  if (++row.count > limit) fail(429, 'Local request rate limit');
  windows.set(key, row);
}
export async function handleLocalResearchAction(request, env = {}, localKey, {allowJointPlan = false, naceKey} = {}) {
  try {
    return await survivorsResearchModelRoute(request, env, null, {
      first:() => fail(401, 'Account-backed credentials are not part of this lab'),
      rate, fail, json, readBody, readModelText,
      modelEndpoint:() => fail(401, 'No platform model fallback'),
      localKey, allowJointPlan, naceKey,
    });
  } catch (error) {
    return json({error:{message:error instanceof HttpError ? error.message : 'Model request failed'}},
      error instanceof HttpError ? error.status : 500);
  }
}

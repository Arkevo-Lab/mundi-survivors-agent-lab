const WORKER_PATH = '/survivors-research-simulation.worker.js';
let trustedURL;

function openSimulation() {
  if (globalThis.trustedTypes) {
    trustedURL ??= trustedTypes.createPolicy('arkena-runner', {
      createScriptURL(value) {
        if (value !== WORKER_PATH) throw new Error('非法研究 Worker 地址');
        return value;
      }
    }).createScriptURL(WORKER_PATH);
  }
  return new Worker(trustedURL ?? WORKER_PATH, {type: 'module', name: 'survivors-research'});
}

export function connectSimulation({onMessage = () => {}, onFailure = () => {}, createWorker = openSimulation} = {}) {
  const worker = createWorker();
  const pending = new Map();
  let serial = 0;
  let closed = false;
  function close(error = Error('研究 Worker 已关闭')) {
    if (closed) return;
    closed = true;
    worker.terminate();
    for (const request of pending.values()) request.reject(error);
  }
  function fail(message) {
    close(Error(message));
    onFailure(message);
  }
  worker.addEventListener('error', () => fail('研究 Worker 执行失败'));
  worker.addEventListener('messageerror', () => fail('无法读取研究 Worker 响应'));
  worker.addEventListener('message', ({data}) => {
    if (!data || typeof data !== 'object') return;
    if (data.request_id === undefined) {
      onMessage(data);
      return;
    }
    const request = pending.get(data.request_id);
    if (!request) return;
    if (data.run_id !== request.runId || data.type !== request.type) {
      request.reject(Error('研究 Worker 响应与请求不匹配'));
      return;
    }
    request.resolve(data);
  });
  return {close, request(type, runId, payload = {}, {signal, timeout = 10000} = {}) {
    if (closed) return Promise.reject(Error('研究 Worker 已关闭'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const id = 'web-' + ++serial;
      const timer = setTimeout(() => request.reject(Error(type + ' 响应超时')), timeout);
      const abort = () => request.reject(signal.reason);
      const finish = callback => value => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        pending.delete(id);
        callback(value);
      };
      const request = {type, runId, resolve: finish(resolve), reject: finish(reject)};
      pending.set(id, request);
      signal?.addEventListener('abort', abort, {once: true});
      try { worker.postMessage({...payload, type, request_id: id, run_id: runId}); }
      catch (error) { request.reject(error); }
    });
  }};
}

export function expectResponse(response) {
  if (response.error) throw Object.assign(Error(response.error.message), {code: response.error.code});
  return response;
}

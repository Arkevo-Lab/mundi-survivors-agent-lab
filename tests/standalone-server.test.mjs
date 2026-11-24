import assert from 'node:assert/strict';
import test from 'node:test';
import {once} from 'node:events';
import {createLabServer} from '../scripts/server.mjs';
import {handleLocalResearchAction, readModelText} from '../src/server/api.js';

async function withServer(fn, env = {}) {
  const server = createLabServer({env});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  try { await fn(origin); }
  finally { await new Promise(resolve => {server.close(resolve); server.closeAllConnections();}); }
}

test('clean standalone launch serves page and Worker without a model or account', async () => {
  let outbound = 0;
  await withServer(async origin => {
    for (const path of ['/?scenario=bat-crystal-bands-v1&release=R165', '/survivors-research.js', '/survivors-research-simulation.worker.js']) {
      const res = await fetch(origin + path);
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.ok(body.length > 100);
      if (path.startsWith('/?')) assert.ok(!body.includes('/#/games'));
    }
    const status = await fetch(origin + '/api/survivors-research/local-key').then(r => r.json());
    assert.deepEqual(status, {enabled:true, configured:false, nace_model:null});
    assert.equal((await fetch(origin + '/api/session')).status, 404);
    assert.equal((await fetch(origin + '/.env')).status, 404);
    assert.equal(outbound, 0);
  }, {MODEL_FETCH:async () => {outbound++; throw Error('Unexpected provider access');}});
});

test('local gateway rejects cross-origin calls and missing keys before reaching a provider', async () => {
  let outbound = 0;
  await withServer(async origin => {
    const route = origin + '/api/survivors-research/model/nace/action';
    const body = '{}';
    assert.equal((await fetch(route, {method:'POST', headers:{origin:'https://example.com'}, body})).status, 403);
    const res = await fetch(route, {method:'POST', headers:{origin, 'sec-fetch-site':'same-origin','x-mundi-local-connection':'1'}, body});
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'connection_unavailable');
    assert.equal(outbound, 0);
  }, {MODEL_FETCH:async () => {outbound++; throw Error('Unexpected provider access');}});
});

test('provider body reads have a byte limit and local adapter fails closed without credentials', async () => {
  await assert.rejects(() => readModelText(new Response('12345'), 4), /too large/);
  const res = await handleLocalResearchAction(new Request('http://localhost/api/survivors-research/model/action', {method:'POST',body:'{}'}));
  assert.equal(res.status, 401);
});

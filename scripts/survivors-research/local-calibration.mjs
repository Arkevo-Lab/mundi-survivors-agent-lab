import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {calibrateLink} from '../../src/client/survivors-research/models/compensation.js';

const exec = promisify(execFile);
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const loopbackProxy = /^http:\/\/(?:127\.0\.0\.1|localhost):[1-9]\d{0,4}$/;
let pending;

async function measure(label, service, route) {
  const {stdout} = await exec(process.execPath, ['scripts/survivors-research/link-probe.mjs', label, service, route, '6'],
    {timeout: 6500, maxBuffer: 16_384});
  return JSON.parse(stdout);
}

export function measureLocalResearchLink() {
  if (pending) return pending;
  const proxied = loopbackProxy.test(proxy ?? '');
  const current = measure(proxied ? '当前 OpenAI 代理' : '当前 OpenAI 直连', 'openai', proxied ? proxy : 'direct');
  const target = proxied ? measure('目标 Ark 直连（替代基线）', 'ark', 'direct')
    : current.then(report => ({...report, line_id: '目标 OpenAI 直连'}));
  pending = Promise.all([current, target]).then(([a, b]) => calibrateLink(a, b, {allowProxy: proxied}))
    .finally(() => { pending = undefined; });
  return pending;
}

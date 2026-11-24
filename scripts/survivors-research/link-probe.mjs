import {spawnSync} from 'node:child_process';
import {LINK_REPORT_SCHEMA} from '../../src/client/survivors-research/link-calibration-import.js';

const endpoints = {
  openai: 'https://api.openai.com/v1/models',
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
  ark: 'https://ark.cn-beijing.volces.com/api/v3/models',
};
const [lineId, service = 'openai', route = 'direct', sampleCount = '9'] = process.argv.slice(2);
const count = Number(sampleCount);
const loopbackProxy = /^http:\/\/(?:127\.0\.0\.1|localhost):([1-9]\d{0,4})$/.exec(route);
const routeAllowed = route === 'direct' || (loopbackProxy && Number(loopbackProxy[1]) <= 65535);
if (!lineId?.trim() || lineId.length > 120 || !Object.hasOwn(endpoints, service) ||
    !routeAllowed || !Number.isInteger(count) || count < 6 || count > 15) {
  process.stderr.write('Usage: node scripts/survivors-research/link-probe.mjs LINE_ID [openai|dashscope|ark] [direct|http://127.0.0.1:PORT] [6–15]\n');
  process.exit(2);
}
const endpoint = endpoints[service];
const proxy = route === 'direct' ? '' : route;
const args = ['--disable', '--silent', '--request', 'GET', '--proto', '=https', '--proxy', proxy, '--noproxy', '',
  '--connect-timeout', '3', '--max-time', '5', '--max-filesize', '65536',
  '--write-out', '%{exitcode}\t%{http_code}\t%{time_total}\t%{num_connects}\n'];
for (let i = 0; i < count; i++) args.push('--output', '/dev/null', endpoint);
const run = spawnSync('curl', args, {encoding: 'utf8', timeout: (count + 1) * 5500});
if (run.error) throw run.error;
const samples = run.stdout.trim().split('\n').filter(Boolean).map(line => {
  const [exit, status, seconds, connections] = line.split('\t').map(Number);
  return {ms: seconds * 1000, http_status: status,
    connection: exit === 0 ? connections === 0 ? 'reused' : 'new' : 'unknown',
    ...(exit !== 0 && {error: 'curl-exit-' + exit})};
});
if (samples.length !== count) throw Error('curl did not produce a measurement for each request; use curl 7.75 or later.');
process.stdout.write(JSON.stringify({schema: LINK_REPORT_SCHEMA, line_id: lineId.trim(), endpoint,
  measured_at: new Date().toISOString(), method: 'GET', metric: 'warm-https-total-ms', expected_http_status: 401, collector: 'curl-num-connects',
  route, samples}, null, 2) + '\n');

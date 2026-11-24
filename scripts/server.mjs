import http from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import {resolve, extname, sep} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {handleLocalResearchAction, readModelText} from '../src/server/api.js';
import {listResearchKeyModels} from '../src/server/survivors-research-model.js';
import {NACE_ACTION_PATH, NACE_MODEL} from '../src/client/survivors-research/models/nace-decisions.js';
import {measureLocalResearchLink} from './survivors-research/local-calibration.mjs';

const MIME = {'.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml'};
const responseJSON = (value, status = 200) => Response.json(value, {status, headers:{'Cache-Control':'no-store'}});
const validKey = key => typeof key === 'string' && /^[!-~]{20,256}$/.test(key);

export function createLabServer({env = {}, dist = resolve('dist')} = {}) {
  // Only keys explicitly supplied to this project are read. No home-directory or MUNDI files.
  const openaiKey = env.OPENAI_API_KEY ?? '';
  const naceKey = env.NACE_API_KEY ?? '';
  for (const key of [openaiKey, naceKey]) if (key && !validKey(key)) throw new Error('Invalid API key configuration');
  async function dispatch(request, expectedOrigin) {
    const url = new URL(request.url);
    if (url.origin !== expectedOrigin) return responseJSON({error:'Invalid host'}, 400);
    if (request.method === 'POST') {
      if (request.headers.get('origin') !== expectedOrigin || request.headers.get('sec-fetch-site') !== 'same-origin')
        return responseJSON({error:'Use the same-origin local research page'}, 403);
    }
    const path = url.pathname;
    if (path === '/health') return responseJSON({project:'mundi-survivors-agent-lab', snapshot:'R165', independent:true});
    if (path === '/api/survivors-research/local-key') {
      if (request.method === 'GET') return responseJSON({enabled:true, configured:Boolean(openaiKey), nace_model:naceKey ? NACE_MODEL : null});
      if (request.method === 'POST') {
        const key = request.headers.get('x-mundi-research-key') || openaiKey;
        if (!validKey(key)) return responseJSON({error:{message:'Configure your own OpenAI API key'}}, 400);
        return listResearchKeyModels(key, AbortSignal.any([request.signal, AbortSignal.timeout(10000)]), readModelText, env.MODEL_FETCH ?? fetch);
      }
    }
    if (request.method === 'POST' && path === '/api/survivors-research/measure-link')
      return responseJSON(await measureLocalResearchLink());
    if (request.method === 'POST' && [NACE_ACTION_PATH, '/api/survivors-research/model/action',
      '/api/survivors-research/model/decisions/action', '/api/survivors-research/model/strategy'].includes(path)) {
      const nace = path === NACE_ACTION_PATH;
      const key = nace ? naceKey : request.headers.get('x-mundi-research-key') || openaiKey;
      if (!validKey(key)) return responseJSON({error:{code:'connection_unavailable', message:nace ? 'Set NACE_API_KEY in this project .env' : 'Set OPENAI_API_KEY in this project .env'}}, 503);
      if (nace && (request.headers.get('x-mundi-local-connection') !== '1' || request.headers.has('x-mundi-research-key')))
        return responseJSON({error:{code:'connection_unavailable',message:'Use the explicit local Nace connection'}}, 403);
      return handleLocalResearchAction(request, {MODEL_FETCH:env.MODEL_FETCH}, nace ? undefined : key, nace ? {naceKey:key} : {});
    }
    if (path.startsWith('/api/')) return responseJSON({error:'This independent lab has no MUNDI account or platform API'}, 404);
    if (!['GET','HEAD'].includes(request.method)) return new Response(null, {status:405});
    const cleanPath = path === '/' ? '/survivors-research.html' : path;
    let file;
    try { file = resolve(dist, '.' + decodeURIComponent(cleanPath)); } catch { return new Response(null, {status:400}); }
    if (!file.startsWith(dist + sep)) return new Response(null, {status:403});
    try {
      if (!(await stat(file)).isFile()) return new Response(null, {status:404});
      return new Response(request.method === 'HEAD' ? null : await readFile(file), {headers:{
        'Content-Type':MIME[extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options':'nosniff',
        'Referrer-Policy':'no-referrer', 'Cache-Control':'no-store',
      }});
    } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return new Response(null, {status:404}); throw error; }
  }
  const server = http.createServer(async (req, res) => {
    try {
      const port = server.address().port;
      const host = req.headers.host;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)) {res.writeHead(400); res.end('Invalid host'); return;}
      const abort = new AbortController();
      res.once('close', () => {if (!res.writableFinished) abort.abort();});
      const origin = 'http://' + host;
      const request = new Request(origin + req.url, {method:req.method, headers:req.headers,
        body:['GET','HEAD'].includes(req.method) ? undefined : req, duplex:'half', signal:abort.signal});
      const result = await dispatch(request, origin);
      res.writeHead(result.status, Object.fromEntries(result.headers));
      if (!result.body || req.method === 'HEAD') {await result.body?.cancel(); res.end();}
      else await pipeline(Readable.fromWeb(result.body), res);
    } catch {
      // Never log requests, keys, raw prompts, or provider responses.
      if (res.headersSent) {res.destroy(); return;}
      res.writeHead(502, {'Content-Type':'application/json'});
      res.end('{"error":{"code":"connection_unavailable","message":"Local research request failed"}}');
    }
  });
  server.requestTimeout = 110000;
  server.headersTimeout = 10000;
  return server;
}

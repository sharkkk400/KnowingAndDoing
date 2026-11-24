import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createForecastArchive} from '../forecast-archive.mjs';
import {createResearchHandler} from '../research-api.mjs';
import {forecastMarkup} from '../dist/research-markup.js';

test('HTTP flow supports forecast validation and export with same-origin writes; event routes are removed', async () => {
  const dir = await mkdtemp(tmpdir() + '/gp-api-');
  const archive = createForecastArchive(pathToFileURL(dir + '/archive.json')); let checks = 0;
  const handler = createResearchHandler({archive,
    forecastCollector: {run: async () => {checks++;}, state: () => ({running: false})}});
  const server = http.createServer(async (req, res) => { if (!await handler(req, res, new URL(req.url, 'http://localhost'))) {res.writeHead(404); res.end();} });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const call = async (path, method = 'GET', input, headers = {}) => {
    const r = await fetch(origin + path, {method, headers: {'Content-Type': 'application/json', Origin: origin, ...headers}, body: input ? JSON.stringify(input) : undefined});
    const text = await r.text();
    return {status: r.status, headers: r.headers, data: text ? JSON.parse(text) : null};
  };
  try {
    for (const route of ['/api/events', '/api/event-topics', '/api/events/refresh']) {
      assert.equal((await call(route)).status, 404);
      assert.equal((await call(route, 'POST')).status, 404);
    }
    assert.equal((await call('/api/forecast-archive/run', 'POST', undefined, {Origin: 'https://elsewhere.example'})).status, 403);
    assert.equal(checks, 0);
    assert.equal((await call('/api/forecast-archive', 'DELETE')).status, 405);
    assert.equal((await call('/api/forecast-archive/run', 'POST')).status, 202); assert.equal(checks, 1);
    assert.equal((await call('/api/forecast-archive?symbol=invalid')).status, 400);
    assert.equal((await call('/api/forecast-archive?days=2')).status, 400);
    let r = await call('/api/forecast-archive'); assert.equal(r.data.total, 0); assert(r.data.definitions.some(d => d.symbol === 'market:A'));
    r = await call('/api/forecast-archive/export'); assert.match(r.headers.get('content-disposition'), /attachment/); assert.deepEqual(r.data.records, []);
    await archive.commit([{id:'old-stock',symbol:'sz002202',evaluations:[]}],new Map(),{
      closingPrices:[{symbol:'sz002202',close:10},{symbol:'sh510300',close:4}],
      errors:[{symbol:'sz002202',reason:'legacy'},{symbol:'sh510300',reason:'waiting'}]
    });
    r = await call('/api/forecast-archive'); assert.equal(r.data.total,0);
    r = await call('/api/forecast-archive/export'); assert.deepEqual(r.data.records,[]);
    assert.deepEqual(r.data.closingPrices.map(n=>n.symbol),['sh510300']);
    assert.deepEqual(r.data.errors.map(n=>n.symbol),['sh510300']);
    assert.equal((await call('/api/forecast-archive?symbol=sz002202')).status,400);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, {recursive: true, force: true}); }
});
test('archive cards escape untrusted fields', () => {
  const archive = forecastMarkup({id: '1', name: '<img>', signalDate: '2026-10-20', baselinePrice: 10, outlook: {title: '<script>', evidence: ['<img>'], conditions: [], actions: [{label: '<script>', text: '<img>'}]}, benchmark: {symbol: 'sh000300'}}, 3);
  assert(!archive.includes('<script>')); assert(!archive.includes('<img>')); assert.match(archive, /等待验证/);
});

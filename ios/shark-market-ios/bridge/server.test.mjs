import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {createBridge} from './server.mjs';

test('手机网关保护页面和接口，保留同源写入与JSON导出', async t => {
  let calls = 0;
  const upstream = http.createServer((req, res) => {
    calls++;
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers.origin, `http://127.0.0.1:${upstream.address().port}`);
    assert.equal(req.headers['sec-fetch-site'], 'same-origin');
    res.writeHead(200, {'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="archive.json"'});
    res.end(JSON.stringify({path: req.url, method: req.method}));
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const token = 'a'.repeat(64), authority = 'mobile.local:5179';
  const bridge = createBridge({token, authority, upstream: `http://127.0.0.1:${upstream.address().port}`}).listen(0, '127.0.0.1');
  await once(bridge, 'listening');
  t.after(() => {bridge.closeAllConnections();bridge.close();upstream.closeAllConnections();upstream.close();});
  const url = `http://127.0.0.1:${bridge.address().port}`;
  const call = (path, options = {}) => new Promise((resolve, reject) => {
    const request = http.request(url + path, {...options, headers: {Host: authority, ...options.headers}}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        resolve({status: response.statusCode, headers: {get: name => response.headers[name]?.toString()}, text: async () => body, json: async () => JSON.parse(body)});
      });
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal((await call('/')).status, 401);
  assert.equal((await call('/api/forecast-archive/export')).status, 401);
  assert.equal((await call('/', {headers: {Host: 'other.local', Authorization: `Bearer ${token}`}})).status, 403);
  assert.equal((await call('/', {headers: {Origin: 'https://evil.example', Authorization: `Bearer ${token}`}})).status, 403);
  assert.equal((await call('/', {headers: {'Sec-Fetch-Site': 'cross-site', Authorization: `Bearer ${token}`}})).status, 403);
  assert.equal(calls, 0);
  const login = await call('/', {headers: {Authorization: `Bearer ${token}`}});
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  await login.text();
  const result = await call('/api/forecast-archive/run', {method: 'POST', headers: {Cookie: `gp_session=${token}`, Origin: `http://${authority}`}});
  assert.deepEqual(await result.json(), {path: '/api/forecast-archive/run', method: 'POST'});
  const exported = await call('/api/forecast-archive/export', {headers: {Cookie: `gp_session=${token}`}});
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  assert.equal(calls, 3);
});

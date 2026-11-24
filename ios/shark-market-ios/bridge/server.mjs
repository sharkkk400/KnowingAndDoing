import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const equal = (a, b) => {
  const x = Buffer.from(a || ''), y = Buffer.from(b || '');
  return x.length === y.length && timingSafeEqual(x, y);
};

// A separate authenticated gateway leaves GP and its loopback-only controls unchanged.
export function createBridge({token, upstream = 'http://127.0.0.1:5178', authority}) {
  if (!token || !/^[A-Za-z0-9_-]{32,}$/.test(token) || !authority) throw Error('需要至少32字符的安全令牌和明确的手机访问地址');
  const target = new URL(upstream);
  if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))
    throw Error('上游必须是本机 GP 服务');
  return http.createServer((req, res) => {
    const reject = (status, text) => {res.writeHead(status, {'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(text);};
    if (req.headers.host !== authority) return reject(403, '服务器地址不匹配');
    if (req.headers.origin && req.headers.origin !== `http://${authority}`) return reject(403, '来源不匹配');
    if (req.headers['sec-fetch-site'] === 'cross-site') return reject(403, '不允许跨站访问');
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) return reject(405, '不支持此操作');
    const bearer = req.headers.authorization?.replace(/^Bearer /, '') || '';
    const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('gp_session='))?.slice(11) || '';
    const authorization = equal(bearer, token), authenticated = authorization || equal(cookie, token);
    if (!authenticated) return reject(401, '请在沙克知行录的服务器设置中填写正确的访问令牌');
    if (!req.url.startsWith('/') || req.url.startsWith('//')) return reject(400, '路径无效');
    const headers = {...req.headers, host: target.host, origin: target.origin};
    for (const key of ['authorization','cookie','connection','proxy-authorization','forwarded','x-forwarded-host','x-forwarded-for']) delete headers[key];
    headers['sec-fetch-site'] = 'same-origin';
    const proxy = http.request({hostname: target.hostname, port: target.port || 80, path: req.url, method: req.method, headers}, response => {
      const outgoing = {...response.headers, 'cache-control': 'no-store'};
      delete outgoing['set-cookie'];
      if (authorization) outgoing['set-cookie'] = `gp_session=${token}; HttpOnly; SameSite=Strict; Path=/`;
      res.writeHead(response.statusCode || 502, outgoing);
      response.pipe(res);
    });
    proxy.on('error', () => { if (!res.headersSent) reject(502, 'GP 后台未启动或暂时不可用'); else res.destroy(); });
    proxy.setTimeout(120000, () => proxy.destroy());
    req.on('aborted', () => proxy.destroy());
    req.pipe(proxy);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.GP_MOBILE_HOST;
  const port = Number(process.env.GP_MOBILE_PORT || 5179);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw Error('请明确设置 GP_MOBILE_HOST 和有效端口');
  const server = createBridge({token: process.env.GP_ACCESS_TOKEN, upstream: process.env.GP_UPSTREAM, authority: `${host}:${port}`});
  server.listen(port, host, () => console.log(`沙克知行录连接服务：http://${host}:${port}（需要访问令牌）`));
}

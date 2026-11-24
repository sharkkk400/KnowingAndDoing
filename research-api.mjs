import {forecastSummary} from './forecast-archive.mjs';
import {archiveDefs} from './forecast-collector.mjs';
const bounded = (value, fallback, max) => Math.min(max, Math.max(0, Number.isInteger(Number(value)) && value !== null ? Number(value) : fallback));
export function createResearchHandler({archive, forecastCollector}) {
  return async function handle(req, res, url) {
    const path = url.pathname;
    if (!/^\/api\/forecast-archive(?:\/|$)/.test(path)) return false;
    const send = (status, data, headers = {}) => { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers}); res.end(JSON.stringify(data)); };
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(req.headers.host || '')) {
      send(403, {error: '仅允许通过本机地址访问研究记录'}); return true;
    }
    const read = req.method === 'GET' || req.method === 'HEAD';
    if (!read && (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host))) {
      send(403, {error: '仅允许当前工作台提交修改'}); return true;
    }
    try {
      if ((path === '/api/forecast-archive' || path === '/api/forecast-archive/export') && read) {
        const s = await archive.read(), symbol = url.searchParams.get('symbol');
        if (symbol && !archiveDefs.some(d => d.symbol === symbol)) throw Error('无效留档标的');
        const records = s.records.filter(r => archiveDefs.some(d => d.symbol === r.symbol) && (!symbol || r.symbol === symbol));
        const allowed = new Set(archiveDefs.map(d => d.symbol));
        const view = {...s, errors: s.errors?.filter(r => !r.symbol || allowed.has(r.symbol)), closingPrices: s.closingPrices?.filter(r => allowed.has(r.symbol))};
        if (path.endsWith('/export')) send(200, {...view, records}, {'Content-Disposition': 'attachment; filename="gp-forecast-archive.json"'});
        else {
          const days = Number(url.searchParams.get('days') || 3); if (![1, 3, 5].includes(days)) throw Error('验证周期应为1、3或5个交易日');
          send(200, {...view, records: records.slice(0, bounded(url.searchParams.get('limit'), 20, 200)).map(({inputs, ...r}) => r),
            total: records.length, summary: forecastSummary(records, days), definitions: archiveDefs, collector: forecastCollector.state()});
        }
      } else if (path === '/api/forecast-archive/run' && req.method === 'POST') {
        void forecastCollector.run(); send(202, {message: '正在检查留档和验证；仅保存当天有效的收盘推演'});
      } else send(405, {error: '此地址不支持该操作'});
    } catch (error) { send(/存档读取失败/.test(error.message) ? 503 : 400, {error: error.message}); }
    return true;
  };
}

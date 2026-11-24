import {createForecastRecord, evaluateForecast, mergeClosingPrices, withClosingPrices} from './forecast-archive.mjs';
import {chinaDate} from './research-store.mjs';
import {instruments} from './dist/instruments.js';
import {getDaily, getBreadth} from './market-context.mjs';
import {getQuotes, getIntraday} from './market.mjs';
import {getFlow} from './flow.mjs';
import {getMacd} from './macd.mjs';
import {getShares} from './shares.mjs';
import {marketOutlook} from './dist/outlook.js';
import {etfOverview} from './dist/etf-overview.js';
import {groupStrength, macdDistribution} from './dist/etf-insights.js';
import {marketSummary} from './dist/market-analysis.js';

export const archiveDefs = [
  {symbol: 'market:A', name: 'A股整体', priceSymbol: 'sh000985'},
  ...instruments.filter(d => d.market !== 'HK' && !d.symbol.startsWith('bj'))
];
async function pool(items, fn, n = 3) {
  let cursor = 0;
  await Promise.all(Array.from({length: Math.min(n, items.length)}, async () => {
    while (cursor < items.length) { const item = items[cursor++]; await fn(item); }
  }));
}
const attempt = async (fn, fallback) => { try { return await fn(); } catch (error) { return {...fallback, stale: true, error: error.message}; } };
export function createForecastCollector(archive, services = {}) {
  const api = {getDaily, getQuotes, getIntraday, getFlow, getMacd, getShares, getBreadth, ...services};
  let pending, timer, lastState = {running: false, error: null};
  async function run(now) {
    if (pending) return pending;
    const clock = () => now ?? Date.now();
    lastState = {running: true, error: null};
    pending = (async () => {
      const saved = await archive.read(), today = chinaDate(clock()), dateTime = new Date(clock() + 8 * 3600000).toISOString();
      const existing = new Set(saved.records.map(r => r.id));
      const canRecord = dateTime.slice(11, 16) >= '15:10';
      const missing = canRecord ? archiveDefs.filter(d => !existing.has(d.symbol + '|' + today)) : [];
      if (!missing.length && !saved.records.length) return;
      const unfinished = saved.records.filter(r => archiveDefs.some(d => d.symbol === r.symbol) && ![1, 3, 5].every(days => r.evaluations?.some(e => e.days === days && e.status === 'complete')));
      if (!missing.length && !unfinished.length) return;
      const needed = [...new Set(['sh000300', 'sh000985', ...missing.map(d => d.priceSymbol || d.symbol),
        ...unfinished.flatMap(r => [r.priceSymbol, r.benchmark.symbol])])];
      const daily = new Map();
      await pool(needed, async symbol => daily.set(symbol, await attempt(() => api.getDaily(symbol), {bars: []})));
      const results = [], errors = [], entries = new Map(), macds = new Map();
      let quotes = new Map(), shareData, closingPrices = saved.closingPrices || [];
      if (missing.length) {
        const [quotePayload, shares] = await Promise.all([
          attempt(() => api.getQuotes(), {quotes: []}), attempt(() => api.getShares(), {items: []})]);
        quotes = new Map(quotePayload.quotes.map(q => [q.symbol, q])); shareData = shares;
        closingPrices = mergeClosingPrices(closingPrices, quotePayload.stale ? [] : quotePayload.quotes, clock());
        const single = missing.filter(d => d.symbol !== 'market:A');
        await pool(single, async def => {
          const q = quotes.get(def.symbol), raw = daily.get(def.symbol);
          const closing = withClosingPrices(raw, closingPrices.filter(r => r.symbol === def.symbol));
          if (quotePayload.stale || q?.quoteTime?.slice(0, 10) !== today || closing?.stale || closing?.bars?.at(-1)?.date !== today) {
            errors.push({symbol: def.symbol, reason: '今日收盘报价或日线未齐'}); return;
          }
          const [entry, macd] = await Promise.all([
            attempt(() => api.getIntraday(def.symbol), {points: []}), attempt(() => api.getMacd(def.symbol), {points: []})]);
          entries.set(def.symbol, entry); macds.set(def.symbol, macd);
          const relativeBenchmark = 'sh000985';
          const benchmarkSymbol = 'sh000300';
          const analysisDaily = raw;
          const input = {quote: q, entry, daily: closing, analysisDaily, macd,
            flow: api.getFlow(def.symbol), benchmark: quotes.get(relativeBenchmark), benchmarkSymbol,
            benchmarkDaily: daily.get(benchmarkSymbol), quoteStale: quotePayload.stale,
            shares: shareData.items?.find(r => r.symbol === def.symbol),
            shareError: !!(shareData.stale || shareData.error || shareData.sources?.[def.symbol.slice(0, 2)]?.error)};
          const record = createForecastRecord(def, input, clock());
          if (record) results.push(record); else errors.push({symbol: def.symbol, reason: '有效收盘推演尚未形成'});
        });
        if (missing.some(d => d.symbol === 'market:A')) {
          const breadth = await attempt(() => api.getBreadth(), {}), q = quotes.get('sh000985');
          const overview = etfOverview(instruments, entries, quotes);
          const whole = marketSummary({quote: q, entry: entries.get('sh000985'), breadth, quoteStale: quotePayload.stale});
          const projection = marketOutlook({overview, breadth, whole, groups: groupStrength(overview, instruments),
            distribution: macdDistribution(instruments, macds, overview), quotes, defs: instruments, macdData: macds,
            quoteStale: quotePayload.stale, now: clock()});
          const input = {quote: q, daily: withClosingPrices(daily.get('sh000985'), closingPrices.filter(r => r.symbol === 'sh000985')),
            benchmarkDaily: daily.get('sh000300'), benchmarkSymbol: 'sh000300',
            quoteStale: quotePayload.stale, marketEvidence: {breadth, distribution: macdDistribution(instruments, macds, overview),
              quotes: [...quotes.values()], overview: {date: overview.date, time: overview.time, count: overview.count, ready: overview.ready}}};
          const record = createForecastRecord(archiveDefs[0], input, clock(), projection);
          if (record) results.push(record); else errors.push({symbol: 'market:A', reason: '整体市场收盘依据未齐'});
        }
      }
      const evaluations = new Map();
      for (const r of [...unfinished, ...results]) evaluations.set(r.id,
        evaluateForecast(r, withClosingPrices(daily.get(r.priceSymbol), closingPrices.filter(p => p.symbol === r.priceSymbol)),
          daily.get('sh000300'), withClosingPrices(daily.get(r.benchmark.symbol), closingPrices.filter(p => p.symbol === r.benchmark.symbol)), clock())
          .map(e => r.evaluations?.find(old => old.days === e.days && old.status === 'complete') || e));
      await archive.commit(results, evaluations, {closingPrices, lastRunAt: new Date().toISOString(), errors});
    })().catch(error => { lastState.error = error.message; console.error('推演留档：' + error.message); })
      .finally(() => { lastState.running = false; pending = null; });
    return pending;
  }
  return {run, state: () => ({...lastState}), start() {
    void run(); timer = setInterval(() => void run(), 300000); timer.unref();
  }, stop() { clearInterval(timer); }};
}

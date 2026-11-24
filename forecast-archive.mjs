import {createResearchStore, chinaDate, validDate} from './research-store.mjs';
import {instrumentOutlook} from './dist/outlook.js';

export const FORECAST_RULE_VERSION = 'outlook-20261021-v3';
export const horizons = [1, 3, 5];
const price = n => Number.isFinite(n) && n > 0;
const closed = (bars, now) => (bars || []).filter(b => validDate(b.date) && price(b.close) &&
  Date.parse(b.date + 'T15:05:00+08:00') <= now).sort((a, b) => a.date.localeCompare(b.date));

// Independently observed closing quotes are real H/L/C data, never reconstructed minutes.
export function mergeClosingPrices(saved, quotes, now) {
  const today = chinaDate(now), time = new Date(now + 8 * 3600000).toISOString().slice(11, 16);
  const map = new Map(saved.map(r => [r.symbol + '|' + r.date, r]));
  if (time >= '15:10') for (const q of quotes) {
    if (!/^(sh|sz)\d{6}$/.test(q.symbol) || q.quoteTime?.slice(0, 10) !== today || q.quoteTime.slice(11, 16) < '15:00' ||
        !Number.isFinite(Date.parse(q.quoteTime)) || Date.parse(q.quoteTime) > now + 60000 ||
        ![q.price, q.high, q.low].every(price) || q.high < q.price || q.low > q.price) continue;
    const id = q.symbol + '|' + today;
    if (!map.has(id)) map.set(id, {symbol: q.symbol, date: today, close: q.price, high: q.high, low: q.low,
      quoteTime: q.quoteTime, observedAt: new Date(now).toISOString(), source: '腾讯实际收盘报价'});
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
}
export function withClosingPrices(raw, observed) {
  if (!observed.length) return raw;
  const map = new Map((raw?.stale ? [] : raw?.bars || []).map(b => [b.date, b]));
  for (const r of observed) if (!map.has(r.date)) map.set(r.date, r);
  return {...raw, bars: [...map.values()].sort((a, b) => a.date.localeCompare(b.date)), stale: false,
    source: (raw?.source ? raw.source + '；' : '') + '缺日使用独立保存的真实收盘报价', observedClosingFallback: true};
}

export function createForecastRecord(def, inputs, now = Date.now(), projection) {
  const today = chinaDate(now), clock = new Date(now + 8 * 3600000).toISOString().slice(11, 16);
  const {quote, daily, benchmarkDaily} = inputs;
  const bar = daily?.bars?.at(-1), base = benchmarkDaily?.bars?.find(b => b.date === today);
  if (quote?.symbol !== (def.priceSymbol || def.symbol) || clock < '15:10' || daily?.stale || benchmarkDaily?.stale || inputs.quoteStale || bar?.date !== today ||
      quote?.quoteTime?.slice(0, 10) !== today || quote.quoteTime.slice(11, 16) < '15:00' ||
      Date.parse(quote.quoteTime) > now + 60000 || !price(quote.price) || !price(bar.close) || !price(base?.close) ||
      Math.abs(quote.price / bar.close - 1) > .002) return null;
  const outlook = projection || instrumentOutlook({...inputs, daily: inputs.analysisDaily || daily, now});
  if (!outlook.ready || outlook.date !== today || outlook.time !== '15:00') return null;
  const cutoff = Date.parse(today + 'T15:00:00+08:00');
  return {
    id: def.symbol + '|' + today, symbol: def.symbol, name: def.name, signalDate: today,
    observedAt: new Date(now).toISOString(), ruleVersion: FORECAST_RULE_VERSION,
    baselinePrice: bar.close, priceSymbol: quote.symbol,
    benchmark: {symbol: inputs.benchmarkSymbol, close: base.close},
    outlook: structuredClone(outlook),
    inputs: structuredClone({quote, daily: {...daily, bars: daily.bars.slice(-65)}, analysisDaily: inputs.analysisDaily,
      entry: inputs.entry ? {...inputs.entry, points: inputs.entry.points?.slice(-1)} : undefined,
      flow: inputs.flow ? {...inputs.flow, samples: inputs.flow.samples?.filter(p => p.date === today && Date.parse(p.sourceTime) <= cutoff).slice(-31), alerts: undefined} : undefined,
      macd: inputs.macd ? {...inputs.macd, points: inputs.macd.points?.filter(p => p.confirmed && p.time.slice(0, 10) === today && Date.parse(p.time) <= cutoff).slice(-2)} : undefined,
      benchmark: inputs.benchmark, shares: inputs.shares ? {...inputs.shares, history: undefined} : undefined,
      shareError: inputs.shareError, marketEvidence: inputs.marketEvidence}),
    evaluations: []
  };
}

export function evaluateForecast(record, stock, calendar, benchmark, now = Date.now()) {
  const sessions = [...new Set(closed(calendar?.bars, now).map(b => b.date))];
  const origin = sessions.indexOf(record.signalDate), byDate = new Map(closed(stock?.bars, now).map(b => [b.date, b]));
  const byBase = new Map(closed(benchmark?.bars, now).map(b => [b.date, b]));
  const bias = record.outlook.bias, direction = bias === 'strong' || bias === 'repair' ? 1 : bias === 'weak' ? -1 : 0;
  return horizons.map(days => {
    const result = {days, status: 'pending', reason: '等待后续交易日收盘', direction, evaluatedAt: new Date(now).toISOString()};
    if (stock?.stale || calendar?.stale || benchmark?.stale) return {...result, status: 'blocked', reason: '验证行情来源异常，保留原始推演'};
    if (origin < 0) return {...result, status: 'blocked', reason: '交易日基准缺少留档当天，等待补齐'};
    const dates = sessions.slice(origin + 1, origin + 1 + days);
    if (dates.length < days) return result;
    if (!byDate.has(record.signalDate) || dates.some(d => !byDate.has(d) || !byBase.has(d)))
      return {...result, status: 'blocked', reason: '后续交易日数据缺失或停牌，未跳过缺日'};
    if (Math.abs(byDate.get(record.signalDate).close / record.baselinePrice - 1) > .00001 ||
        !byBase.has(record.signalDate) || Math.abs(byBase.get(record.signalDate).close / record.benchmark.close - 1) > .00001)
      return {...result, status: 'blocked', reason: '留档日价格已被来源修订，暂停跨口径比较'};
    const bars = dates.map(d => byDate.get(d));
    if (bars.some(b => !price(b.high) || !price(b.low) || b.low > b.close || b.high < b.close))
      return {...result, status: 'blocked', reason: '验证日高低价不完整'};
    const chain = [record.baselinePrice, ...bars.map(b => b.close)];
    if (chain.some((p, i) => i && Math.abs(p / chain[i - 1] - 1) > .25))
      return {...result, status: 'blocked', reason: '价格大幅跳变，需核实除权或价格口径'};
    const target = bars.at(-1), change = (target.close / record.baselinePrice - 1) * 100;
    const benchmarkChange = (byBase.get(target.date).close / record.benchmark.close - 1) * 100;
    const pressureTouched = price(record.outlook.pressure) ? bars.some(b => b.high >= record.outlook.pressure) : null;
    const supportTouched = price(record.outlook.support) ? bars.some(b => b.low <= record.outlook.support) : null;
    return {...result, status: 'complete', reason: '', targetDate: target.date, targetClose: target.close, change,
      benchmarkChange, excess: change - benchmarkChange,
      directionMatched: direction ? Math.sign(change) === direction : null,
      highChange: (Math.max(...bars.map(b => b.high)) / record.baselinePrice - 1) * 100,
      lowChange: (Math.min(...bars.map(b => b.low)) / record.baselinePrice - 1) * 100,
      pressureTouched, supportTouched,
      levelsNote: pressureTouched === null && supportTouched === null ? '本条推演未设置价格观察位' : pressureTouched && supportTouched ? '两侧观察价均触及，日线无法判断先后' :
        pressureTouched ? '触及转强观察价，其他条件未据此确认' : supportTouched ? '触及失效观察价，其他条件未据此确认' : '未触及所记录观察价'};
  });
}

export function forecastSummary(records, days = 3) {
  const completed = records.map(r => r.evaluations?.find(e => e.days === days)).filter(e => e?.status === 'complete');
  const directional = completed.filter(e => e.direction !== 0);
  return {days, total: records.length, completed: completed.length, directional: directional.length,
    matched: directional.filter(e => e.directionMatched).length,
    pending: records.filter(r => !r.evaluations?.some(e => e.days === days && e.status !== 'pending')).length,
    blocked: records.filter(r => r.evaluations?.some(e => e.days === days && e.status === 'blocked')).length};
}
export function createForecastArchive(file = new URL('./data/forecast-archive.json', import.meta.url)) {
  const store = createResearchStore(file, {version: 1, records: [], closingPrices: [], startedAt: new Date().toISOString(), lastRunAt: null, errors: []});
  return {
    read: () => store.read(),
    async commit(records, evaluations, state = {}) {
      return store.update(s => {
        const seen = new Set(s.records.map(r => r.id));
        // A refresh, a second collector, or a new rule version cannot rewrite an observed forecast.
        for (const r of records) if (!seen.has(r.id)) { s.records.push(structuredClone(r)); seen.add(r.id); }
        s.records = s.records.map(r => evaluations.has(r.id) ? {...r, evaluations: evaluations.get(r.id)} : r)
          .sort((a, b) => b.signalDate.localeCompare(a.signalDate) || a.symbol.localeCompare(b.symbol));
        return {...s, ...state};
      });
    }
  };
}

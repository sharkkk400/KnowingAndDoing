import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createForecastRecord, evaluateForecast, createForecastArchive, forecastSummary, mergeClosingPrices, withClosingPrices} from '../forecast-archive.mjs';

const dates = ['2026-10-16', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'];
const now = Date.parse('2026-10-16T16:00:00+08:00'), later = Date.parse('2026-10-23T16:00:00+08:00');
const def = {symbol: 'sz002202', name: '金风科技'};
const bar = (date, close) => ({date, close, high: close + .1, low: close - .1});
function fixture() {
  const daily = {bars: [bar(dates[0], 10)], source: '测试日线'}, benchmarkDaily = {bars: [bar(dates[0], 100)]};
  const quote = {symbol: def.symbol, price: 10, quoteTime: dates[0] + 'T15:00:00+08:00'};
  const projection = {ready: true, date: dates[0], time: '15:00', bias: 'strong', title: '原判断', summary: '等待验证',
    evidence: ['当时依据'], conditions: [{label: '转强', text: '原始条件'}], support: 9.5, pressure: 10.5};
  const input = {quote, daily, benchmarkDaily, benchmarkSymbol: 'sh000300'};
  return {input, projection, record: createForecastRecord(def, input, now, projection)};
}
function future() {
  return {stock: {bars: dates.map((d, i) => bar(d, 10 + i * .2))},
    calendar: {bars: dates.map(d => bar(d, 100))}, benchmark: {bars: dates.map((d, i) => bar(d, 100 + i))}};
}
test('closing records require same-day matched prices and never backfill an old forecast', () => {
  const f = fixture(); assert(f.record); assert.equal(f.record.observedAt, new Date(now).toISOString());
  assert.equal(createForecastRecord(def, f.input, now - 3600000, f.projection), null);
  assert.equal(createForecastRecord(def, f.input, now + 86400000, f.projection), null);
  assert.equal(createForecastRecord(def, {...f.input, quoteStale: true}, now, f.projection), null);
  assert.equal(createForecastRecord(def, {...f.input, quote: {...f.input.quote, price: 12}}, now, f.projection), null);
  assert.equal(createForecastRecord({...def, symbol: 'other'}, f.input, now, f.projection), null);
  assert.equal(createForecastRecord(def, {...f.input, daily: {...f.input.daily, stale: true}}, now, f.projection), null);
});
test('records copy original evidence so later UI or input changes cannot rewrite history', () => {
  const f = fixture(); f.projection.title = '之后判断'; f.input.daily.bars[0].close = 99;
  assert.equal(f.record.outlook.title, '原判断'); assert.equal(f.record.inputs.daily.bars[0].close, 10);
});
test('verification counts actual market sessions, not calendar days or future bars', () => {
  const f = fixture(), data = future();
  let results = evaluateForecast(f.record, data.stock, data.calendar, data.benchmark, Date.parse('2026-10-19T14:00:00+08:00'));
  assert.equal(results[0].status, 'pending');
  results = evaluateForecast(f.record, data.stock, data.calendar, data.benchmark, later);
  assert.equal(results[0].targetDate, '2026-10-19'); assert.equal(results[1].targetDate, '2026-10-21');
  assert.equal(results[2].targetDate, '2026-10-23');
  assert.ok(Math.abs(results[1].change - 6) < .00001); assert.equal(results[1].directionMatched, true);
  assert.ok(Math.abs(results[1].excess - 3) < .00001);
});
test('missing stock days, failed sources, and baseline revisions block rather than advance validation', () => {
  const f = fixture(), d = future(); d.stock.bars.splice(1, 1);
  assert.equal(evaluateForecast(f.record, d.stock, d.calendar, d.benchmark, later)[0].status, 'blocked');
  assert.equal(evaluateForecast(f.record, {...d.stock, stale: true}, d.calendar, d.benchmark, later)[0].status, 'blocked');
  const revised = future(); revised.stock.bars[0].close = 9.9;
  assert.match(evaluateForecast(f.record, revised.stock, revised.calendar, revised.benchmark, later)[0].reason, /修订/);
});
test('touching both levels retains ambiguity; mixed outlooks are excluded from directional counts', () => {
  const f = fixture(), d = future(); d.stock.bars[1] = {...d.stock.bars[1], high: 11, low: 9};
  const e = evaluateForecast(f.record, d.stock, d.calendar, d.benchmark, later);
  assert.equal(e[0].pressureTouched, true); assert.equal(e[0].supportTouched, true); assert.match(e[0].levelsNote, /无法判断先后/);
  f.record.outlook.bias = 'mixed'; const mixed = evaluateForecast(f.record, d.stock, d.calendar, d.benchmark, later);
  assert.equal(mixed[0].directionMatched, null);
  const s = forecastSummary([{...f.record, evaluations: e}, {...f.record, evaluations: mixed}], 1);
  assert.equal(s.completed, 2); assert.equal(s.directional, 1); assert.equal(s.matched, 1);
});
test('large price discontinuities are not scored as an ordinary forecast outcome', () => {
  const f = fixture(), d = future(); d.stock.bars[1] = bar(dates[1], 5);
  assert.match(evaluateForecast(f.record, d.stock, d.calendar, d.benchmark, later)[0].reason, /大幅跳变/);
});
test('concurrent refreshes and restart preserve the first forecast and the full stored inputs', async () => {
  const dir = await mkdtemp(tmpdir() + '/gp-archive-'), file = pathToFileURL(dir + '/archive.json');
  try {
    const a = createForecastArchive(file), original = fixture().record, changed = {...original, outlook: {...original.outlook, title: '被修改的判断'}};
    await Promise.all([a.commit([original], new Map()), a.commit([changed], new Map())]);
    const saved = await createForecastArchive(file).read();
    assert.equal(saved.records.length, 1); assert.equal(saved.records[0].outlook.title, '原判断');
    assert.equal(saved.records[0].inputs.daily.bars[0].close, 10);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
test('a corrupt archive is reported and never silently overwritten', async () => {
  const dir = await mkdtemp(tmpdir() + '/gp-corrupt-'), file = pathToFileURL(dir + '/archive.json');
  try {
    await writeFile(file, '{bad'); const archive = createForecastArchive(file);
    await assert.rejects(archive.commit([fixture().record], new Map()), /存档读取失败/);
    assert.equal(await readFile(file, 'utf8'), '{bad');
  } finally { await rm(dir, {recursive: true, force: true}); }
});
test('independent closing observations only keep actually observed dates and cannot bridge missing sessions', () => {
  const q = {symbol: 'sz002202', price: 10, high: 10.2, low: 9.8, quoteTime: dates[0] + 'T15:10:00+08:00'};
  let prices = mergeClosingPrices([], [q, {...q, symbol: 'sh510300', quoteTime: '2026-10-15T15:00:00+08:00'}], now);
  assert.equal(prices.length, 1);
  prices = mergeClosingPrices(prices, [{...q, price: 10.1}], now + 60000); assert.equal(prices[0].close, 10);
  assert.equal(mergeClosingPrices([], [q], now - 3600000).length, 0);
  const next = {...q, price: 10.6, high: 10.8, low: 10.4, quoteTime: dates[3] + 'T15:00:00+08:00'};
  prices = mergeClosingPrices(prices, [next], Date.parse(dates[3] + 'T16:00:00+08:00'));
  const data = withClosingPrices({bars: [], stale: true}, prices), d = future();
  assert.equal(data.bars.length, 2); assert.equal(data.bars[0].source, '腾讯实际收盘报价');
  assert.equal(evaluateForecast(fixture().record, data, d.calendar, d.benchmark, later)[1].status, 'blocked');
});

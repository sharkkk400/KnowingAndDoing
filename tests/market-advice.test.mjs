import test from 'node:test';
import assert from 'node:assert/strict';
import {marketOutlook} from '../dist/outlook.js';

const date = '2026-10-21';
const now = Date.parse(date + 'T16:00:00+08:00');
function market() {
  return {
    overview: {ready: true, date, time: '15:00', count: 10, up: 8, down: 2, units: Array.from({length: 10}, () => ({}))},
    whole: {ready: true, date, time: '15:00', aligned: true, change: .8},
    breadth: {usable: true, date, timeTo: '15:00:00', upRatio: .7},
    distribution: {ready: true, date, time: '15:00', units: 10, bullish: 8, bullishChange: 1},
    groups: [
      {ready: true, name: '半导体', category: '行业轮动', change: 2, rankChange: 2},
      {ready: true, name: '医药', category: '行业轮动', change: .8, rankChange: 0},
      {ready: true, name: '地产', category: '行业轮动', change: -1.5, rankChange: -2}
    ],
    now
  };
}

test('broad strength offers conditional participation with measured evidence and one combined plan', () => {
  const r = marketOutlook(market());
  assert.equal(r.bias, 'repair');
  assert.equal(r.regime, 'broad_repair');
  assert.match(r.summary, /上涨个股 70\.0%/);
  assert.match(r.summary, /ETF方向 8\/10 上涨、2\/10 下跌/);
  assert.match(r.summary, /15分钟偏多 80%/);
  assert.deepEqual(r.actions.map(a => a.label), ['当前建议']);
  assert.match(r.actions[0].text, /回踩守住支撑/);
  assert.equal(r.probability, undefined);
});

test('even one lost bullish direction prevents broad participation while breadth remains strong', () => {
  for (const change of [-1, -2]) {
    const f = market(); f.distribution.bullishChange = change;
    const r = marketOutlook(f);
    assert.equal(r.regime, 'cooling');
    assert.equal(r.bias, 'mixed');
    assert.match(r.actions[0].text, /不再下降/);
    assert.match(r.summary, new RegExp('减少' + Math.abs(change) + '个方向'));
  }
});

test('a rising index with weak stock breadth does not invite index-led buying', () => {
  const f = market();
  f.breadth.upRatio = .3; f.overview.up = 4; f.overview.down = 6;
  const r = marketOutlook(f);
  assert.equal(r.regime, 'index_divergence');
  assert.equal(r.bias, 'mixed');
  assert.match(r.summary, /中证全指 \+0\.80%/);
  assert.match(r.summary, /上涨个股 30\.0%/);
  assert.match(r.actions[0].text, /上涨占比回到40%以上/);
  assert.match(r.actions[0].text, /逆市下跌/);
});

test('broad selling takes priority over a single strong sector and does not recommend bottom fishing', () => {
  const f = market();
  f.whole.change = -1.2; f.breadth.upRatio = .3; f.overview.up = 2; f.overview.down = 8;
  const r = marketOutlook(f);
  assert.equal(r.regime, 'defensive');
  assert.equal(r.bias, 'weak');
  assert.match(r.actions[0].text, /等待上涨占比/);
  assert.match(r.actions[0].text, /跌破支撑/);
  assert.match(r.actions[0].text, /暂停加仓/);
});

test('missing breadth and missing momentum remain different limitations instead of rotation signals', () => {
  const noBreadth = market(); noBreadth.whole.aligned = false;
  const b = marketOutlook(noBreadth);
  assert.equal(b.regime, 'breadth_missing');
  assert.equal(b.bias, 'limited');
  assert.ok(b.missing.includes('全市场广度待对齐'));
  assert.match(b.actions[0].text, /涨跌家数补齐/);
  const noMomentum = market(); noMomentum.distribution.ready = false;
  const m = marketOutlook(noMomentum);
  assert.equal(m.regime, 'momentum_missing');
  assert.equal(m.bias, 'limited');
  assert.ok(m.missing.includes('全体MACD覆盖不足'));
  assert.match(m.actions[0].text, /15分钟动能/);
  const badBreadth = market(); badBreadth.breadth.upRatio = 1.2;
  assert.equal(marketOutlook(badBreadth).regime, 'breadth_missing');
});

test('industry rotation identifies observed leaders and laggards without treating rank as a buy trigger', () => {
  const f = market(); f.breadth.upRatio = .5; f.overview.up = 5; f.overview.down = 5;
  f.groups.push(
    {ready: false, name: '缺数据行业', category: '行业轮动', change: 10},
    {ready: true, name: '宽基', category: '大小盘与风格', change: 20}
  );
  const r = marketOutlook(f);
  assert.equal(r.regime, 'rotation');
  assert.match(r.leadership, /当日较强.*半导体.*15分钟排名上升2位/);
  assert.doesNotMatch(r.leadership, /缺数据行业|宽基/);
  assert.match(r.actions[0].text, /支撑附近止跌并重新转强/);
  assert.match(r.actions[0].text, /地产/);
  assert.match(r.actions[0].text, /标的自身破位或反弹失败/);
});

test('closing fallback counts duplicated ETF exposures once and lists each industry once', () => {
  const defs = Array.from({length: 6}, (_, i) => ({
    symbol: 'etf' + i, sector: '行业 ETF', market: 'A', category: '行业轮动',
    exposure: i < 4 ? 'same-index' : 'index-' + i, group: i < 4 ? '半导体' : '行业' + i
  }));
  const quotes = new Map(defs.map((d, i) => [d.symbol, {price: i < 4 ? 102 : 99, prev: 100, quoteTime: date + 'T15:05:00+08:00'}]));
  quotes.set('sh000985', {price: 101, prev: 100, quoteTime: date + 'T15:05:00+08:00'});
  const f = market();
  const r = marketOutlook({...f, overview: {ready: false}, whole: {ready: false}, breadth: {...f.breadth, upRatio: .5},
    distribution: {...f.distribution, units: 3, bullish: 2}, defs, quotes});
  assert.equal(r.ready, true);
  assert.equal(r.count, 6);
  assert.equal(r.directionCount, 3);
  assert.match(r.summary, /ETF方向 1\/3 上涨、2\/3 下跌/);
  assert.equal(r.leadership.match(/半导体/g)?.length, 1);
  assert.ok(r.missing.some(s => s.includes('基于收盘报价')));
});

test('future, old and wrong-date MACD cannot confirm participation but a recent completed bar can', () => {
  for (const distribution of [
    {time: '15:15'},
    {time: '14:30'},
    {date: '2026-10-20'},
    {date: '2026-10-22'},
    {time: undefined}
  ]) {
    const f = market(); Object.assign(f.distribution, distribution);
    const r = marketOutlook(f);
    assert.equal(r.regime, 'momentum_missing');
    assert.equal(r.bias, 'limited');
    assert.ok(r.missing.includes('全体MACD覆盖不足'));
  }
  const f = market(); f.distribution.time = '14:45';
  assert.equal(marketOutlook(f).regime, 'broad_repair');
});

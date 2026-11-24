import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createForecastArchive} from '../forecast-archive.mjs';
import {createForecastCollector, archiveDefs} from '../forecast-collector.mjs';
import {instruments} from '../dist/instruments.js';

test('background collection freezes the same shared outlook rules and verifies on later actual sessions', async () => {
  const dir = await mkdtemp(tmpdir() + '/gp-collector-'), archive = createForecastArchive(pathToFileURL(dir + '/archive.json'));
  let current = '2026-10-20', broken = false;
  const services = {
    getDaily: async symbol => ({bars: Array.from({length: 70}, (_, i) => ({date: new Date(Date.parse(symbol === 'sh000985' ? '2016-06-13' : current) - (69 - i) * 86400000).toISOString().slice(0, 10), close: 10 + i * .01, high: 10.2 + i * .01, low: 9.8 + i * .01, volume: 10000})), stale: broken, source: '注入的测试数据'}),
    getQuotes: async () => ({quotes: instruments.map(d => ({...d, price: 10.69, prev: 10.6, low: 10.49, high: 10.89, amount: 100000, volumeHands: 100,
      changePct: .85, quoteTime: current + 'T15:10:00+08:00'}))}),
    getIntraday: async () => ({date: current, points: [{time: '15:00', price: 10.69, volumeHands: 100, amount: 100000}]}),
    getFlow: () => ({samples: [], stale: true}), getShares: async () => ({items: []}),
    getBreadth: async () => ({date: current, timeTo: '15:00:00', usable: true, upRatio: .8, up: 4000, down: 1000, flat: 0}),
    getMacd: async () => ({points: ['14:45', '15:00'].map((t, i) => ({time: current + 'T' + t + ':00+08:00', confirmed: true, dif: .3 + i * .1, dea: .1, histogram: .2 + i * .1}))})
  };
  try {
    const collector = createForecastCollector(archive, services);
    await collector.run(Date.parse(current + 'T14:00:00+08:00')); assert.equal((await archive.read()).records.length, 0);
    await collector.run(Date.parse(current + 'T16:00:00+08:00'));
    let saved = await archive.read(); assert.equal(collector.state().error, null);
    assert.equal(saved.records.length, archiveDefs.length); assert(saved.records.some(r => r.symbol === 'market:A'));
    assert.equal(saved.records.find(r => r.symbol === 'sh000985').outlook.bias, 'limited');
    assert.equal(saved.records.find(r => r.symbol === 'market:A').baselinePrice, 10.69);
    assert.equal(saved.closingPrices.length, instruments.filter(d => /^(sh|sz)/.test(d.symbol)).length);
    const original = saved.records.find(r => r.symbol === 'sh510300'); assert.equal(original.outlook.bias, 'strong');
    await collector.run(Date.parse(current + 'T17:00:00+08:00'));
    saved = await archive.read(); assert.equal(saved.records.find(r => r.id === original.id).observedAt, original.observedAt);
    broken = true; current = '2026-10-21'; await collector.run(Date.parse(current + 'T16:00:00+08:00'));
    saved = await archive.read(); assert.equal(saved.records.length, archiveDefs.length); assert(saved.errors.length > 0);
    assert.equal(saved.records.find(r => r.id === original.id).evaluations[0].status, 'blocked');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

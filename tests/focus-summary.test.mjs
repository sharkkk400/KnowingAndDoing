import test from 'node:test';
import assert from 'node:assert/strict';
import {focusSummary} from '../dist/focus-summary.js';
const o={ready:true,date:'2026-10-09',time:'10:15',trend:'走势分化',alerts:[{symbol:'a',name:'A',strength:2,reasons:[{type:'relative',value:-3}]},{symbol:'b',name:'B',strength:4,reasons:[{type:'move',value:2}]},{symbol:'c',name:'C',strength:1,reasons:[{type:'volume',value:3}]}]};
const now=Date.parse('2026-10-09T10:16:00+08:00');
test('focus ranks observed anomalies, limits to two and labels historical/paused snapshots',()=>{
 const f=focusSummary({overview:o,now});assert.deepEqual(f.targets.map(n=>n.symbol),['b','a']);assert.match(f.status,/近期/);assert.match(f.body,/弱于/);
 assert.match(focusSummary({overview:o,now:now+86400000}).status,/历史/);
 assert.equal(focusSummary({overview:o,now,paused:true}).status,'已暂停');
});
test('failed or insufficient sources suppress named targets, no anomalies is a valid result',()=>{
 assert.equal(focusSummary({overview:o,quoteStale:true,now}).targets.length,0);
 assert.equal(focusSummary({overview:{ready:false,reason:'不足'},now}).targets.length,0);
 assert.match(focusSummary({overview:{...o,alerts:[]},now}).title,/等待/);
});
test('daily evidence uses explicit date, never treats a candidate as a triggered buy',()=>{
 const daily={ready:true,date:o.date,marketOK:false,qualified:0};
 assert.match(focusSummary({overview:o,now,daily}).body,/暂观察/);
 assert.equal(focusSummary({overview:o,now,daily:{...daily,date:'2026-10-12'}}).dailyDate,null);
});

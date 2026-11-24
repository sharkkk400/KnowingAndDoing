import {test} from 'node:test';
import assert from 'node:assert/strict';
import {volumePoints} from '../dist/price-volume.js';
test('cumulative deltas, direction and gaps do not fabricate minute volume',()=>{
 const p=(time,price,volumeHands,amount)=>({time,price,volumeHands,amount});
 const r=volumePoints([p('09:30',10,100,100000),p('09:31',11,150,155000),p('09:33',9,200,200000),p('09:34',9,210,null),p('11:30',9,300,280000),p('13:00',9,400,370000),p('13:01',8,390,360000)]);
 assert.equal(r[0].volume,null);assert.equal(r[1].volume,50);assert.equal(r[1].turnover,55000);assert.equal(r[1].direction,1);assert.equal(r[2].volume,null);assert.equal(r[3].direction,0);assert.equal(r[3].turnover,null);assert.equal(r[5].volume,null);assert.equal(r[6].volume,null);
});

import {analyzeVolume} from '../dist/price-volume.js';
test('volume baseline excludes current minute and resets on discontinuities',()=>{
 let volume=0;
 const points=Array.from({length:8},(_,i)=>({time:`10:0${i}`,price:10+i*.01,volumeHands:volume+=i===6?400:i===7?20:100,amount:volume*1000}));
 const a=analyzeVolume(points);assert.equal(a[5].volumeRatio,null);assert.equal(a[6].volumeRatio,4);assert.equal(a[6].label,'放量上涨');assert.equal(a[7].volumeRatio,.2);assert.equal(a[7].label,'缩量上涨');
 points[6].time='10:20';assert.equal(analyzeVolume(points)[6].volumeRatio,null);
 const zero=analyzeVolume(Array.from({length:7},(_,i)=>({time:`10:0${i}`,price:10,volumeHands:i===6?100:0,amount:0})));assert.equal(zero[6].volumeRatio,null);assert.equal(zero[6].label,'近期成交量基线为零');
});

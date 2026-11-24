import test from 'node:test';
import assert from 'node:assert/strict';
import {parseSinaIntraday,createCache} from '../market.mjs';
const wrap=rows=>'/* comment */ var k=('+JSON.stringify(rows)+');';
const bar=(day,close,volume,amount)=>({day,close,volume,amount});
test('备用分钟线按最新交易日累加真实量额，保留缺口并去重',()=>{
 const r=parseSinaIntraday(wrap([bar('2026-10-12 09:31:00',9,999,999),bar('2026-10-13 09:31:00',10,100,1000),bar('2026-10-13 09:32:00',11,200,2200),bar('2026-10-13 09:32:00',11,200,2200),bar('2026-10-13 13:01:00',12,300,3600)]),'sz002202');
 assert.equal(r.date,'2026-10-13');assert.equal(r.points.length,3);assert.equal(r.points.at(-1).volumeHands,6);assert.equal(r.points.at(-1).amount,6800);assert.equal(r.points.at(-1).time,'13:01');assert.equal(r.fallback,true);
});
test('拒绝拦截网页、缺少量额和缺失开盘的分钟线',()=>{
 for(const s of ['<html>blocked</html>',wrap([bar('2026-10-13 10:00:00',10,100,1000)]),wrap([{day:'2026-10-13 09:31:00',close:10,volume:100}])])assert.throws(()=>parseSinaIntraday(s,'sz002202'));
});
test('缓存保留备用来源，失败时显式标记旧数据',async()=>{
 const cached=createCache(-1);const a=await cached('x',async()=>({source:'新浪1分钟K线（备用）',points:[1]}));assert.equal(a.source,'新浪1分钟K线（备用）');const b=await cached('x',async()=>{throw Error();});assert.equal(b.stale,true);assert.deepEqual(b.points,[1]);
});

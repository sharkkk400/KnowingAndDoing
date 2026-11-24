import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {trackCandidate,reconcileTracking,createTrackingStore} from '../candidate-tracking.mjs';
const base=Array.from({length:80},(_,i)=>({date:new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10),close:10+i*.01,high:11+i*.01,low:9+i*.01}));
const date=i=>base[i].date;
const seed={id:'a|'+date(65),symbol:'a',name:'A',exposure:'a',signalDate:date(65),observedAt:'2026-03-10T00:00:00Z',resistance:10,invalidation:9,initialBreakout:false};
function fixture(tail){const bars=base.slice(0,66).map(r=>({...r,close:9.9,high:10,low:9.8}));tail.forEach((r,i)=>bars.push({date:date(66+i),close:10.1,high:10.2,low:10.05,...r}));return {stock:{bars},benchmark:{bars:base.slice(0,bars.length)}};}
test('breakout, retest and confirmation require separate completed trading days',()=>{
 const {stock,benchmark}=fixture([{low:9.99},{low:10,high:10.25},{close:10.3,high:10.4}]);
 const r=trackCandidate(seed,stock,benchmark);assert.equal(r.stage,'confirmed');assert.equal(r.confirmedAt,date(68));assert.deepEqual(r.events.map(e=>e.stage),['breakout','retest','confirmation','confirmed']);
 assert.equal(trackCandidate(seed,{bars:stock.bars.slice(0,-1)},{bars:benchmark.bars.slice(0,-1)}).stage,'confirmation');
});
test('invalidation wins ambiguous daily bars; close below breakout resets retest',()=>{
 let f=fixture([{low:8.9,high:11,close:10.2}]);assert.equal(trackCandidate(seed,f.stock,f.benchmark).stage,'invalid');
 f=fixture([{}, {low:9.9,close:9.95},{}]);assert.deepEqual(trackCandidate(seed,f.stock,f.benchmark).events.map(e=>e.stage),['breakout','retest','breakout','retest']);
});
test('missing days and failed sources cannot advance; weak market cannot confirm',()=>{
 let f=fixture([{},{}]);f.stock.bars.splice(66,1);assert.match(trackCandidate(seed,f.stock,f.benchmark).blocked,/缺失/);
 assert.match(trackCandidate(seed,{...f.stock,stale:true},f.benchmark).blocked,/异常/);
 f=fixture([{}]);f.benchmark.bars.at(-1).close=5;assert.equal(trackCandidate(seed,f.stock,f.benchmark).stage,'breakout');
});
test('ten trading days end the fixed plan, regardless of calendar spacing',()=>{
 const f=fixture(Array.from({length:12},()=>({close:9.95,high:10,low:9.9})));const r=trackCandidate(seed,f.stock,f.benchmark);assert.equal(r.stage,'expired');assert.equal(r.age,10);assert.equal(r.terminal,true);
});
test('rescreening and reload preserve original levels and do not duplicate events',async()=>{
 const folder=await mkdtemp(tmpdir()+'/gp-tracking-'),file=pathToFileURL(folder+'/tracking.json');
 try{
  const f=fixture([]),data=new Map([['a',f.stock],['sh000300',f.benchmark]]);
  const result={ready:true,date:seed.signalDate,rows:[{...seed,close:9.9,status:'等待突破确认'}]};
  const store=createTrackingStore(file);const a=await store(result,data);const b=await createTrackingStore(file)(result,data);assert.deepEqual(a,b);
  const next=reconcileTracking(JSON.parse(await readFile(file,'utf8')),{...result,date:date(66),rows:[{...result.rows[0],resistance:20}]},data);
  assert.equal(next.records.length,1);assert.equal(next.records[0].resistance,10);
  const stale=reconcileTracking({records:next.records,items:[{...next.items[0],stage:'confirmed',asOf:date(68)}]},{ready:false},new Map([['a',{stale:true}],['sh000300',f.benchmark]]));
  assert.equal(stale.items[0].stage,'confirmed');assert.equal(stale.items[0].status,'跟踪待更新');
 }finally{await rm(folder,{recursive:true,force:true});}
});

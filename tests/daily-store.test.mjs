import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeDaily,dailyCoverage} from '../daily-store.mjs';
const dates=Array.from({length:30},(_,i)=>new Date(Date.UTC(2026,7,i+1)).toISOString().slice(0,10));
const bars=dates.map(date=>({date,close:10,high:11,low:9}));
test('daily archive merges revisions without duplicate dates or forming candles',()=>{
 const now=Date.parse('2026-08-30T14:00:00+08:00');
 const result=mergeDaily(bars.slice(0,20),[...bars,{...bars[0],close:10.5}],now);
 assert.equal(result.length,29);assert.equal(result[0].close,10.5);assert.equal(result.at(-1).date,'2026-08-29');
 assert.throws(()=>mergeDaily([],[{...bars[0],close:0}],now));
});
test('30-session coverage detects interior gaps and stale final dates',()=>{
 assert.equal(dailyCoverage(bars,dates).complete,true);
 const r=dailyCoverage(bars.filter((_,i)=>i!==10),dates);assert.equal(r.count,29);assert.deepEqual(r.missing,[dates[10]]);assert.equal(r.complete,false);
 assert.equal(dailyCoverage(bars.slice(0,-1),dates).complete,false);
 assert.equal(dailyCoverage([],[]).complete,false);
});

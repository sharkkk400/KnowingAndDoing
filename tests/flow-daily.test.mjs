import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseDailyFlow,alignDailyFlow} from '../flow-daily.mjs';
const payload=klines=>({rc:0,data:{code:'002202',klines}});
test('daily flow excludes forming day, maps categories and validates source',()=>{
 const rows=parseDailyFlow(payload(['2026-10-09,30,-10,-20,10,20','2026-10-12,40,-20,-20,15,25']),'sz002202',Date.parse('2026-10-12T10:00:00+08:00'));
 assert.equal(rows.length,1);assert.equal(rows[0].main,30);assert.equal(rows[0].large,10);assert.equal(rows[0].small,-10);
 assert.throws(()=>parseDailyFlow(payload(['2026-10-09,999,-10,-20,10,20']),'sz002202'));
 assert.throws(()=>parseDailyFlow(payload(['2026-10-09,30,,-20,10,20']),'sz002202'));
 assert.throws(()=>parseDailyFlow(payload(['2026-02-30,30,-10,-20,10,20']),'sz002202'));
 assert.throws(()=>parseDailyFlow(payload(['2026-10-09,30,-10,-20,10,20']),'sh600519'));
});
test('aligns to closed trading dates without filling missing days or using older substitutes',()=>{
 const rows=[{date:'2026-10-08',main:20},{date:'2026-10-12',main:30}],daily={bars:[{date:'2026-10-08'},{date:'2026-10-09'}]};
 const result=alignDailyFlow(rows,daily);assert.equal(result.count,1);assert.equal(result.total,2);assert.deepEqual(result.rows[1],{date:'2026-10-09',missing:true});
 assert.throws(()=>alignDailyFlow(rows,{...daily,stale:true}));
});

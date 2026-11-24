import test from 'node:test';
import assert from 'node:assert/strict';
import {opportunityPriority} from '../dist/opportunity-priority.js';

const date='2026-10-21';
const row=(symbol,extra={})=>({symbol,name:symbol,exposure:symbol,close:11,resistance:10.5,invalidation:9,rs5:2,rs20:4,status:'等待回踩确认',...extra});
const plan=(symbol,stage,extra={})=>({id:symbol+'|2026-10-19',symbol,name:symbol,exposure:symbol,signalDate:'2026-10-19',asOf:date,resistance:10,invalidation:8.5,stage,terminal:false,blocked:null,gate:null,...extra});
const daily=(rows,items=[],extra={})=>({ready:true,date,marketOK:true,rows,tracking:{items},...extra});

test('confirmed closed-day progress outranks relative strength, with all eligible directions included',()=>{
 const rows=[row('breakout',{close:10}),row('retest',{rs5:30,rs20:40}),row('confirmation'),row('confirmed',{rs5:1,rs20:1})];
 const states=['breakout','retest','confirmation','confirmed'];
 const r=opportunityPriority(daily(rows.slice(0,3),states.map(s=>plan(s,s)),{priorityRows:rows}));
 assert.deepEqual(r.items.map(i=>i.stage),['confirmed','confirmation','retest','breakout']);
 assert.equal(r.items[0].waiting,false);
 assert.equal(r.items[0].planId,'confirmed|2026-10-19');
 assert.equal(r.items[0].resistance,10);
 assert.equal(r.items[0].invalidation,8.5);
 assert.equal(r.items[0].close,11);
 assert.equal(r.items[0].signalDate,'2026-10-19');
});

test('a daily touch cannot become a confirmed plan, and a closing breakout still waits for a later retest',()=>{
 const rows=[row('touch',{close:10.5,high:11}),row('close-above')];
 const r=opportunityPriority(daily(rows));
 assert.equal(r.items.find(i=>i.symbol==='touch').stage,'breakout');
 assert.equal(r.items.find(i=>i.symbol==='close-above').stage,'retest');
 assert.ok(r.items.every(i=>i.waiting&&i.planId===null&&i.priority<3));
});

test('market and extension gates override previously confirmed plans without claiming participation',()=>{
 for(const extra of [{marketOK:false},{}]) {
  const rows=[row('a',extra.marketOK===false?{}:{status:'偏离均线，暂观察'})];
  const r=opportunityPriority(daily(rows,[plan('a','confirmed')],extra));
  assert.equal(r.items[0].stage,'waiting');
  assert.equal(r.items[0].priority,0);
  assert.equal(r.items[0].waiting,true);
  assert.doesNotMatch(r.items[0].label,/已确认|可参与/);
 }
 const recovered=opportunityPriority(daily([row('a')],[plan('a','confirmed',{gate:'市场条件未通过'})]));
 assert.equal(recovered.items[0].stage,'confirmed');
 assert.equal(recovered.items[0].gate,null);
});

test('only current qualified directions appear, and blocked or old progress cannot carry a confirmation forward',()=>{
 const r=opportunityPriority(daily([row('a'),row('b')],[
  plan('a','confirmed',{blocked:'日线缺失'}),
  plan('b','confirmed',{asOf:'2026-10-20'}),
  plan('removed-direction','confirmed')
 ]));
 assert.equal(r.items.length,2);
 assert.ok(r.items.every(i=>i.stage==='waiting'&&i.trackingReady===false));
 assert.ok(!r.items.some(i=>i.symbol==='removed-direction'));
 const unavailable=opportunityPriority({...daily([row('a')]),tracking:{error:'read failed',items:[]}});
 assert.equal(unavailable.ready,false);
 assert.deepEqual(unavailable.items,[]);
 const ended=opportunityPriority(daily([row('a')],[plan('a','invalid',{terminal:true})]));
 assert.equal(ended.items[0].stage,'waiting');
 assert.equal(ended.items[0].trackingReady,false);
});

test('frozen levels use the same symbol, and a changed representative must wait for a fresh plan',()=>{
 const rows=[row('new-etf',{exposure:'same'}),row('other-etf',{exposure:'same',rs5:1,rs20:1})];
 const r=opportunityPriority(daily(rows,[
  plan('old-etf','breakout',{exposure:'same',signalDate:'2026-10-18'}),
  plan('original-etf','confirmation',{exposure:'same',resistance:50,invalidation:45}),
  plan('terminal-etf','confirmed',{exposure:'same',signalDate:'2026-10-20',terminal:true})
 ]));
 assert.equal(r.items.length,1);
 const item=r.items[0];
 assert.equal(item.symbol,'new-etf');
 assert.equal(item.planId,null);
 assert.equal(item.resistance,10.5);
 assert.equal(item.invalidation,9);
 assert.equal(item.stage,'waiting');
 assert.equal(item.trackingReady,false);
 const same=opportunityPriority(daily([row('a')],[
  plan('a','breakout',{signalDate:'2026-10-18',resistance:9.5}),
  plan('a','confirmation',{resistance:10})
 ]));
 assert.equal(same.items[0].resistance,10);
 assert.equal(same.items[0].stage,'confirmation');
});

test('tiny relative-strength revisions preserve deterministic order and plan comparison keys',()=>{
 const first=opportunityPriority(daily([row('b',{rs5:4.02,rs20:4.02}),row('a',{rs5:4.01,rs20:4.01})]));
 const changed=opportunityPriority(daily([row('b',{rs5:4.01,rs20:4.01}),row('a',{rs5:4.02,rs20:4.02})]));
 assert.deepEqual(first.items.map(i=>i.symbol),['a','b']);
 assert.deepEqual(first.items.map(i=>i.comparisonKey),changed.items.map(i=>i.comparisonKey));
 const distinct=opportunityPriority(daily([row('a',{rs5:2,rs20:2}),row('b',{rs5:5,rs20:5})]));
 assert.deepEqual(distinct.items.map(i=>i.symbol),['b','a']);
});

test('missing, mixed-date, forming and invalid data cannot produce current ranked opportunities',()=>{
 for(const extra of [{ready:false},{date:'2026-02-30'},{stale:true},{forming:true}]) {
  const r=opportunityPriority(daily([row('a')],[],extra));
  assert.equal(r.ready,false);
  assert.deepEqual(r.items,[]);
 }
 const rows=[row('a',{date:'2026-10-20'}),row('b',{rs20:null}),row('c',{invalidation:12}),row('d',{stale:true}),row('e',{forming:true})];
 assert.deepEqual(opportunityPriority(daily(rows)).items,[]);
 const explicitEmpty=opportunityPriority(daily([row('a')],[],{priorityRows:[]}));
 assert.deepEqual(explicitEmpty.items,[]);
 assert.equal(explicitEmpty.ready,true);
});

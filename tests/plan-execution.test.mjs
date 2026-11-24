import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {evaluatePlanExecution,createExecutionMonitor,createExecutionHandler,inTradingSession} from '../plan-execution.mjs';
import {morningDecisionMarkup,executionMarkup} from '../dist/execution-markup.js';
const date='2026-11-18',at=time=>Date.parse(`${date}T${time}:00+08:00`);
const rule={version:'breakout-retest-v1',enabled:true,pressure:100,support:95,maxPremium:.01,retestMinutes:3,marketSymbol:'sh000300',marketFloor:99};
const item={symbol:'sh510300',name:'沪深300 ETF',sector:'宽基 ETF',focus:true,stance:'conditional',entryRule:rule};
const plan=()=>({id:date,date,generatedAt:`${date}T08:00:00+08:00`,ruleVersion:'morning-v2',late:false,preview:false,items:[structuredClone(item)],focusSymbols:['sh510300']});
function data(time='10:04'){
 return {now:at(time),quotes:[{symbol:item.symbol,price:100.5,low:99,open:100,quoteTime:`${date}T${time}:00+08:00`},
  {symbol:'sh000300',price:110,quoteTime:`${date}T${time}:00+08:00`}],
  history:new Map([[item.symbol,{date,points:['10:02','10:03','10:04'].map(time=>({time,price:100.2}))}]]),
  macds:new Map([[item.symbol,{points:[{time:`${date}T10:00:00+08:00`,confirmed:true,close:100.2,dif:.2,dea:.1,histogram:.2}]}]])};
}
test('only complete frozen entry conditions trigger; repeat checks and restart state do not retrigger',()=>{
 const p=plan(),before=JSON.stringify(p),first=evaluatePlanExecution(p,data());
 assert.equal(first.items[0].status,'eligible');assert.equal(first.events.length,1);assert.equal(first.events[0].kind,'entry');
 assert(first.items[0].checks.every(c=>c.passed));assert.equal(first.events[0].evidence.retest.length,3);
 const next=evaluatePlanExecution(p,data(),JSON.parse(JSON.stringify(first)));assert.equal(next.events.length,0);
 assert.equal(JSON.stringify(p),before);
});
test('watch-only, old, late, preview, other-day and out-of-session plans never create entry events',()=>{
 for(const mutate of [p=>{p.items[0].stance='wait';},p=>{p.ruleVersion='morning-v1';},p=>{p.late=true;},
   p=>{p.preview=true;},p=>{p.date='2026-11-17';},p=>{p.items[0].entryRule.enabled=false;},
   p=>{p.items[0].sector='风电';}]){
  const p=plan();mutate(p);assert.equal(evaluatePlanExecution(p,data()).events.length,0);
 }
 assert.equal(evaluatePlanExecution(plan(),data('08:30')).events.length,0);
 assert.equal(inTradingSession(at('12:00')),false);
 assert.equal(inTradingSession(Date.parse('2026-11-21T10:00:00+08:00')),false);
});
test('risk invalidation latches for the day even after a price rebound; one risk event is recorded',()=>{
 const d=data();d.quotes[0].low=94;
 const broken=evaluatePlanExecution(plan(),d);assert.equal(broken.items[0].status,'invalid');assert.equal(broken.events[0].kind,'risk');
 const rebound=evaluatePlanExecution(plan(),data(),broken);assert.equal(rebound.items[0].status,'invalid');assert.equal(rebound.events.length,0);
});
test('old/future quotes, mixed dates, missing opening data, gaps, forming candles and failed momentum suppress entry',()=>{
 const cases=[
  d=>{d.quoteStale=true;},d=>{d.quotes[0].quoteTime=`${date}T10:01:00+08:00`;},
  d=>{d.quotes[0].quoteTime=`${date}T10:05:00+08:00`;},d=>{d.quotes[0].open=null;},
  d=>{d.quotes[0].open=102;},d=>{d.quotes[0].price=102;},d=>{d.quotes[1].price=98;},
  d=>{d.quotes[1].quoteTime='2026-11-17T10:04:00+08:00';},
  d=>{d.history.get(item.symbol).date='2026-11-17';},d=>{d.history.get(item.symbol).stale=true;},
  d=>{d.history.get(item.symbol).points[1].time='10:00';},
  d=>{d.history.get(item.symbol).points[1].price=99;},
  d=>{d.macds.get(item.symbol).points[0].confirmed=false;},d=>{d.macds.get(item.symbol).stale=true;},
  d=>{d.macds.get(item.symbol).points[0].histogram=-.1;},d=>{d.macds.get(item.symbol).points[0].dif=.05;}
 ];
 for(const mutate of cases){const d=data();mutate(d);assert.equal(evaluatePlanExecution(plan(),d).events.length,0,mutate.toString());}
});
test('eligibility can expire without changing the plan; an old alert is not a fresh entry state',()=>{
 const p=plan(),first=evaluatePlanExecution(p,data()),d=data();d.quoteStale=true;
 const next=evaluatePlanExecution(p,d,first);assert.equal(next.items[0].status,'waiting');assert.equal(next.items[0].entered,true);
 const html=executionMarkup({today:date,current:first,records:first.events},at('10:10'));
 assert(!html.includes('class="execution-state eligible"'));assert(html.includes('检查结果过期'));assert(html.includes('历史触发'));
});
test('background monitor persists events independently from morning archive and deduplicates after restart',async()=>{
 const directory=await mkdtemp(tmpdir()+'/gp-execution-'),file=pathToFileURL(directory+'/execution.json');
 const p=plan(),frozen=JSON.stringify(p),d=data();
 const options={file,planner:{read:async()=>({records:[p]})},now:()=>at('10:04'),
  getQuotes:async()=>({quotes:d.quotes}),getIntraday:async s=>d.history.get(s),getMacd:async s=>d.macds.get(s)};
 try{
  const m=createExecutionMonitor(options);await Promise.all([m.run(),m.run()]);assert.equal((await m.read()).records.length,1);
  const restarted=createExecutionMonitor(options);await restarted.run();assert.equal((await restarted.read()).records.length,1);
  assert.equal(JSON.stringify(p),frozen);
  const handler=createExecutionHandler(restarted,()=>at('10:04'));
  async function call(method,headers={}){let output;await handler({method,headers:{host:'127.0.0.1:5178',...headers}},
    {writeHead(status){output={status};},end(body){output.data=JSON.parse(body);}},new URL('http://localhost/api/plan-execution'));return output;}
  assert.equal((await call('GET')).data.records.length,1);assert.equal((await call('POST')).status,405);
  assert.equal((await call('GET',{origin:'https://evil.example'})).status,403);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('execution markup escapes alert content and exposes current-data status separately from historical events',()=>{
 const first=evaluatePlanExecution(plan(),data());first.items[0].name='<img>';first.events[0].text='<script>x</script>';
 const html=executionMarkup({today:date,current:first,records:first.events},at('10:04'));
 assert(!html.includes('<img>'));assert(!html.includes('<script>'));assert(html.includes('条件已满足'));
});

test('live lot-rounded gross must reach the frozen minimum and fit the budget',()=>{
 const p=plan(),r=p.items[0].entryRule;
 r.minimumTradeAmount=30000;r.orderBudget=30100;
 assert.equal(evaluatePlanExecution(p,data()).events.length,0);
 r.orderBudget=30200;
 const confirmed=evaluatePlanExecution(p,data());
 assert.equal(confirmed.items[0].orderAmount,30150);
 assert.equal(confirmed.items[0].orderQuantity,300);
});

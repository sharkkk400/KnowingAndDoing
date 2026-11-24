import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {Readable} from 'node:stream';
import {buildStrategySnapshot, strategyChange, createStrategyAdvisor, createStrategyHandler} from '../strategy-advice.mjs';

const date='2026-10-21',dailyDate='2026-10-20';
const at=(day,time='10:00')=>Date.parse(`${day}T${time}:30+08:00`);
const row=(symbol,extra={})=>({symbol,name:symbol,exposure:symbol,close:11,resistance:12,invalidation:10.4,rs5:4,rs20:4,status:'等待突破确认',...extra});
const plan=(symbol,stage='breakout',extra={})=>({id:`${symbol}|2026-10-19`,symbol,name:symbol,exposure:symbol,
 signalDate:'2026-10-19',asOf:dailyDate,resistance:12,invalidation:10.4,stage,terminal:false,blocked:null,gate:null,...extra});
function fixture({day=date,sourceDate=dailyDate,time='10:00',rows=[row('a')],plans,regime='balanced',prices={}}={}) {
 const tracking=plans||rows.map(r=>plan(r.symbol,'breakout',{asOf:sourceDate,exposure:r.exposure}));
 const daily={ready:true,date:sourceDate,marketOK:true,benchmarkClose:4000,rows:rows.slice(0,3),priorityRows:rows,tracking:{items:tracking}};
 const quote=(symbol,price,prev)=>({symbol,price,prev,quoteTime:`${day}T${time}:00+08:00`});
 const quotes=[quote('sh000300',4010,4000),quote('sh000985',5000,4990),
  ...rows.map(r=>quote(r.symbol,prices[r.symbol]??r.close,r.close))];
 return {daily,result:{stale:false,quotes},market:{date:day,time,regime},now:at(day,time)};
}
const build=(f,previous=null)=>buildStrategySnapshot(f.daily,f.result,f.market,previous,f.now);
async function storage(t) {
 const dir=await mkdtemp(tmpdir()+'/gp-strategy-test-');
 t.after(()=>rm(dir,{recursive:true,force:true}));
 return pathToFileURL(dir+'/strategy.json');
}
async function observe(advisor,f){return advisor.observe(f.daily,f.result,f.market,f.now);}

test('the first observation establishes a baseline without announcing a change',async t=>{
 const f=fixture(),snapshot=build(f);
 assert.equal(snapshot.ready,true);
 assert.equal(strategyChange(null,snapshot),null);
 const advisor=createStrategyAdvisor(await storage(t));
 const first=await observe(advisor,f);
 assert.equal(first.baselineCreated,true);
 assert.equal(first.change,null);
 assert.equal((await advisor.read()).records.length,1);
});

test('confirmed stages outrank strength while small same-stage score changes preserve the incumbent',()=>{
 const ranked=build(fixture({rows:[row('a',{rs5:20,rs20:20}),row('b',{rs5:1,rs20:1})],
  plans:[plan('a'),plan('b','confirmed')]}));
 assert.deepEqual(ranked.items.map(i=>i.symbol),['b','a']);
 const first=build(fixture({rows:[row('a',{rs5:4.24,rs20:4.24}),row('b',{rs5:4.20,rs20:4.20})]}));
 const small=build(fixture({time:'10:01',rows:[row('a',{rs5:4.24,rs20:4.24}),row('b',{rs5:4.26,rs20:4.26})]}),first);
 assert.deepEqual(small.items.map(i=>i.symbol),['a','b']);
 assert.equal(strategyChange(first,small),null);
 const distinct=build(fixture({time:'10:02',rows:[row('a',{rs5:4.24,rs20:4.24}),row('b',{rs5:5,rs20:5})]}),small);
 assert.equal(distinct.items[0].symbol,'b');
 assert.equal(strategyChange(small,distinct).kind,'priority');
});

test('an old invalidation break takes priority across days even when the old direction leaves the cohort',()=>{
 const previous=build(fixture());
 const next=fixture({day:'2026-10-22',sourceDate:date,rows:[row('b')],regime:'broad_repair'});
 next.result.quotes.push({symbol:'a',price:10,prev:11,quoteTime:'2026-10-22T10:00:00+08:00'});
 const current=build(next,previous);
 assert.equal(current.ready,true);
 assert.equal(current.items[0].symbol,'b');
 assert.equal(current.risks[previous.items[0].planId],'broken');
 const change=strategyChange(previous,current);
 assert.equal(change.kind,'plan_invalid');
 assert.match(change.text,/a.*10\.400/);
 assert.equal(change.date,'2026-10-22');
});

test('a rebound never reactivates the same invalidated plan and touching resistance never confirms a daily entry',()=>{
 const previous=build(fixture());
 const broken=build(fixture({time:'10:01',prices:{a:10}}),previous);
 assert.equal(broken.items[0].stage,'waiting');
 const bounced=build(fixture({time:'10:02',prices:{a:11}}),broken);
 assert.equal(bounced.risks[bounced.items[0].planId],'broken');
 assert.equal(bounced.items[0].stage,'waiting');
 assert.equal(strategyChange(broken,bounced),null);

 for(const price of [12,12.2]) {
  const touched=build(fixture({time:'10:01',prices:{a:price}}),previous);
  assert.equal(touched.items[0].stage,'breakout');
  assert.notEqual(strategyChange(previous,touched)?.kind,'plan_stage');
  assert.doesNotMatch(strategyChange(previous,touched)?.text||'',/条件已确认|确认买入/);
 }
});

test('stale, future, mixed-date and missing quotes cannot advance the current plan',()=>{
 const previous=build(fixture());
 const cases=[
  f=>{f.result.stale=true;},
  f=>{f.market.date='2026-10-22';},
  f=>{f.market.time='10:10';},
  f=>{f.daily.date=date;},
  f=>{f.result.quotes.find(q=>q.symbol==='a').quoteTime='2026-10-20T10:01:00+08:00';},
  f=>{f.result.quotes.find(q=>q.symbol==='a').quoteTime=`${date}T10:10:00+08:00`;},
  f=>{f.result.quotes=f.result.quotes.filter(q=>q.symbol!=='a');},
  f=>{f.result.quotes.find(q=>q.symbol==='sh000300').prev=3000;},
  f=>{f.result.quotes.find(q=>q.symbol==='a').prev=10;},
  f=>{f.market.time='09:59';}
 ];
 for(const mutate of cases) {
  const f=fixture({time:'10:01'});
  mutate(f);
  const result=build(f,previous);
  assert.equal(result.ready,false,JSON.stringify(f.market));
  assert.deepEqual(result.items,[]);
  assert.equal(result.change,null);
 }
 const malformed=fixture({time:'10:01'});
 delete malformed.result.quotes.find(q=>q.symbol==='a').quoteTime;
 assert.equal(build(malformed,previous).ready,false);
});

test('an advancing market cutoff cannot accept an individual quote older than its last observation',()=>{
 const first=fixture();
 first.now=at(date,'10:01');
 first.result.quotes.find(q=>q.symbol==='a').quoteTime=`${date}T10:01:00+08:00`;
 const previous=build(first);
 assert.equal(previous.ready,true);
 assert.equal(previous.quoteTimes.a,`${date}T10:01:00+08:00`);

 const next=fixture({time:'10:01',prices:{a:10}});
 next.result.quotes.find(q=>q.symbol==='a').quoteTime=`${date}T09:59:00+08:00`;
 const current=build(next,previous);
 assert.equal(current.ready,false);
 assert.match(current.reason,/较早标的报价/);
 assert.deepEqual(current.items,[]);
 assert.equal(current.change,null);
});

test('same-plan source revisions cannot move frozen price levels or falsely invalidate the plan',()=>{
 const previous=build(fixture()),id=previous.items[0].planId;
 const revised=fixture({time:'10:01',prices:{a:10.5},
  rows:[row('a',{resistance:11.4,invalidation:10.7})],
  plans:[plan('a','breakout',{resistance:11.2,invalidation:10.8})]
 });
 const current=build(revised,previous);
 assert.equal(current.ready,true);
 assert.equal(current.items[0].planId,id);
 assert.equal(current.items[0].resistance,12);
 assert.equal(current.items[0].invalidation,10.4);
 assert.deepEqual(current.plans[id],{resistance:12,invalidation:10.4,referencePrice:11});
 assert.equal(current.risks[id],'clear');
 assert.equal(strategyChange(previous,current),null);

 const actualBreak=fixture({time:'10:02',prices:{a:10.3},rows:revised.daily.priorityRows,plans:revised.daily.tracking.items});
 const broken=build(actualBreak,current);
 assert.equal(broken.risks[id],'broken');
 assert.match(strategyChange(current,broken).text,/10\.400/);
});

test('terminal plan events beat market and ranking changes, while a new identity is never a stage upgrade',()=>{
 const previous=build(fixture());
 for(const [stage,kind] of [['invalid','plan_invalid'],['expired','plan_expired']]) {
  const current=build(fixture({time:'10:01',regime:'defensive',plans:[plan('a',stage,{terminal:true,asOf:dailyDate})]}),previous);
  assert.equal(current.ready,true);
  assert.equal(strategyChange(previous,current).kind,kind);
 }
 const fresh=fixture({day:'2026-10-22',sourceDate:date,plans:[
  plan('a','confirmed',{id:`a|${date}`,signalDate:date,asOf:date})
 ]});
 const next=build(fresh,previous);
 assert.equal(next.ready,true);
 assert.equal(strategyChange(previous,next).kind,'new_plan');
});

test('identical refreshes retain the current notice, restart preserves it, and concurrent refreshes do not duplicate records',async t=>{
 const file=await storage(t),advisor=createStrategyAdvisor(file);
 const first=fixture();
 const results=await Promise.all(Array.from({length:8},()=>observe(advisor,first)));
 assert.equal(results.filter(r=>r.baselineCreated).length,1);
 assert.equal((await advisor.read()).records.length,1);
 const update=fixture({time:'10:01',prices:{a:10}});
 const changed=await observe(advisor,update);
 assert.equal(changed.change.kind,'plan_invalid');
 const repeated=await Promise.all(Array.from({length:8},()=>observe(advisor,update)));
 assert.ok(repeated.every(r=>r.change.kind==='plan_invalid'));
 assert.equal((await advisor.read()).records.length,2);
 const restarted=createStrategyAdvisor(file);
 const bounced=await observe(restarted,fixture({time:'10:02'}));
 assert.equal(bounced.change.kind,'plan_invalid');
 assert.equal(bounced.items[0].stage,'waiting');
 const saved=JSON.parse(await readFile(file,'utf8'));
 assert.equal(saved.records.length,2);
 assert.equal(saved.change.kind,'plan_invalid');
});

test('a no-change refresh still advances the freshness boundary so an older observation cannot invalidate a plan',async t=>{
 const advisor=createStrategyAdvisor(await storage(t));
 await observe(advisor,fixture());
 await observe(advisor,fixture({time:'10:02'}));
 const older=fixture({time:'10:01',prices:{a:10}});
 older.now=at(date,'10:02');
 const rejected=await observe(advisor,older);
 assert.equal(rejected.ready,false);
 assert.equal((await advisor.read()).change,null);
});

test('the local handler accepts only the intended same-origin POST and does not observe rejected requests',async()=>{
 let observed=0,dailyReads=0;
 const f=fixture();
 const handler=createStrategyHandler({
  advisor:{observe:async()=>{observed++;return {ready:true,date,items:[],change:null};}},
  getDaily:async()=>{dailyReads++;return f.daily;},
  getQuotes:async()=>f.result,now:()=>f.now
 });
 async function request({path='/api/strategy-advice',method='POST',host='127.0.0.1:5178',origin,site,body=JSON.stringify(f.market)}={}) {
  const req=Readable.from([body]);req.method=method;req.headers={host,...origin?{origin}:{},...site?{'sec-fetch-site':site}:{}};
  const result={};
  const res={writeHead(status,headers){result.status=status;result.headers=headers;},end(text){result.body=JSON.parse(text);}};
  result.handled=await handler(req,res,new URL(path,'http://127.0.0.1:5178'));
  return result;
 }
 assert.equal((await request({path:'/api/other'})).handled,false);
 assert.equal((await request({method:'GET'})).status,405);
 assert.equal((await request({host:'example.com'})).status,403);
 assert.equal((await request({origin:'https://example.com'})).status,403);
 assert.equal((await request({site:'cross-site'})).status,403);
 assert.equal((await request({body:'{broken'})).status,503);
 assert.equal((await request({body:'x'.repeat(2049)})).status,503);
 assert.equal(observed,0);assert.equal(dailyReads,0);
 const accepted=await request({origin:'http://127.0.0.1:5178'});
 assert.equal(accepted.status,200);
 assert.equal(accepted.body.ready,true);
 assert.equal(accepted.headers['Cache-Control'],'no-store');
 assert.equal(observed,1);assert.equal(dailyReads,1);
});

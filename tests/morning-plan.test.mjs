import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {buildMorningPlan,morningNews,createMorningPlanner,createMorningHandler} from '../morning-plan.mjs';
import {morningMarkup} from '../dist/morning-markup.js';
import {mergeNews} from '../news.mjs';

const at=t=>Date.parse('2026-11-18T'+t+':00+08:00');
const defs=[{symbol:'sh000300',name:'沪深300',sector:'指数',code:'000300'},
  {symbol:'sh510300',name:'沪深300 ETF',sector:'宽基 ETF',code:'510300'},
  {symbol:'sz002202',name:'不应出现的股票',sector:'风电',code:'002202'}];
const bar=(date,close)=>({date,close,high:close+1,low:close-1,volume:10000});
const bars=Array.from({length:80},(_,i)=>bar(new Date(Date.parse('2026-11-17')-(79-i)*86400000).toISOString().slice(0,10),100+i));
const daily=()=>new Map(defs.map(d=>[d.symbol,{bars,source:'测试日线',fetchedAt:'2026-11-18T07:50:00+08:00'}]));
const article={id:'n1',title:'降准政策观察',body:'降准影响需核实',url:'https://www.gov.cn/test',
  publishedAt:'2026-11-17T18:00:00+08:00',firstObservedAt:'2026-11-17T18:02:00+08:00',source:'测试来源',sourceId:'sina',categories:['政策监管']};
const news=()=>({items:[article],sources:[{id:'sina',name:'测试来源',status:'connected',lastSuccessAt:'2026-11-18T07:59:00+08:00',intervalSeconds:90}],stale:false});

test('morning plan uses previous close only, freezes cutoff, includes index/ETF and contextual news',()=>{
 const data=daily();data.get('sh510300').bars=[...bars,bar('2026-11-18',99999)];
 const p=buildMorningPlan({daily:data,news:news(),defs,now:at('08:00')});
 assert.equal(p.closeDate,'2026-11-17');assert.equal(p.items.length,2);assert.equal(p.status,'ready');
 assert.equal(p.items.find(i=>i.symbol==='sh510300').close,179);
 assert.equal(p.cutoffAt,new Date(at('08:00')).toISOString());
 assert.equal(p.news.items.length,1);assert(p.news.items[0].links.some(l=>l.symbol==='sh510300'));
 assert(p.items.every(i=>i.conditions.some(c=>c.label==='日线确认')&&i.conditions.some(c=>c.label==='盘中风控')));
 assert.equal(p.items[1].stance,'conditional');assert.equal(p.preview,false);
});

test('news window excludes pre-close, post-cutoff, unknown observation time, revised versions, date-only and company news',()=>{
 const items=[article,
  {...article,id:'before',publishedAt:'2026-11-17T15:00:00+08:00'},
  {...article,id:'after',publishedAt:'2026-11-18T08:01:00+08:00'},
  {...article,id:'unknown',firstObservedAt:undefined},
  {...article,id:'revised',firstObservedAt:'2026-11-18T09:00:00+08:00'},
  {...article,id:'day',datePrecision:'day'},
  {...article,id:'company',categories:['公司事件']},
  {...article,id:'unsafe',url:'javascript:alert(1)'}];
 const result=morningNews({items},defs,Date.parse('2026-11-17T15:00:00+08:00'),at('08:00'));
 assert.deepEqual(result.items.map(n=>n.id),['n1']);assert.equal(result.excluded.unobserved,2);assert.equal(result.excluded.dateOnly,1);
});

test('missing sources, date mismatch, weak trend and risk news block additional participation',()=>{
 let p=buildMorningPlan({daily:daily(),news:{...news(),stale:true,sources:[]},defs,now:at('08:00')});
 assert.equal(p.status,'limited');assert(p.items.every(i=>i.stance==='wait'));
 const old=daily();for(const d of old.values())d.bars=bars.slice(0,-1);
 p=buildMorningPlan({daily:old,news:news(),defs,now:at('08:00')});assert(p.items.every(i=>i.stance==='wait'));
 const weak=daily();for(const d of weak.values())d.bars=bars.map((b,i)=>bar(b.date,200-i));
 p=buildMorningPlan({daily:weak,news:news(),defs,now:at('08:00')});assert.equal(p.market.regime,'weak');assert(p.items.every(i=>i.stance==='wait'));
 p=buildMorningPlan({daily:daily(),news:{...news(),items:[{...article,title:'降准讨论与出口管制风险'}]},defs,now:at('08:00')});
 assert.equal(p.market.macroRisk,true);assert(p.items.every(i=>i.stance==='wait'));
});

test('late generation does not use today close or post-08:00 news; weekend is observation only',()=>{
 const p=buildMorningPlan({daily:daily(),news:{...news(),items:[{...article,firstObservedAt:'2026-11-18T09:05:00+08:00'}]},defs,now:at('20:00')});
 assert.equal(p.late,true);assert.equal(p.closeDate,'2026-11-17');assert.equal(p.news.items.length,0);
 const weekend=buildMorningPlan({daily:daily(),news:news(),defs,now:Date.parse('2026-11-21T08:00:00+08:00')});
 assert.equal(weekend.weekend,true);assert(weekend.items.every(i=>i.stance==='wait'));
});

test('a missing daily session cannot be treated as an aligned sixty-session history',()=>{
 const data=daily();data.get('sh510300').bars=bars.filter((_,i)=>i!==70);
 const p=buildMorningPlan({daily:data,news:news(),defs,now:at('08:00')});
 assert.equal(p.items.find(i=>i.symbol==='sh510300').status,'数据待补');
 assert.equal(p.status,'limited');
});

test('preview is not stored, scheduler generates once after 08:00, concurrent and restart runs preserve immutable evidence',async()=>{
 const dir=await mkdtemp(tmpdir()+'/gp-morning-'),file=pathToFileURL(dir+'/plans.json');
 let clock=at('07:59'),calls=0;
 const opts={file,defs,now:()=>clock,getNews:news,getDaily:async s=>{calls++;return daily().get(s);}};
 try{
  const planner=createMorningPlanner(opts);
  await planner.tick();assert.equal(calls,0);
  const preview=await planner.generate(true);assert(preview.preview);assert.equal((await planner.read()).records.length,0);
  assert.equal((await planner.read()).records.length,0);
  clock=at('08:00');const plans=await Promise.all([planner.generate(),planner.generate(),planner.generate()]);
  assert.deepEqual(plans[0],plans[1]);assert.equal((await planner.read()).records.length,1);
  const count=calls;clock=at('10:00');await planner.tick();assert.equal(calls,count);
  const restarted=createMorningPlanner({...opts,getDaily:()=>{throw Error('不应重采');}});
  assert.deepEqual(await restarted.generate(),plans[0]);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('HTTP endpoints enforce local origin, validate dates and distinguish preview from frozen runs',async()=>{
 const dir=await mkdtemp(tmpdir()+'/gp-morning-api-');
 try{
  const planner=createMorningPlanner({file:pathToFileURL(dir+'/p.json'),defs,now:()=>at('08:00'),getNews:news,getDaily:async s=>daily().get(s)});
  const handle=createMorningHandler(planner,()=>at('08:00'));
  async function call(path,method='GET',headers={}){
   let result;const res={writeHead(status){result={status};},end(body){result.data=JSON.parse(body);}};
   const handled=await handle({method,headers:{host:'127.0.0.1:5178',...headers}},res,new URL(path,'http://localhost'));
   return {handled,...result};
  }
  assert.equal((await call('/api/morning-plan?date=bad')).status,400);
  assert.equal((await call('/api/morning-plan/run','POST',{origin:'https://evil.example'})).status,403);
  assert.equal((await call('/api/morning-plan','GET',{host:'evil.example'})).status,403);
  assert.equal((await call('/api/morning-plan/run','GET')).status,405);
  assert.equal((await call('/api/morning-plan/preview','POST')).data.plan.preview,true);
  assert.equal((await call('/api/morning-plan')).data.plan,null);
  assert.equal((await call('/api/morning-plan/run','POST')).data.plan.preview,false);
  assert.equal((await call('/api/morning-plan')).data.plan.date,'2026-11-18');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('news refresh preserves observed time for identical content, but changed content gets a new evidence time',()=>{
 const old={...article,fingerprint:'a'},same={...old,firstObservedAt:'2026-11-18T09:00:00+08:00'};
 assert.equal(mergeNews([old],[same],at('10:00'))[0].firstObservedAt,old.firstObservedAt);
 const changed={...same,fingerprint:'b'};assert.equal(mergeNews([old],[changed],at('10:00'))[0].firstObservedAt,changed.firstObservedAt);
});

test('source success after 08:00 does not hide a recorded success before the cutoff',()=>{
 const input=news();input.sources[0].recentSuccesses=[input.sources[0].lastSuccessAt];
 input.sources[0].lastSuccessAt='2026-11-18T08:00:05+08:00';
 const p=buildMorningPlan({daily:daily(),news:input,defs,now:at('08:01')});
 assert.equal(p.status,'ready');assert.equal(p.news.sources[0].eligible,true);
 assert.equal(p.news.sources[0].lastSuccessAt,'2026-11-18T08:00:05+08:00');
});

test('morning UI escapes content and rejects unsafe article links',()=>{
 const p=buildMorningPlan({daily:daily(),news:news(),defs,now:at('08:00')});
 p.summary='<script>bad</script>';p.news.items[0].title='<img onerror=x>';p.news.items[0].url='javascript:alert(1)';
 const html=morningMarkup(p);assert(!html.includes('<script>'));assert(!html.includes('<img'));assert(!html.includes('href="javascript:'));
 assert(html.includes('日线确认'));assert(html.includes('盘中风控'));
});

test('coverage counts a fund at its 60th market session and keeps older funds with gaps in the denominator',()=>{
 const fund={symbol:'sz159999',sector:'行业ETF',name:'测试ETF'};
 const data=daily();
 data.set(fund.symbol,{bars:bars.slice(-3)});
 const cutoff=bars.at(-60).date;
 function plan(firstTrade){
  return buildMorningPlan({daily:data,news:news(),defs:[...defs,fund],now:at('08:00'),firstTradeDates:{[fund.symbol]:firstTrade}});
 }
 const young=plan(bars.at(-59).date);
 assert.equal(young.market.total,2);
 assert.equal(young.status,'ready');
 assert.equal(young.items.find(i=>i.symbol===fund.symbol).stance,'wait');
 for(const firstTrade of [cutoff,bars[0].date,undefined]){
  const p=plan(firstTrade);
  assert.equal(p.market.total,3);
  assert.equal(p.status,'limited');
 }
});

test('confirmed rebound position uses fee-adjusted close and actual remaining quantity',async()=>{
 const dir=await mkdtemp(tmpdir()+'/gp-rebound-');
 try{
  for(const [quantity,firstFillPrice,entryDate,expected] of [
   [2000,179,'2026-11-17','减仓'],[1000,179,'2026-11-16','清仓'],
   [2000,175,'2026-11-17','持有'],[2000,175,'2026-11-13','清仓']]){
   const record={symbol:'sh510300',quantity,bounce:true,initialQuantity:2000,entryDate,firstFillPrice,at:new Date(at('07:50')).toISOString()};
   const planner=createMorningPlanner({defs,now:()=>at('08:00'),positions:{read:async()=>({records:[record]})},getDaily:async s=>daily().get(s),getNews:async()=>news(),file:pathToFileURL(dir+'/plans.json')});
   const plan=await planner.generate(true);
   assert.equal(plan.holdings[0].action,expected);
   assert.equal(plan.items.find(i=>i.symbol===record.symbol).entryRule.enabled,false);
   if(expected==='减仓')assert.equal(plan.holdings[0].remainingSellQuantity,1000);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('funded account caps and minimum also apply to rebound reductions',async()=>{
 const dir=await mkdtemp(tmpdir()+'/gp-orderfloor-');
 try{
  const record={symbol:'sh510300',quantity:200,bounce:true,initialQuantity:200,entryDate:'2026-11-17',firstFillPrice:179,at:new Date(at('07:50')).toISOString()};
  const planner=createMorningPlanner({defs,now:()=>at('08:00'),positions:{read:async()=>({records:[record]})},getDaily:async s=>daily().get(s),getNews:async()=>news(),file:pathToFileURL(dir+'/plans.json')});
  const plan=await planner.generate(true);
  assert.equal(plan.sizing.totalBudget,150000);
  assert.equal(plan.sizing.addTargetAmount,75000);
  assert.equal(plan.holdings[0].action,'清仓');
  assert.equal(plan.holdings[0].orderQuantity,200);
  assert.deepEqual(plan.operations.sells,['sh510300']);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('weak-market morning reserves both opening orders and assigns the final slot by priority',async()=>{
 const dir=await mkdtemp(tmpdir()+'/gp-weak-open-');
 try{
  const red={symbol:'sh515450',name:'红利低波ETF南方',sector:'红利 ETF',code:'515450'};
  const market=bars.map((b,i)=>bar(b.date,200-i));
  market.at(-1).close=market.at(-2).close*1.025;market.at(-1).high=market.at(-1).close+1;market.at(-1).volume=13000;
  const prices=d=>market.map(b=>bar(b.date,d));
  for(const riskOn of [false,true]){
   const records=riskOn?[{symbol:red.symbol,weakDefense:true,quantity:10000,at:new Date(at('07:50')).toISOString()}]:[];
   const planner=createMorningPlanner({defs:[...defs,red],now:()=>at('08:00'),positions:{read:async()=>({records})},getDaily:async s=>({bars:s==='sh000300'?(riskOn?bars:market):prices(2)}),getNews:async()=>news(),file:pathToFileURL(dir+'/plans.json')});
   const plan=await planner.generate(true);
   if(riskOn){
    assert.equal(plan.holdings[0].action,'清仓');
    assert.equal(plan.holdings[0].orderQuantity,10000);
   }else{
    assert.deepEqual(plan.openingOrders.map(o=>[o.symbol,o.budget]),[['sh510300',33300],['sh515450',60000]]);
    assert.deepEqual(plan.operations.buys,['sh510300','sh515450']);
   }
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});

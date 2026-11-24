import {remainingEntries,dailyOperationLimit} from './daily-operations.mjs';
import {allowedSymbols,occupiedNow} from './position-limit.mjs';
import {createResearchStore,chinaDate} from './research-store.mjs';

const valid=n=>Number.isFinite(n)&&n>0;
const stamp=(date,time)=>Date.parse(`${date}T${time}:00+08:00`);
export function inTradingSession(now){
 const local=new Date(now+8*3600000),day=local.getUTCDay(),time=local.toISOString().slice(11,16);
 return day!==0&&day!==6&&(time>='09:30'&&time<='11:30'||time>='13:00'&&time<='15:00');
}
const currentQuote=(q,date,now)=>q?.quoteTime?.slice(0,10)===date&&valid(q.price)&&
 Number.isFinite(Date.parse(q.quoteTime))&&Date.parse(q.quoteTime)<=now&&now-Date.parse(q.quoteTime)<=120000;

// A monitor reads frozen rules. It never upgrades a waiting plan or rewrites morning evidence.
export function evaluatePlanExecution(plan,{quotes=[],quoteStale=false,history=new Map(),macds=new Map(),allowed,entrySlots=dailyOperationLimit,now=Date.now()}={},previous={}){
 const date=chinaDate(now),prior=previous?.date===date&&previous.planGeneratedAt===plan?.generatedAt?previous:null;
 const rows=[],events=[],bySymbol=new Map(quotes.map(q=>[q.symbol,q]));
 const focus=plan?.items?.filter(i=>(i.sector==='指数'||i.sector?.endsWith('ETF'))&&(i.focus||plan.focusSymbols?.includes(i.symbol)))||[];
 const reason=!plan?'今日8点计划尚未生成':plan.date!==date?'历史计划不参与今日提醒':plan.preview?'预览不参与提醒':
   plan.late?'今日计划为补生成，不追溯或模拟8点入场提醒':plan.ruleVersion!=='morning-v2'?'原存档没有当日入场规则，保持原样，仅供查看':
   !inTradingSession(now)?'非交易时段，暂停入场检查':null;
 for(const item of focus){
  const rule=item.entryRule,q=bySymbol.get(item.symbol),old=prior?.items?.find(i=>i.symbol===item.symbol);
  const row={observationOnly:!rule?.enabled||item.stance!=='conditional',symbol:item.symbol,name:item.name,status:'waiting',reason:'等待原计划条件',price:q?.price||null,quoteTime:q?.quoteTime||null,
   ruleVersion:rule?.version||null,invalid:!!old?.invalid,entered:!!old?.entered,checks:[]};
  rows.push(row);
  const check=(label,passed)=>row.checks.push({label,passed:!!passed});
  const wait=text=>{row.reason=text;};
  const emit=(kind,text)=>events.push({id:`${date}|${plan.id}|${item.symbol}|${kind}`,date,planId:plan.id,
    planGeneratedAt:plan.generatedAt,planRuleVersion:plan.ruleVersion,ruleVersion:rule?.version,
    symbol:item.symbol,name:item.name,kind,text,observedAt:new Date(now).toISOString(),
    quoteTime:q?.quoteTime,price:q?.price,open:q?.open,dayLow:q?.low,pressure:rule?.pressure,support:rule?.support,
    evidence:row.evidence||null,checks:structuredClone(row.checks)});
  if(reason){wait(reason);continue;}
  if(rule?.enabled!==true||item.stance!=='conditional'){wait('8点计划为观望，盘中不转为参与');continue;}
  if(rule.version!=='breakout-retest-v1'||!valid(rule.pressure)||!valid(rule.support)||!valid(rule.marketFloor)||rule.retestMinutes!==3||rule.maxPremium!==.01){wait('规则版本或参数不完整，不猜测入场条件');continue;}
  if(row.invalid){row.status='invalid';wait('原计划风险位已失守，今日不恢复入场提醒');continue;}
  if(quoteStale||!currentQuote(q,date,now)){wait('报价缺失、过期或日期不一致，暂停检查');continue;}
  if(!valid(q.open)||!valid(q.low)||q.low>q.price||q.low>q.open){wait('开盘价或当日最低价缺失/异常，无法核对风险');continue;}
  if(q.low<=rule.support||q.price<=rule.support){
   row.status='invalid';row.invalid=true;wait('当日价格已触及8点冻结风险位，原参与条件失效');
   check('风险位未触及',false);emit('risk',`${item.name}当日价格已触及冻结风险位 ${rule.support}，今日原参与条件失效。`);continue;
  }
  check('风险位未触及',true);
  if(q.open>rule.pressure*(1+rule.maxPremium)){wait('开盘已超过冻结突破位1%，按原计划观望');continue;}
  check('开盘未跳空超限',true);
  const market=bySymbol.get(rule.marketSymbol);
  if(!currentQuote(market,date,now)||market.price<rule.marketFloor){wait('沪深300报价未确认或低于8点冻结MA20，观望');continue;}
  check('市场条件通过',true);
  if(q.price<rule.pressure||q.price>rule.pressure*(1+rule.maxPremium)){wait('未站上突破位或超过1%追高边界，观望');continue;}
  check('现价位于冻结参与区间',true);
  const entry=history.get(item.symbol),m=macds.get(item.symbol),quoteAt=Date.parse(q.quoteTime);
  if(entry?.stale||entry?.date!==date||m?.stale){wait('分时或15分钟数据缺失/异常，暂停确认');continue;}
  const completed=(m?.points||[]).filter(k=>k.confirmed===true&&k.time?.slice(0,10)===date&&
    Date.parse(k.time)<=quoteAt&&Date.parse(k.time)<=now).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
  const k=completed.at(-1),kAt=Date.parse(k?.time);
  if(!k||quoteAt-kAt>20*60000||!valid(k.close)||k.close<=rule.pressure||
    ![k.dif,k.dea,k.histogram].every(Number.isFinite)||k.dif<=k.dea||k.histogram<=0){
   wait('等待已完成15分钟K线突破且MACD偏多');continue;
  }
  check('已完成15分钟突破与MACD确认',true);
  const points=[...new Map((entry?.points||[]).filter(p=>/^\d\d:\d\d$/.test(p.time)&&valid(p.price))
    .map(p=>[p.time,{...p,at:stamp(date,p.time)}])).values()].filter(p=>p.at>kAt&&p.at<=quoteAt&&p.at<=now)
    .sort((a,b)=>a.at-b.at).slice(-rule.retestMinutes);
  if(points.length!==rule.retestMinutes||quoteAt-points.at(-1).at>60000||
    points.some((p,i)=>p.price<rule.pressure||(i&&p.at-points[i-1].at!==60000))){
   wait('等待突破后连续3个分钟采样价守住；缺口、午休不连算');continue;
  }
  check('随后连续3个分钟采样价守住',true);
  if(rule.profitFloor!==undefined&&!(points.at(-1).price>rule.profitFloor&&q.price>rule.profitFloor)){
   wait('首仓扣除买卖费用后尚未浮盈，暂停加仓提醒');continue;
  }
  row.evidence={candleTime:k.time,candleClose:k.close,dif:k.dif,dea:k.dea,histogram:k.histogram,
    retest:points.map(p=>({time:p.time,price:p.price})),marketPrice:market.price,marketQuoteTime:market.quoteTime,marketFloor:rule.marketFloor};
  if(allowed&&!allowed.has(item.symbol)){wait('持仓名额或已有仓位计划限制，暂停新增提醒');continue;}
  if(!row.entered&&(typeof entrySlots==='function'?entrySlots(item.symbol):entrySlots)<=0){wait('该ETF今日两次操作额度已用完或预留');continue;}
  let orderText='';
  if(rule.minimumTradeAmount>0){
   const lots=Math.floor(rule.orderBudget/(100*q.price)+1e-10);
   const quantity=lots*100,amount=quantity*q.price;
   if(!(amount>=rule.minimumTradeAmount&&amount<=rule.orderBudget+1e-7)){
    wait('按现价取整手后无法在预算内达到单笔3万元，暂停参与');continue;
   }
   row.orderQuantity=quantity;row.orderAmount=amount;
   orderText='，按现价 '+quantity+' 份约 '+amount.toFixed(2)+' 元，成交额须满30,000元';
  }
  row.status='eligible';row.reason='已满足8点原计划的当日入场观察条件';
  if(!row.entered){row.entered=true;emit('entry',`${item.name}已满足今日8点冻结的入场观察条件${orderText}，请核对最新报价；不代表已成交。`);}
 }
 return {date,planId:plan?.id||null,planGeneratedAt:plan?.generatedAt||null,checkedAt:new Date(now).toISOString(),
   status:reason?'paused':'monitoring',reason:reason||'每30秒检查今日冻结条件，不修改计划',items:rows,events};
}

export function createExecutionMonitor({planner,positions,getQuotes,getIntraday,getMacd,now=Date.now,
 file=new URL('./data/plan-execution.json',import.meta.url)}){
 const store=createResearchStore(file,{version:1,records:[],current:null});
 let pending,timer,lastError=null;
 async function run(){
  if(pending)return pending;
  pending=(async()=>{
   const clock=now(),date=chinaDate(clock),saved=await planner.read(),plan=saved.records.find(p=>p.date===date);
   let quotes={quotes:[],stale:true};const history=new Map(),macds=new Map();
   if(plan&&!plan.preview&&!plan.late&&plan.ruleVersion==='morning-v2'&&inTradingSession(clock)){
    try{quotes=await getQuotes();}catch{}
    const targets=plan.items.filter(i=>(i.sector==='指数'||i.sector?.endsWith('ETF'))&&i.focus&&i.entryRule?.enabled===true);
    await Promise.all(targets.map(async i=>{
     const results=await Promise.allSettled([getIntraday(i.symbol),getMacd(i.symbol)]);
     history.set(i.symbol,results[0].status==='fulfilled'?results[0].value:{stale:true});
     macds.set(i.symbol,results[1].status==='fulfilled'?results[1].value:{stale:true});
    }));
   }
   if(chinaDate(now())!==date)return;
   const confirmations=positions?(await positions.read()).records:[];
   await store.update(state=>{
    const allowed=plan&&positions?allowedSymbols(plan,occupiedNow(plan,confirmations,state.records)):undefined;
    if(allowed&&plan.defensiveSwitch?.requireSaleBeforeEntry&&occupiedNow(plan,confirmations,state.records).has(plan.defensiveSwitch.symbol))allowed.clear();
    const current=evaluatePlanExecution(plan,{quotes:quotes.quotes,quoteStale:quotes.stale,history,macds,allowed,entrySlots:symbol=>remainingEntries(plan,confirmations,state.records,symbol),now:now()},state.current);
    const known=new Set(state.records.map(e=>e.id));
    return {...state,current:{...current,events:undefined},records:[...state.records,...current.events.filter(e=>!known.has(e.id))]};
   });lastError=null;
  })().catch(e=>{lastError=e.message;console.error('计划执行检查：'+e.message);}).finally(()=>{pending=null;});
  return pending;
 }
 return {run,async read(){const s=await store.read();return {...s,lastError,running:!!pending};},
  start(){void run();timer=setInterval(()=>void run(),30000);timer.unref();},stop(){clearInterval(timer);}};
}

export function createExecutionHandler(monitor,now=Date.now){
 return async(req,res,url)=>{
  if(url.pathname!=='/api/plan-execution')return false;
  const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  if(!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(req.headers.host||'')||req.headers['sec-fetch-site']==='cross-site'||
    (req.headers.origin&&req.headers.origin!=='http://'+req.headers.host)){send(403,{error:'仅允许本地工作台读取执行提醒'});return true;}
  if(req.method!=='GET'){send(405,{error:'执行检查由后台定时运行，此接口只读'});return true;}
  try{const state=await monitor.read(),today=chinaDate(now());
   send(200,{today,current:state.current?.date===today?state.current:null,records:state.records.filter(e=>e.date===today),
     running:state.running,lastError:state.lastError});
  }catch{send(503,{error:'执行记录暂不可用，保留原记录'});}
  return true;
 };
}

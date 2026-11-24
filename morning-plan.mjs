import firstTradeHistory from './data/etf-first-trade-history.json' with {type:'json'};
import {applyEntryCrowding} from './pentad-policy.mjs';
import {reserveOperations} from './daily-operations.mjs';
import {allocateBudget} from './account-budget.mjs';
import {allowedSymbols, positionLimit} from './position-limit.mjs';
import {holdingPlan} from './holding-plan.mjs';
import {createResearchStore, chinaDate, validDate, safeLink} from './research-store.mjs';
import {instruments,instrumentCatalog} from './dist/instruments.js';
import {associateNews} from './dist/news-market.js';

const positive = n => Number.isFinite(n) && n > 0;
const stamp = (date, time) => Date.parse(`${date}T${time}:00+08:00`);
const mean = bars => bars.reduce((s, b) => s + b.close, 0) / bars.length;
const scope = defs => defs.filter(d => d.sector === '指数' || d.sector?.endsWith('ETF'));
export const morningCutoff = now => stamp(chinaDate(now), '08:00');
const riskWords = /加征关税|制裁|出口管制|重大风险|暂停交易|突发冲突/;

// Only a timestamped, already observed version is eligible for the frozen news window.
export function morningNews(payload, defs, since, cutoff) {
  const eligible = [], excluded = {dateOnly:0, unobserved:0};
  for (const n of payload?.items || []) {
    const published = Date.parse(n.publishedAt), observed = Date.parse(n.firstObservedAt);
    if (n.categories?.includes('公司事件') || n.sourceId === 'cninfo' || !safeLink(n.url)) continue;
    if (n.datePrecision === 'day') { excluded.dateOnly++; continue; }
    if (!Number.isFinite(published) || published <= since || published > cutoff) continue;
    if (!Number.isFinite(observed) || observed > cutoff || observed < published - 300000) { excluded.unobserved++; continue; }
    const links = associateNews(n, scope(defs)).map(d => ({symbol:d.symbol, name:d.name, reason:d.reason}));
    eligible.push({id:n.id, title:n.title, body:n.body, publishedAt:n.publishedAt,
      firstObservedAt:n.firstObservedAt, source:n.source, sourceId:n.sourceId, url:safeLink(n.url),
      links, risk: riskWords.test(n.title + ' ' + n.body),
      interpretation:links.length ? '关键词关联，需核实影响范围；不是已确认价格响应' : '市场背景线索，尚无明确标的关联'});
  }
  eligible.sort((a,b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || String(a.id).localeCompare(String(b.id)));
  return {items:eligible, excluded};
}

function pastBars(data, today) {
  const bars = (data?.bars || []).filter(b => validDate(b.date) && b.date < today &&
    [b.close,b.high,b.low].every(positive) && b.low <= b.close && b.close <= b.high);
  return [...new Map(bars.map(b => [b.date,b])).values()].sort((a,b) => a.date.localeCompare(b.date));
}

// Count only funds with a close on each of the same 20 market sessions.
function bounceBreadth(daily, defs, marketBars, offset) {
  const end=marketBars.length-offset;
  if(end<20)return null;
  const sessions=marketBars.slice(end-20,end).map(bar=>bar.date);
  let above=0, eligible=0;
  for(const def of defs){
    if(!def.sector?.endsWith('ETF'))continue;
    const source=daily.get(def.symbol);
    if(!source||source.stale)continue;
    const prices=new Map(source.bars?.map(bar=>[bar.date,bar.close]));
    const closes=sessions.map(date=>prices.get(date));
    if(!closes.every(positive))continue;
    eligible++;
    if(closes[19]>mean(closes))above++;
  }
  return eligible?above/eligible:null;
}

export function prolongedWeakBounce(bars){
  if(bars.length<80)return false;
  const last=bars.at(-1),prior=bars.slice(-21,-1);
  if(!prior.every(b=>positive(b.volume))||!(last.close>=1.02*prior.at(-1).close&&
    last.volume>=1.2*prior.reduce((sum,b)=>sum+b.volume,0)/20))return false;
  return prior.every((b,i)=>b.close<mean(bars.slice(bars.length-80+i,bars.length-20+i)));
}

export function buildMorningPlan({daily, news, defs = instruments, now = Date.now(), targetDate = chinaDate(now), preview = false, strongMarketOnly = true, minimumCoverage = .9, firstTradeDates = null, breakoutDays = 20, maxExtension = 8, candidateFilter = null, leaderFilter = null, diversify = null}) {
  defs = scope(defs);
  const date = targetDate, scheduledAt = stamp(date,'08:00'), deadline = stamp(date,'09:00'), cutoff = Math.min(now, deadline);
  const base = pastBars(daily.get('sh000300'), date), closeDate = base.at(-1)?.date || null;
  const sessions = base.slice(-60).map(b=>b.date);
  const alignedDates = bars => sessions.length===60 && JSON.stringify(bars.slice(-60).map(b=>b.date))===JSON.stringify(sessions);
  const previousClose = closeDate ? stamp(closeDate, '15:00') : cutoff;
  const newsWindow = morningNews(news, defs, previousClose, cutoff);
  const channels = (news?.sources || []).filter(s => s.status !== 'pending');
  const beforeCutoff = s => [...(s.recentSuccesses || []),s.lastSuccessAt].filter(t => Date.parse(t) <= cutoff).sort().at(-1);
  const healthy = channels.filter(s => {
    const t = Date.parse(beforeCutoff(s));
    return s.status === 'connected' && Number.isFinite(t) && t <= cutoff && cutoff - t <= Math.max(900000, (s.intervalSeconds || 90) * 2000);
  });
  const weekend = [0,6].includes(new Date(stamp(date,'12:00')).getUTCDay());
  const age = closeDate ? (Date.parse(date) - Date.parse(closeDate)) / 86400000 : Infinity;
  let previousWeekday = new Date(Date.parse(date) - 86400000);
  while ([0,6].includes(previousWeekday.getUTCDay())) previousWeekday = new Date(+previousWeekday - 86400000);
  const expectedClose = previousWeekday.toISOString().slice(0,10);
  const calendarUncertain = closeDate !== expectedClose;
  // Missing history for an older fund must still count against coverage.
  const coveragePool = defs.filter(d => {
    const firstTrade = firstTradeDates?.[d.symbol];
    return !d.sector.endsWith('ETF') || !firstTrade || sessions.length < 60 || firstTrade <= sessions[0];
  });
  const aligned = coveragePool.filter(d => {
    const bars = pastBars(daily.get(d.symbol),date);
    return !daily.get(d.symbol)?.stale && alignedDates(bars) && bars.at(-1)?.date === closeDate;
  });
  const marketReady = closeDate && !daily.get('sh000300')?.stale && base.length >= 60 &&
    age <= 7 && aligned.length >= Math.ceil(coveragePool.length * minimumCoverage);
  const newsReady = !news?.stale && healthy.length > 0;
  const a20 = base.length >= 20 ? mean(base.slice(-20)) : null;
  const a60 = base.length >= 60 ? mean(base.slice(-60)) : null;
  const regime = !marketReady ? 'limited' : base.at(-1).close > a20 && a20 > a60 ? 'strong' :
    base.at(-1).close < a20 && a20 < a60 ? 'weak' : 'mixed';
  const macroRisk = newsWindow.items.some(n => n.risk && (!n.links.length || n.links.some(l => ['sh000985','sh510300'].includes(l.symbol))));
  const canConsider = marketReady && newsReady && !weekend && !calendarUncertain && !macroRisk && regime !== 'weak' && (!strongMarketOnly || regime === 'strong');
  const warnings = [
    ...(!marketReady ? ['上一交易日完整日线覆盖不足或来源异常，暂停新增参与计划。'] : []),
    ...(!newsReady ? ['缺少生成前成功采集的健康消息源，消息依据未齐；只保留观察与风险条件。'] : []),
    ...(calendarUncertain ? ['收盘日期与上一工作日不一致：可能休市或行情缺失，暂停新增参与，先核对交易日历。'] : []),
    '尚未接入交易所完整休市日历；执行前必须确认当日开市。周末仅生成观察记录。',
    '消息只覆盖已接入来源实际采集的条目，不代表收盘后全部消息；隔夜海外行情未单独接入。',
    ...(newsWindow.excluded.unobserved ? [`${newsWindow.excluded.unobserved} 条消息无法证明生成前已采到，未用于计划。`] : []),
    ...(newsWindow.excluded.dateOnly ? [`${newsWindow.excluded.dateOnly} 条消息只有日期，未纳入精确隔夜窗口。`] : [])
  ];
  const items = defs.map(d => {
    const source = daily.get(d.symbol), bars = pastBars(source,date), last = bars.at(-1);
    const usable = !source?.stale && alignedDates(bars) && last?.date === closeDate;
    if (!usable) return {...d, status:'数据待补', stance:'wait', reason:'同日完整日线不足或来源异常',
      closeDate:last?.date || null, conditions:[], newsIds:[]};
    const ma5 = mean(bars.slice(-5)), ma20 = mean(bars.slice(-20)), ma60 = mean(bars.slice(-60));
    const pressure = Math.max(...bars.slice(-breakoutDays-1,-1).map(b => b.high)), support = Math.min(...bars.slice(-5).map(b => b.low));
    const extended = (last.close/ma20 - 1)*100 > maxExtension;
    const strong = last.close > ma20 && ma20 > ma60, weak = last.close < ma20 && ma20 < ma60;
    const related = newsWindow.items.filter(n => n.links.some(l => l.symbol === d.symbol));
    const veto = related.some(n => n.risk);
    const stance = !canConsider || veto || weak || extended ? 'wait' : strong ? 'conditional' : 'watch';
    const fmt = n => n.toFixed(d.sector.endsWith('ETF') ? 3 : 2);
    const basis = `收盘 ${fmt(last.close)}；MA20 ${fmt(ma20)} / MA60 ${fmt(ma60)}`;
    return {...d, closeDate, close:last.close, ma5,ma20,ma60,pressure,support,
      trend:strong?'偏强':weak?'偏弱':'分化', stance,
      status:stance === 'conditional' ? '有条件观察参与' : stance === 'watch' ? '等待日线转强' : '暂不新增',
      reason:[basis,extended?'偏离20日均线超过'+maxExtension+'%，不追高':null,veto?'关联消息触发风险词，核实前暂停新增':null,
        !newsReady?'消息依据未齐':null,strongMarketOnly&&regime==='mixed'?'沪深300趋势分化，仅观察':null,regime==='weak'?'沪深300日线偏弱':null].filter(Boolean).join('；'),
      newsIds:related.map(n => n.id), newsSummary:related.length ? `${related.length} 条关键词关联消息，需核实原文` : '暂无明确关联消息，不代表不存在影响',
      relative20:base.length>=21?(last.close/bars.at(-21).close-base.at(-1).close/base.at(-21).close)*100:null,
      conditions:[
        {label:'参与前提',text:stance==='conditional'?'仅今日关注清单启用入场检查；沪深300最新价不得低于冻结的20日均线，且标的满足下述盘中确认。':'今日不新增参与，价位只供观察与已有敞口风控；不能仅因触价转为买入，等待下一份晨间计划。'},
        {label:'开盘检查',text:`先确认交易日、最新报价及消息。若低开跌破 ${fmt(support)} 或高开超过突破观察位 ${fmt(pressure)} 的1%，暂停原参与条件，不追价。`},
        {label:'日线确认',text:'上一交易日已收盘日线仅用于盘前筛选方向，盘中不把15分钟变化当作日线趋势反转。'},
        {label:'当日入场检查',text:`已完成15分钟K线收于 ${fmt(pressure)} 上方，DIF>DEA且MACD柱为正；随后连续3个分钟采样价守住该位，最新价不超过该位的1%。这是待优化的试行规则。`},
        {label:'盘中风控',text:`${fmt(support)} 为上一收盘数据形成的风险观察位。触及或跌破时立即重新评估风险；跳空可能越过该价，不保证成交，不等待日线确认才处理风险。`}
      ], source:source.source || '已收盘日线', sourceFetchedAt:source.fetchedAt || null,
      evidence:bars.slice(-65)};
  });
  const ranked=items.filter(i=>i.sector.endsWith('ETF')&&i.trend==='偏强'&&(!candidateFilter||candidateFilter(i)))
    .sort((a,b)=>(b.stance==='conditional')-(a.stance==='conditional')||(b.relative20||0)-(a.relative20||0)||a.symbol.localeCompare(b.symbol));
  const leader=leaderFilter?ranked.find(i=>i.stance==='conditional'&&leaderFilter(i)):null;
  const candidates=diversify?diversify(ranked):leader?[leader,...ranked.filter(i=>i!==leader).slice(0,2)]:ranked.slice(0,3);
  for(const item of items){
    item.focus=candidates.some(c=>c.symbol===item.symbol);
    if(item.focus && item.stance==='conditional') item.relativeStrengthRank=candidates.indexOf(item)+1;
    if(!item.focus&&item.stance==='conditional')item.status='不在今日优先方向，仅观察';
    if(positive(item.pressure)&&positive(item.support))item.entryRule={version:'breakout-retest-v1',
      enabled:item.focus&&item.stance==='conditional',pressure:item.pressure,support:item.support,
      maxPremium:.01,retestMinutes:3,marketSymbol:'sh000300',marketFloor:a20,
      description:'15分钟收盘突破且MACD偏多，随后连续3个分钟采样价守住；报价不追高，沪深300不低于冻结MA20。'};
  }
  // Archive independently strong ETFs even when the broad-market gate blocks new orders.
  const directionCoverage=[];
  const start60=base.at(-61)?.date;
  for(const item of items){
    if(!start60||!item.sector.endsWith('ETF')||item.symbol==='sh511010')continue;
    const bars=item.evidence;
    if(bars?.at(-61)?.date!==start60)continue;
    const prior=bars.at(-61).close,prior20=bars.at(-21).close;
    if(!(prior>0&&item.close>prior&&item.close>prior20&&item.close>item.ma20))continue;
    directionCoverage.push({symbol:item.symbol,name:item.name,return60:item.close/prior-1});
  }
  directionCoverage.sort((a,b)=>b.return60-a.return60||b.symbol.localeCompare(a.symbol));
  return {id:date,date,version:1,ruleVersion:'morning-v2',directionVersion:strongMarketOnly?'strong-market-v1':'original',strategyLabel:strongMarketOnly?'强市突破观察 · 试行':'原方向筛选',scheduledAt:new Date(scheduledAt).toISOString(),
    cutoffAt:new Date(cutoff).toISOString(),generatedAt:new Date(now).toISOString(),
    preview, late:now > deadline,
    closeDate, weekend, calendarStatus:weekend?'周末观察':'当日是否开市待核对',
    status:!marketReady || !newsReady ? 'limited' : 'ready',
    summary:strongMarketOnly && regime==='mixed' ? '沪深300趋势分化，今日仅观察，不启用突破入场提醒' : !canConsider ? '先观察并控制风险，暂不新增参与' : '按日线趋势筛选，满足后续确认条件再考虑参与',
    market:{regime,close:base.at(-1)?.close || null,ma20:a20,ma60:a60,sourceDate:closeDate,
      coverage:aligned.length,total:coveragePool.length,macroRisk},
    directionCoverage:directionCoverage.slice(0,10),
    focusSymbols:candidates.map(i=>i.symbol),
    noParticipation:['不在今日关注清单或盘前计划标为观望的方向，不新增参与。',
      '开盘超过冻结突破位1%、当日触及风险位、价格追高或市场条件未通过时，观望不参与。',
      '报价过期、数据不齐、15分钟K线未完成或连续分钟验证不足时，不发入场提醒。'],
    items,news:{...newsWindow,from:closeDate?new Date(previousClose).toISOString():null,to:new Date(cutoff).toISOString(),
      sources:channels.map(s => ({id:s.id,name:s.name,lastSuccessAt:beforeCutoff(s)||null,status:s.status,eligible:healthy.some(h=>h.id===s.id)}))},
    warnings,executionNote:'计划仅描述条件，不执行交易。日线确认与盘中风控分别处理；盘中建议变化不会覆盖此留档。'};
}

export function createMorningPlanner({getDaily,getNews,positions,getEvents,getWeakWatchFactors,defs = instruments,now = Date.now,
  file = new URL('./data/morning-plans.json',import.meta.url)} = {}) {
  const store = createResearchStore(file,{version:1,records:[]});
  const jobs=new Map();
  function actualHoldings(records){
    const latest=new Map(records.map(r=>[r.symbol,r]));
    return [...latest.values()].filter(r=>r.quantity>0);
  }
  let timer, lastError = null;
  async function generate(preview = false, next = false) {
    const started=now();let date=chinaDate(started);
    if(next){
      if(started<stamp(date,'15:05'))throw Error('请等待收盘日线更新');
      const day=new Date(date+'T00:00:00Z');
      do{day.setUTCDate(day.getUTCDate()+1);}while([0,6].includes(day.getUTCDay()));
      date=day.toISOString().slice(0,10);
    }
    if(!preview && jobs.has(date))return jobs.get(date);
    const job = (async () => {
      const saved = await store.read(), old = saved.records.find(r=>r.date===date);
      if (!preview && old) return old;
      if (!preview && started > stamp(date,'09:00')) throw Error('已过09:00启动截止时间，当天只可查看留档');
      if(positions&&!preview&&(next||started<morningCutoff(started)))throw Error('请在当天08:00后确认实际持仓');
      const ledger=positions?await positions.read():null;
      if(ledger&&!preview&&ledger.confirmedDate!==date&&started<stamp(date,'08:55'))throw Error('等待确认当前持仓，08:55自动沿用已登记份额');
      // Snapshot news first: later fetches cannot enter this run's evidence window.
      const news = structuredClone(await getNews()), daily = new Map(), list = scope(defs);
      const retired=new Set();
      const occupiedThemes=new Set();
      if(ledger)for(const h of actualHoldings(ledger.records)){
        if(list.some(i=>i.symbol===h.symbol))continue;
        const d=instrumentCatalog.find(i=>i.symbol===h.symbol);
        if(d){list.push(d);retired.add(d.symbol);occupiedThemes.add(d.theme);}
      }
      let cursor = 0;
      await Promise.all(Array.from({length:Math.min(4,list.length)},async()=>{
        while(cursor<list.length){const d=list[cursor++];try{daily.set(d.symbol,await getDaily(d.symbol));}
          catch{daily.set(d.symbol,{stale:true,bars:[]});}}
      }));
      const plan = buildMorningPlan({daily,news,defs:list,candidateFilter:item=>!retired.has(item.symbol)&&!occupiedThemes.has(item.theme)&&!item.name.includes('国债'),firstTradeDates:firstTradeHistory,now:started,targetDate:date,preview});
      if(ledger){
        const actual=actualHoldings(ledger.records);
        plan.holdings=holdingPlan({...plan,cutoffAt:new Date(started).toISOString()},actual,[],saved.records,'half20',1,'strict');
        const latest=new Map(),reduced=new Set();
        for(const record of ledger.records){
          const previous=latest.get(record.symbol)??0;
          if(record.quantity===0)reduced.delete(record.symbol);
          else if(record.quantity<previous)reduced.add(record.symbol);
          latest.set(record.symbol,record.quantity);
        }
        for(const h of plan.holdings){
          if(reduced.has(h.symbol)&&h.action==='条件加仓'){
            h.action='持有';
            h.reason='本轮持仓已登记减仓，余仓按原减仓和清仓规则管理。';
          }
        }
        plan.positionSnapshot=actual.map(({symbol,quantity})=>({symbol,quantity}));
      }
      plan.sizing={currency:'CNY',commissionRate:0.0003,totalBudget:150000,cashReserve:0,minimumTradeAmount:30000,initialAmounts:[33300,33300,33300]};
      // Keep the original instruction while a weak spell persists. Once a reduction
      // of the requested size is confirmed, later mornings must not halve it again.
      const previous=saved.records.find(p=>p.date<plan.date);
      for(const h of plan.holdings||[]){
        if(h.action!=='减仓'||h.mode!=='已确认持仓')continue;
        const prior=previous?.holdings?.find(x=>x.symbol===h.symbol&&x.mode===h.mode);
        const sameSpell=prior?.trimBaseQuantity>0 && h.quantity<=prior.quantity;
        h.trimBaseQuantity=sameSpell?prior.trimBaseQuantity:h.quantity;
        h.remainingSellQuantity=Math.max(0,h.quantity-Math.ceil(h.trimBaseQuantity/2));
        if(!h.remainingSellQuantity){
          h.action='持有';h.reason='本段弱势的减仓目标已达到，剩余仓位继续跟踪。';
        }
      }
      const bond='sh511010',marketBars=pastBars(daily.get('sh000300'),date);
      let riskOn=previous?.defensiveSwitch?.riskOn??false;
      let weakSignal=previous?.defensiveSwitch?.weakSignal;
      for(let i=20;i<marketBars.length;i++){
        if(previous?.defensiveSwitch&&(previous.defensiveSwitch.riskOn||previous.defensiveSwitch.weakSignal)&&marketBars[i].date<=previous.closeDate)continue;
        const close=marketBars[i].close,avg=mean(marketBars.slice(i-19,i+1)),prior=marketBars[i-20].close;
        if(close>avg&&close>prior)riskOn=true;
        if(close<avg&&close<prior){
          if(riskOn||!weakSignal)weakSignal=marketBars[i].date;
          riskOn=false;
        }
      }
      plan.defensiveSwitch={riskOn,symbol:bond,budget:0};
      plan.weakMarketWatch=riskOn?[]:['sh512800','sh515220','sh515450'].map(symbol=>{
        const item=plan.items.find(candidate=>candidate.symbol===symbol);
        return {symbol,name:item?.name??null,closeDate:item?.closeDate??null,
          relative20:Number.isFinite(item?.relative20)?item.relative20:null,
          aboveMA20:item?.close>0&&item?.ma20>0?item.close>item.ma20:null};
      });
      if(plan.weakMarketWatch.length&&plan.closeDate&&getWeakWatchFactors){
        let factors=new Map();
        try{factors=await getWeakWatchFactors(weakSignal??plan.closeDate);}catch{/* Reference data is optional. */}
        for(const item of plan.weakMarketWatch)item.pentad=factors.get(item.symbol)??null;
      }
      const defenseHeld=plan.holdings?.find(h=>ledger?.records.findLast(r=>r.symbol===h.symbol)?.weakDefense);
      if(!riskOn){
        const complete=plan.weakMarketWatch.every(x=>Number.isFinite(x.pentad?.rank));
        const winner=complete?[...plan.weakMarketWatch].sort((a,b)=>a.pentad.rank-b.pentad.rank)[0].symbol:'sh515450';
        const priorChoice=previous?.defensiveSwitch;
        plan.defensiveSwitch.weakSignal=weakSignal??plan.closeDate;
        plan.defensiveSwitch.choice=defenseHeld?.symbol??(priorChoice?.weakSignal===plan.defensiveSwitch.weakSignal?priorChoice?.choice:null)??winner;
      }
      const bounce=ledger?.records.findLast(r=>r.symbol==='sh510300');
      if(bounce?.bounce&&bounce.quantity>0){
        const h=plan.holdings.find(x=>x.symbol===bounce.symbol),item=plan.items.find(x=>x.symbol===bounce.symbol);
        if(item?.entryRule)item.entryRule.enabled=false;
        if(h){
          const bars=marketBars.filter(b=>b.date>=bounce.entryDate);
          const signal=marketBars.findLast(b=>b.date<bounce.entryDate);
          const last=marketBars.at(-1);
          delete h.trimBaseQuantity;
          h.action='待核实';h.reason='反弹试仓行情或建仓资料待核实。';
          if(plan.status==='ready'&&!plan.weekend&&!plan.late&&signal?.low>0&&bars.length&&last.date===plan.closeDate&&bars[0].date===bounce.entryDate&&item?.close>0&&bounce.firstFillPrice>0){
            const stalled=item.close*(1-plan.sizing.commissionRate)<=bounce.firstFillPrice*(1+plan.sizing.commissionRate);
            const halfLots=Math.floor(bounce.initialQuantity/200)*100;
            const remaining=Math.max(0,h.quantity-(bounce.initialQuantity-halfLots));
            if(bars.length>=5||last.close<signal.low||(stalled&&remaining===0&&halfLots>0)){
              h.action='清仓';h.reason='反弹试仓到期、失守信号低点或减半后再次没有扣费浮盈。';
            }else if(stalled&&bars.length===1&&riskOn&&plan.market.regime!=='strong'&&
              (h.breadthToday=bounceBreadth(daily,defs,marketBars,0))!==null&&
              (h.breadthFiveDaysAgo=bounceBreadth(daily,defs,marketBars,5))!==null&&
              h.breadthToday>=0.5&&h.breadthToday>h.breadthFiveDaysAgo){
              h.action='持有';h.reason='反弹首日处于转强过渡期，广度至少50%且高于五日前，宽限一个交易日。';
              delete h.remainingSellQuantity;
            }else if(stalled&&halfLots===0){
              h.action='清仓';h.reason='试仓份额不足以整手减半，全数退出。';
            }else if(stalled&&remaining>0){
              h.action='减仓';h.remainingSellQuantity=remaining;h.reason='反弹试仓收盘没有扣费浮盈，次日开盘减半。';
            }else {h.action='持有';h.reason='反弹试仓继续跟踪。';}
          }
        }
      }
      const bondItem=plan.items.find(i=>i.symbol===bond);
      const bondHolding=plan.holdings?.find(h=>h.symbol===bond);
      const marketUsable=marketBars.length>=21&&!daily.get('sh000300')?.stale&&!plan.weekend&&!plan.late&&
        !plan.warnings.some(w=>w.includes('收盘日期与上一工作日不一致'));
      if(bondItem?.entryRule)bondItem.entryRule.enabled=false;
      if(bondHolding){
        bondHolding.action=riskOn&&marketUsable?'清仓':'持有';
        bondHolding.reason=riskOn?'大盘转好，释放国债仓位。':'维持防守仓位。';
      }
      for(const i of plan.items){
        if(!riskOn&&i.entryRule)i.entryRule.enabled=false;
      }
      for(const h of plan.holdings||[]){
        if(h.action!=='条件加仓')continue;
        const basis=ledger?.records.findLast(r=>r.symbol===h.symbol)?.firstFillPrice;
        const item=plan.items.find(i=>i.symbol===h.symbol);
        if(!riskOn||!(basis>0)){
          h.action='持有';h.reason=riskOn?'补登记首次成交价后才能判断加仓浮盈。':'防守期暂停加仓。';
          if(item?.entryRule)item.entryRule.enabled=false;
        }else if(item?.entryRule){
          item.entryRule.profitFloor=basis*(1+plan.sizing.commissionRate)/(1-plan.sizing.commissionRate);
        }
      }
      const red=defenseHeld?.symbol??plan.defensiveSwitch.choice??'sh515450',index='sh510300';
      const redHolding=plan.holdings?.find(h=>h.symbol===red);
      const redRecord=ledger?.records.findLast(r=>r.symbol===red);
      if(redHolding&&redRecord?.weakDefense){
        redHolding.action=marketUsable&&riskOn?'清仓':'持有';
        redHolding.reason=riskOn?'大盘转强，退出弱市防守仓。':'弱市继续持有本轮防守ETF。';
        const item=plan.items.find(i=>i.symbol===red);
        if(item?.entryRule)item.entryRule.enabled=false;
      }
      for(const h of plan.holdings||[]){
        if(h.action!=='减仓'&&h.action!=='清仓')continue;
        const wanted=h.action==='清仓'?h.quantity:(h.remainingSellQuantity??h.quantity/2);
        const quantity=h.action==='清仓'?wanted:Math.floor(wanted/100)*100;
        if(!(h.close>0&&h.quantity>0)){
          h.action='待核实';h.reason='卖出数量或价格待核实。';
        }else if(h.action==='清仓'||(h.quantity-quantity)*h.close<plan.sizing.minimumTradeAmount){
          h.action='清仓';h.orderQuantity=h.quantity;
          if(quantity<h.quantity)h.reason='减仓后余仓不足3万元，开盘全数退出。';
          delete h.remainingSellQuantity;
        }else if(quantity*h.close<plan.sizing.minimumTradeAmount){
          h.action='持有';h.reason='普通减仓金额不足3万元，暂停操作。';
        }else{
          h.orderQuantity=quantity;h.remainingSellQuantity=quantity;
        }
      }
      const holdings=new Map((plan.holdings||[]).map(h=>[h.symbol,h]));
      const afterBondSale=bondHolding?.action==='清仓';
      const fundedHoldings=(plan.holdings||[]).filter(h=>!afterBondSale||h.symbol!==bond);
      const occupied=new Set(fundedHoldings.map(h=>h.symbol));
      const openingOrders=[];
      let free=plan.sizing.totalBudget-fundedHoldings.reduce((sum,h)=>sum+(h.quantity>0&&h.close>0?h.quantity*h.close:Infinity),0);
      if(ledger&&marketUsable&&plan.status==='ready'&&!plan.market.macroRisk){
        const offers=[];
        if(prolongedWeakBounce(marketBars))offers.push([index,33300,'反弹试仓']);
        if(!riskOn)offers.push([red,60000,'弱市防守']);
        for(const [symbol,limit,mode] of offers){
          if(occupied.size>=positionLimit||occupied.has(symbol))continue;
          const item=plan.items.find(i=>i.symbol===symbol);
          if(occupiedThemes.has(item?.theme)||!(item?.close>0)||item.closeDate!==plan.closeDate||
            plan.news.items.some(n=>n.risk&&item.newsIds.includes(n.id)))continue;
          const budget=Math.min(limit,Math.floor(free/(1+plan.sizing.commissionRate)));
          const lots=Math.floor(budget/(100*item.close));
          if(lots*100*item.close<plan.sizing.minimumTradeAmount)continue;
          occupied.add(symbol);
          free-=budget*(1+plan.sizing.commissionRate);
          if(item.entryRule)item.entryRule.enabled=false;
          openingOrders.push({symbol,name:item.name,mode,rank:null,budget,instruction:
            mode+'：开盘按整手买入，上限 '+budget.toLocaleString('en-US')+' 元，成交额至少30,000元'});
        }
      }
      plan.openingOrders=openingOrders;
      const openingReserve=openingOrders.reduce((sum,o)=>sum+o.budget*(1+plan.sizing.commissionRate),0);
      const allowed=allowedSymbols(plan,occupied);
      if(afterBondSale)plan.defensiveSwitch.requireSaleBeforeEntry=true;
      plan.positionLimit=positionLimit;
      for(const item of plan.items)if(item.entryRule?.enabled&&!allowed.has(item.symbol)){
        item.entryRule.enabled=false;
        if(!holdings.has(item.symbol))item.status='持仓名额已分配，仅观察';
      }
      const involved=new Set([...occupied,...allowed]);
      plan.sizing.addTargetAmount=Math.floor(plan.sizing.totalBudget/Math.max(2,involved.size)/100)*100;
      const amounts=allocateBudget(plan,fundedHoldings,plan.sizing.initialAmounts,plan.sizing.addTargetAmount,plan.sizing.totalBudget,plan.sizing.cashReserve+openingReserve,plan.sizing.commissionRate);
      applyEntryCrowding(plan,holdings,amounts);
      for(const [symbol,budget] of amounts){
        const item=plan.items.find(i=>i.symbol===symbol);
        item.entryRule.orderBudget=budget;
        item.entryRule.minimumTradeAmount=plan.sizing.minimumTradeAmount;
      }
      plan.operations=reserveOperations(plan,amounts);
      for(const symbol of amounts.keys())if(!plan.operations.buys.includes(symbol)){
        amounts.delete(symbol);
        const item=plan.items.find(i=>i.symbol===symbol);
        item.status='当日操作名额已排满';
        const h=holdings.get(symbol);
        if(h){h.action='持有';h.reason=item.status;}
      }
      for(const i of plan.items)if(i.entryRule?.enabled&&!amounts.has(i.symbol)){
        i.entryRule.enabled=false;
        const h=holdings.get(i.symbol);
        if(h?.action==='条件加仓'){h.action='持有';h.reason='已达目标或持仓金额待核实，今天不追加资金。';}
      }
      plan.allocations=plan.items.filter(i=>i.focus||holdings.has(i.symbol)).map(i=>{
        const h=holdings.get(i.symbol),active=i.entryRule?.enabled&&!plan.late&&!plan.preview;
        const value=h?.quantity>0 && i.close>0 ? Math.round(h.quantity*i.close) : null;
        let instruction=i.status==='持仓名额已分配，仅观察'?'名额已分配，新增 0 元':'新增 0 元';
        if(h?.action==='清仓')instruction='清仓至 0 元'+(value===null?'':'，按昨收估算卖出约 '+value+' 元');
        else if(h?.action==='减仓'&&bounce?.bounce&&i.symbol===bounce.symbol)instruction='反弹试仓减半，开盘卖出 '+h.remainingSellQuantity+' 份，按昨收约 '+Math.round(h.remainingSellQuantity*i.close)+' 元';
        else if(h?.action==='减仓')instruction='同一段弱势首次减半'+(value===null?'，金额待确认持仓份额':'，按昨收估算卖出约 '+Math.round((h.remainingSellQuantity??h.quantity/2)*i.close)+' 元')+'；已减则维持';
        else if(h?.action==='条件加仓'&&active)instruction='再次确认后且首仓扣费浮盈时最多加 '+amounts.get(i.symbol).toLocaleString('en-US')+' 元，按实时持仓核算，含费用总投入最多 '+plan.sizing.totalBudget.toLocaleString('en-US')+' 元';
        else if(h)instruction='维持已有仓位，新增 0 元';
        else if(active)instruction='首次确认后最多买入 '+amounts.get(i.symbol).toLocaleString('en-US')+' 元，含费用总投入最多 '+plan.sizing.totalBudget.toLocaleString('en-US')+' 元';
        if(h?.action==='清仓'&&h.orderQuantity)instruction+='，全卖 '+h.orderQuantity+' 份';
        if(h?.action==='减仓'&&h.orderQuantity)instruction+='；按开盘价复核：余仓不足30,000元则全卖，否则本次卖出须满30,000元';
        if(active&&amounts.has(i.symbol))instruction+='；整手成交额须满30,000元';
        return {symbol:i.symbol,name:i.name,rank:i.relativeStrengthRank||null,mode:h?.mode||'新方向',instruction};
      }).sort((a,b)=>(a.rank??99)-(b.rank??99));
      plan.allocations=[...openingOrders,...plan.allocations.filter(a=>!openingOrders.some(o=>o.symbol===a.symbol))];
      plan.operations.buys.push(...openingOrders.map(o=>o.symbol));
      if(afterBondSale)for(const row of plan.allocations)if(amounts.has(row.symbol)||openingOrders.includes(row))row.instruction+='（须先确认511010已清仓）';
      if (plan.preview) return plan;
      let frozen;
      await store.update(state=>{
        frozen = state.records.find(r=>r.date===date);
        if (frozen) return state;
        frozen = plan;
        return {...state,records:[plan,...state.records].sort((a,b)=>b.date.localeCompare(a.date))};
      });
      return frozen;
    })();
    if (preview) return job;
    jobs.set(date,job);
    try { const result=await job;lastError=null;return result; }
    catch(error){lastError=error.message;throw error;}
    finally{jobs.delete(date);}
  }
  async function tick(){const t=now();if(t<morningCutoff(t)||t>stamp(chinaDate(t),'09:00'))return;
    if(positions&&t<stamp(chinaDate(t),'08:55')&&(await positions.read()).confirmedDate!==chinaDate(t))return;
    await generate();}
  return {generate,read:()=>store.read(),tick,
    state:()=>({running:jobs.size>0,lastError,timeZone:'Asia/Shanghai',schedule:'08:00确认持仓后生成，08:55自动沿用已登记持仓',requires:'电脑唤醒且本地服务运行'}),
    start(){const run=()=>void tick().catch(e=>console.error('晨间计划：'+e.message));run();timer=setInterval(run,15000);timer.unref();},
    stop(){clearInterval(timer);}};
}

export function createMorningHandler(planner, now = Date.now, positions) {
  return async(req,res,url)=>{
    if(!/^\/api\/morning-plan(?:\/|$)/.test(url.pathname))return false;
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    if(!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(req.headers.host||'')||
      req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin&&req.headers.origin!=='http://'+req.headers.host)){
      send(403,{error:'仅允许当前本地工作台访问计划'});return true;}
    try{
      if(positions&&url.pathname==='/api/morning-plan/confirm'&&req.method==='POST'){
        const t=now(),date=chinaDate(t);
        if(t<morningCutoff(t)||t>stamp(date,'09:00')){send(400,{error:'请在08:00至09:00确认持仓'});return true;}
        await positions.update(s=>({...s,confirmedDate:date}));
        send(200,{plan:await planner.generate()});
      }else if(positions && url.pathname==='/api/morning-plan/position' && req.method==='POST'){
        const symbol=url.searchParams.get('symbol'),raw=url.searchParams.get('quantity');
        const byValue=url.searchParams.has('marketValue');
        const valueText=url.searchParams.get('marketValue'),priceText=url.searchParams.get('price');
        const marketValue=Number(valueText),price=Number(priceText);
        const quantity=byValue?(marketValue===0?0:Math.round(marketValue/price)):Number(raw);
        const validInput=byValue?(/^\d+(?:\.\d{1,2})?$/.test(valueText)&&Number.isFinite(marketValue)&&
          (marketValue===0||(price>0&&Number.isFinite(price)&&quantity>0))):/^\d{1,10}$/.test(raw||'');
        if(!instrumentCatalog.some(i=>i.symbol===symbol&&i.sector.endsWith('ETF'))||!validInput||
          !Number.isSafeInteger(quantity)||quantity>9999999999){
          send(400,{error:'请选择 ETF，填写有效市值和对应单价；清仓只填市值 0'});return true;
        }
        const entry={symbol,quantity,...(byValue?{marketValue,price:marketValue?price:null}:{})};
        const firstFill=url.searchParams.get('firstFillPrice');
        if(firstFill!==null&&!(Number.isFinite(Number(firstFill))&&Number(firstFill)>0)){send(400,{error:'首次成交价必须大于零'});return true;}
        const at=now(),today=chinaDate(at);
        const supplied=url.searchParams.get('entryDate');
        if(supplied&&(!validDate(supplied)||supplied>today)){send(400,{error:'请填写实际首次建仓日期'});return true;}
        const date=supplied||(at>=stamp(today,'09:30')?today:null);
        const frozen=date?(await planner.read()).records.find(p=>p.date===date&&!p.preview&&!p.late):null;
        const support=frozen?.items?.find(i=>i.symbol===symbol)?.support;
        await positions.update(s=>{
          const old=s.records.findLast(r=>r.symbol===symbol);
          if(quantity>0){
            const opening=!old?.quantity&&frozen?.openingOrders?.find(o=>o.symbol===symbol);
            if(opening?.mode==='弱市防守'||old?.quantity>0&&old.weakDefense)entry.weakDefense=true;
            if(opening?.mode==='反弹试仓'||url.searchParams.get('bounce')==='1'||old?.quantity>0&&old.bounce){
              if(symbol!=='sh510300')throw Error('反弹试仓仅用于510300');
              const basis=firstFill!==null?Number(firstFill):old?.quantity>0?old.firstFillPrice:null;
              const since=old?.quantity>0&&old.entryDate||date;
              if(!(basis>0)||!since)throw Error('请填写反弹试仓首次成交价和实际建仓日');
              entry.bounce=true;entry.initialQuantity=old?.quantity>0?(old.initialQuantity??old.quantity):quantity;entry.entryDate=since;
            }
            entry.firstFillPrice=firstFill!==null?Number(firstFill):old?.quantity>0?old.firstFillPrice:null;
            if(old?.quantity>0&&old.entrySupport>0){
              entry.entrySupport=old.entrySupport;entry.entryDate=old.entryDate;
            }else if((supplied||!old?.quantity)&&date&&support>0){
              entry.entrySupport=support;entry.entryDate=date;
            }
          }
          return {...s,records:[...s.records,{...entry,at:new Date(at).toISOString()}]};
        });
        send(200,entry);
      }else if(url.pathname==='/api/morning-plan'&&req.method==='GET'){
        const date=url.searchParams.get('date')||chinaDate(now());if(!validDate(date))throw Error('日期无效');
        const saved=await planner.read();
        const balances=new Map((positions?(await positions.read()).records:[]).map(r=>[r.symbol,r.quantity]));
        send(200,{actualPositions:[...balances].filter(([,q])=>q>0),plan:saved.records.find(r=>r.date===date)||null,
          dates:saved.records.map(r=>r.date),today:chinaDate(now()),scheduler:planner.state()});
      }else if(req.method==='POST'&&['/api/morning-plan/run','/api/morning-plan/next','/api/morning-plan/preview'].includes(url.pathname)){
        send(200,{plan:await planner.generate(url.pathname.endsWith('/preview'),url.pathname.endsWith('/next')),scheduler:planner.state()});
      }else send(405,{error:'不支持此操作'});
    }catch(error){send(/日期无效|请等待收盘|启动截止时间/.test(error.message)?400:503,{error:error.message});}
    return true;
  };
}

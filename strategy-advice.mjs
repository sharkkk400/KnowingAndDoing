import {createResearchStore, chinaDate, validDate} from './research-store.mjs';
import {opportunityPriority} from './dist/opportunity-priority.js';

const positive = n => Number.isFinite(n) && n > 0;
const modes = {defensive:'defend', index_divergence:'defend', fragile:'defend', cooling:'wait',
  broad_repair:'broad', selective:'selective', rotation:'selective', balanced:'wait'};
const modeNames = {defend:'收缩风险', wait:'等待确认', broad:'分批参与强势回踩', selective:'精选回踩'};
const clock = now => new Date(now + 8 * 3600000).toISOString().slice(11, 16);
const stamp = (date, time) => Date.parse(`${date}T${time}:00+08:00`);
const unavailable = reason => ({ready:false, reason, items:[], change:null});
const planKey = item => item.planId || `${item.symbol}|${item.signalDate}`;
const priceText = n => n.toFixed(3);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A historical close stays attached to its source date. It never becomes today's signal.
export function buildStrategySnapshot(daily, result, market, previous = null, now = Date.now()) {
  const ranked = opportunityPriority(daily), today = chinaDate(now);
  if (!ranked.ready || daily.tracking?.error) return unavailable(ranked.reason || '候选跟踪待更新');
  if (!validDate(market?.date) || !/^(09|10|11|13|14|15):[0-5]\d$/.test(market?.time || '') ||
      !modes[market.regime] || result?.stale || !Array.isArray(result?.quotes))
    return unavailable('市场或报价依据未齐，暂不更新策略比较');
  const {date, time} = market, cutoff = stamp(date, time), wall = clock(now);
  const closing = date < today || (date === today && wall >= '15:05');
  const reference = closing ? stamp(date, '15:00') :
    wall >= '11:30' && wall < '13:00' ? stamp(date, '11:30') : now;
  if (date > today || cutoff > now + 60000 || reference - cutoff > 180000 ||
      !(time >= '09:30' && time <= '11:30' || time >= '13:00' && time <= '15:00') ||
      (closing && time !== '15:00') || daily.date > date ||
      (daily.date === date && (!closing || time !== '15:00')) ||
      (date < today && daily.date !== date))
    return unavailable('候选与当前交易截止时刻未对齐，暂不更新策略比较');
  if (previous && cutoff < stamp(previous.date, previous.time))
    return unavailable('收到较早行情，保留上次计划');
  const quotes = new Map(result.quotes.map(q => [q.symbol, q]));
  const validQuote = q => {
    const at = Date.parse(q?.quoteTime);
    return positive(q?.price) && positive(q?.prev) && typeof q.quoteTime === 'string' && q.quoteTime.slice(0, 10) === date &&
      Number.isFinite(at) && at <= now + 60000 &&
      (closing ? q.quoteTime.slice(11, 16) >= '15:00' : Math.abs(at - cutoff) <= 180000);
  };
  const benchmark = quotes.get('sh000300'), whole = quotes.get('sh000985');
  if (!validQuote(benchmark) || !validQuote(whole) || !positive(daily.benchmarkClose) ||
      Math.abs((daily.date === date ? benchmark.price : benchmark.prev) / daily.benchmarkClose - 1) > .002)
    return unavailable('日线基准与报价不一致，等待补齐或核实价格口径');
  const needed = [...ranked.items, ...(previous?.items || [])];
  if (needed.some(item => !validQuote(quotes.get(item.symbol))))
    return unavailable('候选或原计划报价缺失，暂不更新排序与比较');
  if (needed.some(item => previous?.quoteTimes?.[item.symbol] &&
      Date.parse(quotes.get(item.symbol).quoteTime) < Date.parse(previous.quoteTimes[item.symbol])))
    return unavailable('收到较早标的报价，保留上次计划');
  if (ranked.items.some(item => Math.abs((daily.date === date ? quotes.get(item.symbol).price :
      quotes.get(item.symbol).prev) / item.close - 1) > .002))
    return unavailable('候选日线与报价口径未对齐，暂停比较');

  const items = ranked.items.map(item => {
    const old = previous?.plans?.[planKey(item)] || previous?.items.find(p => planKey(p) === planKey(item));
    // Untracked candidates get a dated identity; a new daily plan is never a stage upgrade of an old one.
    return {...item, planId:planKey(item), resistance:old?.resistance || item.resistance,
      invalidation:old?.invalidation || item.invalidation,
      referencePrice:old?.referencePrice || quotes.get(item.symbol).price};
  });
  const risks = {...previous?.risks};
  const monitored = new Map([...items, ...(previous?.items || [])].map(item => [planKey(item), item]));
  for (const [id, item] of monitored) {
    const q = quotes.get(item.symbol), priorRisk = previous?.risks?.[id];
    // Preserve a break for this plan even if a later refresh has bounced back.
    let risk = priorRisk === 'broken' ? 'broken' : 'clear';
    const isLater = previous && Date.parse(q.quoteTime) > Date.parse(previous.quoteTimes?.[item.symbol]);
    if (q.price < item.invalidation) risk = 'broken';
    else if (risk !== 'broken' && item.stage === 'breakout' && q.price > item.resistance * 1.01 &&
        (priorRisk === 'crossed' || (isLater && item.referencePrice <= item.resistance))) risk = 'crossed';
    const originalDistance = (item.referencePrice / item.invalidation - 1) * 100;
    const distance = (q.price / item.invalidation - 1) * 100;
    if (risk === 'clear' && isLater && distance >= 5 && distance - originalDistance >= 2 &&
        distance >= originalDistance * 1.5) risk = 'stretched';
    risks[id] = risk;
  }
  for (const item of items) if (risks[item.planId] === 'broken') {
    Object.assign(item, {stage:'waiting', priority:0, waiting:true, gate:'原失效位已跌破，等待新计划',
      label:'原计划暂停', reason:'原失效位已跌破，等待新计划'});
  }
  items.sort((a,b) => b.priority-a.priority || b.scoreBucket-a.scoreBucket || a.symbol.localeCompare(b.symbol));
  // Incumbents keep their place when same-stage scores differ by less than 0.5 pp.
  for (let rank = 0; rank < Math.min(3, previous?.items.length || 0); rank++) {
    const index = items.findIndex(i => i.symbol === previous.items[rank].symbol);
    if (index > rank && items[index].priority === items[rank].priority &&
        Math.abs(items[index].score - items[rank].score) < .5) {
      items.splice(rank, 0, items.splice(index, 1)[0]);
    }
  }
  return {ready:true, date, time, dailyDate:daily.date, mode:modes[market.regime],
    items:items.slice(0,3), risks, prices:Object.fromEntries(needed.map(i => [i.symbol, quotes.get(i.symbol).price])),
    plans:{...previous?.plans, ...Object.fromEntries(items.map(i => [i.planId, {
      resistance:i.resistance, invalidation:i.invalidation, referencePrice:i.referencePrice}]))},
    quoteTimes:Object.fromEntries(needed.map(i => [i.symbol, quotes.get(i.symbol).quoteTime])),
    tracked:(daily.tracking?.items || []).map(p => ({id:p.id, stage:p.stage, asOf:p.asOf, blocked:p.blocked})),
    reason:ranked.reason};
}

export function strategyChange(previous, current) {
  if (!previous) return null;
  const notice = (kind, text) => ({kind, text, date:current.date, time:current.time});
  for (const old of previous.items) {
    const id = planKey(old), risk = current.risks[id], prior = previous.risks[id];
    const tracked = current.tracked.find(t => t.id === id && !t.blocked);
    if ((risk === 'broken' && prior !== 'broken') || (tracked?.stage === 'invalid' &&
        previous.tracked.find(t => t.id === id)?.stage !== 'invalid'))
      return notice('plan_invalid', `${old.name}已跌破原失效位 ${priceText(old.invalidation)}，暂停原参与计划；反弹后也需重新确认。`);
    if (tracked?.stage === 'expired' && previous.tracked.find(t => t.id === id)?.stage !== 'expired')
      return notice('plan_expired', `${old.name}原计划观察期已结束，停止沿用 ${old.signalDate} 的参与条件。`);
  }
  if (current.mode !== previous.mode)
    return notice('market_plan', `市场计划由「${modeNames[previous.mode]}」转为「${modeNames[current.mode]}」；${
      current.mode === 'defend' || current.mode === 'wait' ? '原参与安排先暂停，等待条件恢复。' : '先核对候选自身条件，再按新计划观察。'}`);
  for (const old of previous.items) {
    const id = planKey(old), risk = current.risks[id], next = current.items.find(i => i.planId === id);
    if (risk === 'crossed' && previous.risks[id] !== risk)
      return notice('entry_moved', `${old.name}曾高于原突破观察价 ${priceText(old.resistance)} 超过1%，等待回踩与收盘确认，不直接沿用原价追入。`);
    if (risk === 'stretched' && previous.risks[id] !== risk)
      return notice('risk_distance', `${old.name}距原失效位 ${priceText(old.invalidation)} 曾明显扩大，先重新评估参与位置。`);
    if (next && next.stage !== old.stage)
      return notice('plan_stage', `${old.name}原计划由「${old.label}」变为「${next.label}」；${next.reason}。`);
  }
  const before = previous.items.map(i => i.symbol).slice(0,2), after = current.items.map(i => i.symbol).slice(0,2);
  if (!same(before, after)) {
    if (!current.items.length) return notice('priority', '原优先方向已退出本轮合格候选，暂不沿用上次排序。');
    return notice('priority', `候选观察顺序调整为${current.items.slice(0,2).map(i => i.name).join(' → ')}，依据确认阶段与相对强度。`);
  }
  for (const item of current.items) {
    const old = previous.items.find(i => i.symbol === item.symbol);
    if (old && old.planId !== item.planId)
      return notice('new_plan', `${item.name}已生成 ${item.signalDate} 的新观察计划，重新核对价位与确认条件。`);
  }
  return null;
}

const fingerprint = s => JSON.stringify([s.date, s.dailyDate, s.mode,
  s.items.map(i => [i.symbol,i.planId,i.stage,i.gate,i.resistance,i.invalidation]), s.risks,
  s.tracked.map(t => [t.id,t.stage,t.blocked])]);

export function createStrategyAdvisor(file = new URL('./data/strategy-advice.json', import.meta.url)) {
  const store = createResearchStore(file, {version:1, records:[], current:null, change:null});
  return {
    read:() => store.read(),
    async observe(daily, quotes, market, now = Date.now()) {
      let response;
      await store.update(state => {
        const next = buildStrategySnapshot(daily, quotes, market, state.current, now);
        if (!next.ready) { response = next; return state; }
        const change = strategyChange(state.current, next);
        const retained = change || (state.change?.date === next.date ? state.change : null);
        response = {...next, change:retained, baselineCreated:!state.current};
        if (state.current && fingerprint(state.current) === fingerprint(next))
          return {...state, current:next, change:retained};
        // Frozen observations are separate from the immutable forecast archive.
        return {version:1, current:next, change:retained, records:[...state.records,
          {...next, change, observedAt:new Date(now).toISOString()}].slice(-200)};
      });
      return response;
    }
  };
}

export function createStrategyHandler({advisor, getDaily, getQuotes, now = Date.now}) {
  return async (req, res, url) => {
    if (url.pathname !== '/api/strategy-advice') return false;
    const send = (status, data) => {res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(req.headers.host || '') ||
        req.headers['sec-fetch-site'] === 'cross-site' ||
        (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host)) {
      send(403, {error:'仅允许当前工作台更新策略记录'}); return true;
    }
    if (req.method !== 'POST') {send(405,{error:'此地址仅接收策略观察'});return true;}
    try {
      let body = '';
      for await (const chunk of req) {body += chunk; if (body.length > 2048) throw Error('请求过大');}
      const market = JSON.parse(body);
      if (!validDate(market?.date) || !modes[market.regime] || typeof market.time !== 'string')
        throw Error('无效市场计划');
      const [daily, quotes] = await Promise.all([getDaily(), getQuotes()]);
      send(200, await advisor.observe(daily, quotes, market, now()));
    } catch (error) {send(503, {ready:false, items:[], change:null, error:'策略比较暂不可用，已保留上次记录'});}
    return true;
  };
}

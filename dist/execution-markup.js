import {morningMarkup} from './morning-markup.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock=t=>t?new Date(t).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—';
const price=(n,i)=>Number.isFinite(n)?n.toFixed(i.sector?.endsWith('ETF')?3:2):'—';
export function compactStrategyMarkup(plan){
 if(!plan)return '<p class="strategy-line">今日策略待生成</p>';
 const actions=(plan.allocations||[]).filter(a=>/^(弱市防守：|反弹试仓：|反弹试仓减半|国债切换|首次确认后|再次确认后|清仓至|同一段弱势首次减半)/.test(a.instruction));
 if(!actions.length)return '<p class="strategy-line">今日不买，新增 0 元</p>';
 return actions.map(a=>'<p class="strategy-line"><strong>'+esc(a.name)+' '+esc(a.symbol.slice(2))+'</strong> · '+esc(a.instruction)+'</p>').join('');
}
export function morningDecisionMarkup(plan){
 if(!plan)return morningMarkup(plan);
 const focus=plan.focusSymbols?plan.focusSymbols.map(s=>plan.items.find(i=>i.symbol===s)).filter(Boolean):
   plan.items.filter(i=>i.sector.endsWith('ETF')&&i.trend==='偏强').slice(0,3);
 const enabled=focus.filter(i=>i.entryRule?.enabled&&i.stance==='conditional');
 const visibleFocus=plan.late||plan.preview?[]:enabled;
 const actionable=new Set([...visibleFocus.map(i=>i.symbol),...(plan.holdings||[]).filter(h=>['减仓','清仓'].includes(h.action)).map(h=>h.symbol)]);
 const avoid=plan.noParticipation||['原存档未定义当日入场规则，不把跨日条件改成盘中信号。','盘前标为观望或数据不足的方向，今天不新增参与。'];
 return `<div class="daily-plan-head"><span class="frozen-badge">${esc(plan.date)} · ${plan.preview?'预览，不留档':plan.late?'补生成存档':'计划已冻结'}</span><span class="muted">${esc(plan.strategyLabel||'原规则存档')} · 实际生成 ${esc(clock(plan.generatedAt))}</span><h2>${esc(plan.allocations&&!visibleFocus.length?'今日不买，新增 0 元':plan.summary)}</h2><p>依据 ${esc(plan.closeDate||'数据待补')} 收盘与截至 ${esc(clock(plan.cutoffAt))} 的已采集消息；当天计划固定，实时行情只用于检查原条件。</p></div>
 ${plan.allocations?'<section><h3>今日 ETF 仓位计划</h3>'+(plan.positionLimit?'<p>同时最多持有 '+esc(plan.positionLimit)+' 只 ETF。'+(plan.operations?'每只 ETF 每日最多操作两次，做 T 的买卖各计一次。':'')+'</p>':'')+''+(plan.allocations.filter(a=>actionable.has(a.symbol)).map(a=>'<p><b>'+esc(a.name)+'（'+esc(a.symbol.slice(2))+'）</b> · '+esc(a.mode)+' · '+esc(a.instruction)+'</p>').join('')||'<p>今日新增 0 元。</p>')+'</section>':''}
 ${plan.holdings?.length?'<section><h3>已有方向 · 今日持仓计划</h3>'+(plan.holdings.map(h=>'<p><b>'+esc(h.name)+' · '+esc(h.action)+'</b>（'+esc(h.mode)+(h.quantity?' · '+esc(h.quantity)+'份':' · 假设已参与')+'）'+esc(h.reason)+'</p>').join('')||'<p>暂无已登记持仓或待跟踪的入场信号。</p>')+'</section>':''}
 <section class="daily-directions" ${visibleFocus.length?'':'hidden'}><h3>今日关注方向</h3><div class="daily-focus-grid">${visibleFocus.length?visibleFocus.map(i=>`<article class="daily-focus-card"><div><h3>${i.relativeStrengthRank && !plan.late ? esc(i.relativeStrengthRank===1?'首要关注 · ':'相对强度第'+i.relativeStrengthRank+'名 · ') : ''}${esc(i.name)}（${esc(i.code||i.symbol.slice(2))}）</h3><span class="chip">${i.entryRule?.enabled&&!plan.late?'满足条件才参与':'仅观察，不新增'}</span></div><p>${esc(i.reason)}</p><p>突破观察 <b>${price(i.pressure,i)}</b> · 风险观察 <b>${price(i.support,i)}</b></p><small>${esc(i.newsSummary||'消息待确认')}</small></article>`).join(''):'<p class="muted">今日暂无明确的优先方向，观望不参与。</p>'}</div></section>
 <div class="daily-decision-grid" ${visibleFocus.length?'':'hidden'}><section><h3>什么信息出现时可以入场</h3>${enabled.length&&!plan.late?`<p>仅 ${esc(enabled.map(i=>i.name).join('、'))} 检查入场；全部条件同时满足后提醒。</p><ol><li>沪深300不低于盘前冻结MA20，标的未触及冻结风险位，开盘未跳空超限。</li><li>已完成的15分钟K线收于固定突破位上方，DIF&gt;DEA且MACD柱为正。</li><li>随后连续3个分钟采样价守住突破位，最新价不超过突破位1%，数据新鲜且同日。</li></ol>`:'<p>这份计划未启用当日新增参与条件。今天保持观察，不因盘中上涨临时增加方向。</p>'}<small>入场规则是试行版本，后续优化只影响新一天的计划。</small></section><section><h3>什么时候观望、不参与</h3><ul>${avoid.map(s=>`<li>${esc(s)}</li>`).join('')}</ul></section></div>
 <details class="daily-plan-evidence"><summary>查看盘前完整存档、全部观察对象与消息依据</summary>${morningMarkup(plan)}</details>`;
}

export function executionMarkup(payload,now=Date.now()){
 const c=payload?.current,fresh=c&&now-Date.parse(c.checkedAt)>=0&&now-Date.parse(c.checkedAt)<=90000;
 const title=payload?.lastError?'检查失败，暂停入场提醒':!fresh?'等待最新检查，暂停入场提醒':c.reason;
 const labels={eligible:'条件已满足',invalid:'原条件已失效',waiting:'观望，等待条件'};
 return `<div class="execution-heading"><h2>盘中执行提醒 · ${esc(payload?.today||'今天')}</h2><span>最近检查 ${esc(clock(c?.checkedAt))} · 后台每30秒检查</span></div><p>${esc(title)}</p>
 <div class="execution-states">${(c?.items||[]).filter(i=>i.observationOnly!==true).map(i=>`<article class="execution-state ${fresh?esc(i.status):'waiting'}"><b>${esc(i.name)} · ${fresh?labels[i.status]||'待确认':'数据待确认'}</b><p>${esc(fresh?i.reason:'检查结果过期，不沿用之前的入场状态')}</p>${fresh&&i.checks?.length?`<details><summary>原计划条件检查</summary>${i.checks.map(x=>`<p>${x.passed?'✓':'—'} ${esc(x.label)}</p>`).join('')}</details>`:''}</article>`).join('')}</div>
 <details class="execution-events"${payload?.records?.length?' open':''}><summary>今日触发记录（${payload?.records?.length||0}）· 历史触发不代表现在仍可入场</summary>${[...(payload?.records||[])].reverse().map(e=>`<article><b>${e.kind==='entry'?'入场条件提醒':'风险提醒'} · ${esc(e.name)}</b><p>${esc(e.text)}</p><small>发现于 ${esc(clock(e.observedAt))} · 行情时间 ${esc(clock(e.quoteTime))} · 对应盘前存档 ${esc(e.date)}</small></article>`).join('')||'<p>尚无触发记录。没有满足原计划条件时不会发入场提醒。</p>'}</details>`;
}

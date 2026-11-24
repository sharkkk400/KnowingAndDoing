import test from 'node:test';
import assert from 'node:assert/strict';
import {topStrategyAdviceMarkup} from '../dist/strategy-markup.js';

const date='2026-10-21';
const future={ready:true,date,regime:'balanced',actions:[{label:'当前建议',text:'突破压力且量价确认后再参与，跌破支撑则减仓。'}]};
const item=(symbol,stage='breakout',extra={})=>({symbol,name:symbol,exposure:symbol,stage,label:stage==='confirmed'?'条件已确认':'等待收盘突破',...extra});
const strategy=(items=[],extra={})=>({ready:true,date,time:'10:30',dailyDate:'2026-10-20',items,change:null,...extra});

test('one compact advice block includes ordered clickable candidates and the daily evidence date',()=>{
 const html=topStrategyAdviceMarkup(future,strategy([item('A'),item('B'),item('C'),item('D')]));
 assert.equal((html.match(/class="action-plan"/g)||[]).length,1);
 assert.equal((html.match(/<p>/g)||[]).length,1);
 assert.equal((html.match(/data-benchmark=/g)||[]).length,3);
 assert.ok(html.indexOf('data-benchmark="A"')<html.indexOf('data-benchmark="B"'));
 assert.ok(html.indexOf('data-benchmark="B"')<html.indexOf('data-benchmark="C"'));
 assert.match(html,/日线依据 2026-10-20/);
 assert.match(html,/确认条件满足前仅观察/);
 assert.doesNotMatch(html,/未持有|已持有|参与计划|已有敞口/);
});

test('actionable candidate ordering replaces conflicting sector names while preserving conditional advice',()=>{
 for(const regime of ['broad_repair','selective','rotation']) {
  const html=topStrategyAdviceMarkup({...future,regime,actions:[{text:'优先看旧行业名称的回踩。'}]},strategy([item('新候选','confirmed')]));
  assert.doesNotMatch(html,/旧行业名称/);
  assert.match(html,/新候选/);
  assert.match(html,/回踩/);
  assert.match(html,/支撑|减仓/);
 }
 const retained=topStrategyAdviceMarkup({...future,regime:'momentum_missing',actions:[{text:'等待有效15分钟动能，避免追涨。'}]},strategy([item('A')]));
 assert.match(retained,/等待有效15分钟动能，避免追涨/);
});

test('defensive market regimes explicitly pause participation even if a daily plan was confirmed',()=>{
 for(const regime of ['defensive','fragile','index_divergence','cooling']) {
  const html=topStrategyAdviceMarkup({...future,regime,actions:[{text:'原来的风险控制建议。'}]},strategy([item('A','confirmed')]));
  assert.match(html,/原来的风险控制建议/);
  assert.match(html,/暂缓参与，以下顺序仅供观察/);
 }
});

test('paused and empty cohorts never become new actionable confirmations',()=>{
 const paused=topStrategyAdviceMarkup(future,strategy([item('A','waiting',{label:'条件已确认'})]));
 assert.match(paused,/当前候选均在等待条件恢复/);
 assert.doesNotMatch(paused,/条件已确认/);
 const empty=topStrategyAdviceMarkup(future,strategy());
 assert.match(empty,/暂无合格候选，等待新的确认条件/);
 assert.doesNotMatch(empty,/data-benchmark=|可参与|已确认/);
});

test('unavailable or mismatched snapshots preserve the original advice and hide old change notices',()=>{
 const original={...future,actions:[future.actions[0],future.actions[0]]};
 const expected='<div class="action-plan"><div><b>当前建议</b><p>突破压力且量价确认后再参与，跌破支撑则减仓。</p></div></div>';
 for(const snapshot of [
  undefined,
  strategy([item('A')],{ready:false,change:{date,text:'旧变化'}}),
  strategy([item('A')],{date:'2026-10-20',change:{date:'2026-10-20',text:'旧变化'}}),
  strategy([item('A')],{dailyDate:'2026-10-22',change:{date,text:'旧变化'}})
 ])assert.equal(topStrategyAdviceMarkup(original,snapshot),expected);
});

test('only a same-day change appears once and all dynamic text and attributes are escaped',()=>{
 const attack='<img src=x onerror="alert(1)">';
 const r=strategy([item('"><svg/onload=alert(1)>','confirmed',{name:attack,label:attack})],{
  change:{date,time:'<time>',text:attack}
 });
 const html=topStrategyAdviceMarkup({...future,actions:[{text:attack}]},r);
 assert.equal((html.match(/class="strategy-change"/g)||[]).length,1);
 assert.doesNotMatch(html,/<img|<svg|<time>/);
 assert.match(html,/&lt;img/);
 assert.match(html,/data-benchmark="&quot;&gt;&lt;svg/);
 assert.doesNotMatch(topStrategyAdviceMarkup(future,strategy([],{change:{date:'2026-10-20',text:'旧变化'}})),/strategy-change|旧变化/);
});

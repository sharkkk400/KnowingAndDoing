import test from 'node:test';
import assert from 'node:assert/strict';
import {instrumentAdvice} from '../dist/instrument-advice.js';

const base={bias:'mixed',price:100,support:95,pressure:105,ma5:99,ma20:98,ma60:96,vwap:99,change:1,relative:1,volumeRatio:1.2,flowMain:200,macdTrend:'improving',sector:'行业 ETF',dailyOK:true};
const allText=r=>[r.title,r.summary,...r.actions.map(a=>a.text)].join(' ');

test('strong trend close to resistance gives one plan for waiting or taking profits',()=>{
 const r=instrumentAdvice({...base,bias:'strong',support:97,pressure:100.5});
 assert.equal(r.regime,'strong-near-pressure');
 assert.match(r.title,/不追/);
 assert.match(r.summary,/100\.500.*0\.50%/);
 assert.match(r.actions[0].text,/突破 100\.500 后回踩不失守/);
 assert.match(r.actions[0].text,/动能转弱.*兑现部分/);
 assert.deepEqual(r.actions.map(a=>a.label),['当前建议']);
});

test('a weak daily trend overrides a positive day and requires reduced risk before re-entry',()=>{
 const r=instrumentAdvice({...base,bias:'repair',ma20:105,ma60:110,change:2});
 assert.equal(r.regime,'weak-rebound');
 assert.match(r.actions[0].text,/20日趋势改善/);
 assert.match(r.actions[0].text,/105\.000.*站不稳时减仓/);
 const declining=instrumentAdvice({...base,bias:'weak',change:-2,macdTrend:'weakening'});
 assert.equal(declining.regime,'weak-trend');
 assert.match(declining.actions[0].text,/暂不抄底/);
});

test('range location changes the plan even when the original bias is identical',()=>{
 const upper=instrumentAdvice({...base,support:96,pressure:101});
 const lower=instrumentAdvice({...base,support:98,pressure:110});
 const middle=instrumentAdvice(base);
 assert.equal(upper.regime,'range-upper');
 assert.equal(lower.regime,'range-lower');
 assert.equal(middle.regime,'range-middle');
 assert.match(upper.actions[0].text,/冲击 101\.000 失败.*减仓/);
 assert.match(lower.actions[0].text,/98\.000.*不再被有效跌破/);
});

test('a narrow two-sided range uses its relative position instead of treating both ends as nearby',()=>{
 const narrow={...base,price:5.62,support:5.60,pressure:5.632,ma20:5.5,ma60:5.4};
 assert.equal(instrumentAdvice(narrow).regime,'range-middle');
 assert.equal(instrumentAdvice({...narrow,price:5.606}).regime,'range-lower');
 assert.equal(instrumentAdvice({...narrow,price:5.628}).regime,'range-upper');
 assert.equal(instrumentAdvice({...narrow,support:null}).regime,'range-upper');
 assert.equal(instrumentAdvice({...narrow,pressure:null}).regime,'range-lower');
});

test('a distant downside observation boundary requires closer support before adding exposure',()=>{
 const f={...base,bias:'repair',price:72.57,support:67.51,pressure:73.70,ma20:70,ma60:68,sector:'机器人'};
 const r=instrumentAdvice(f);
 assert.equal(r.regime,'wait-closer-support');
 assert.match(r.summary,/73\.70 约 1\.56%.*67\.51 约 6\.97%/);
 assert.match(r.actions[0].text,/回踩形成更近的有效支撑/);
 assert.match(r.actions[0].text,/不因冲高追加/);
 assert.doesNotMatch(allText(r),/预期收益|盈亏比|风险收益比|目标价/);
 assert.equal(instrumentAdvice({...f,support:70}).regime,'repair-confirmation');
 assert.equal(instrumentAdvice({...f,pressure:80}).regime,'repair-confirmation');
});

test('weak trend instructions retain priority over a distant observation boundary',()=>{
 const f={...base,bias:'weak',support:90,pressure:101};
 assert.equal(instrumentAdvice(f).regime,'weak-rebound');
 assert.equal(instrumentAdvice({...f,change:-1,macdTrend:'weakening'}).regime,'weak-trend');
 assert.equal(instrumentAdvice({...f,bias:'repair',ma20:105,ma60:110}).regime,'weak-rebound');
});

test('repair needs a confirmed breakout and cannot use bullish-trend language by default',()=>{
 const r=instrumentAdvice({...base,bias:'repair'});
 assert.equal(r.regime,'repair-confirmation');
 assert.match(r.actions[0].text,/放量突破 105\.000 后回踩不失守/);
 assert.match(r.actions[0].text,/相对参照走强后再考虑加仓.*跌破 95\.000 且不能收回时减仓/);
});

test('strong pullbacks and extended trends carry different entry conditions',()=>{
 const pullback=instrumentAdvice({...base,bias:'strong',support:99.5,vwap:100.5});
 const extended=instrumentAdvice({...base,bias:'strong',ma20:90,ma60:85});
 assert.equal(pullback.regime,'strong-pullback');
 assert.match(pullback.actions[0].text,/重新站上日内均价 100\.500/);
 assert.equal(extended.regime,'strong-extended');
 assert.match(extended.summary,/11\.11%/);
});

test('missing daily evidence blocks new exposure and null fields never become numerical evidence',()=>{
 for(const f of [
  {...base,dailyOK:false},
  {bias:'strong',price:100,dailyOK:false},
  {},
  {...base,price:NaN},
  {...base,bias:'limited',flowMain:null,volumeRatio:null,relative:null}
 ]) {
  const r=instrumentAdvice(f);
  assert.equal(r.regime,'insufficient');
  assert.match(r.title,/不新开/);
  assert.doesNotMatch(allText(r),/NaN|undefined|null|Infinity/);
 }
 const r=instrumentAdvice({...base,flowMain:null,volumeRatio:null,relative:null,ma20:null,ma60:null});
 assert.doesNotMatch(r.summary,/净额|成交量|较参照|均线/);
});

test('crossed or equal boundaries never create fake upside, downside, or risk reward',()=>{
 const r=instrumentAdvice({...base,support:101,pressure:99,nextPressure:null});
 assert.equal(r.regime,'unbounded');
 assert.doesNotMatch(r.summary,/距上方|距下方/);
 const equal=instrumentAdvice({...base,support:100,pressure:100});
 assert.equal(equal.regime,'unbounded');
 assert.doesNotMatch(allText(equal),/0\.00%|盈亏比|风险收益比/);
 const next=instrumentAdvice({...base,support:101,pressure:99,nextPressure:106});
 assert.match(next.summary,/距上方压力 106\.000 约 6\.00%/);
 assert.doesNotMatch(allText(next),/下方支撑 101|跌破 101/);
});

test('index plans address tracking products in a single suggestion and never promise a target',()=>{
 const r=instrumentAdvice({...base,bias:'strong',sector:'指数'});
 assert.deepEqual(r.actions.map(a=>a.label),['当前建议']);
 assert.match(r.actions[0].text,/跟踪该指数的产品/);
 assert.doesNotMatch(allText(r),/目标价|必涨|保证|胜率|满仓/);
 assert.deepEqual(instrumentAdvice(base).actions.map(a=>a.label),['当前建议']);
});

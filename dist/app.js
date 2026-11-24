import './morning.js';
import './research.js';
import {marketOutlook} from './outlook.js';
import {updateNewsMarket,symbolNewsMarkup} from './news.js';
import {refreshSharesView,sharesOverviewText,renderCapitalView,currentSharesSnapshot} from './shares.js';
import {groupStrength,anomalyEpisodes,macdDistribution} from './etf-insights.js';
import {etfOverview} from './etf-overview.js';
import {sameTimeTurnover,breadthMatches,marketSummary} from './market-analysis.js';
import {analyzeVolume} from './price-volume.js';
'use strict';
import {instruments as stocks} from './instruments.js';
let benchmarkSymbol='sh000985',benchmarkMode='price',breadth=null;
let etfMacdPending;
let dailyFocus=null;
const marketContexts=new Map();
const palette=['#48d3cc','#aa9bff','#70b3ff','#fb93b4','#ffad66','#d5de79','#67dda0','#e598e5','#d9ba83','#7be2f0','#b5cfef','#e9a19a','#c2b0f7','#a9d58f','#efcf69','#9de0c1','#df95b8','#65a6df','#c5ce78','#cd9ded','#eaac73','#8bc6a6','#e6d4a6','#cf819d','#9cc5fa','#b4a5d1','#84bfba','#d5a27e'];
let paused=false,busy=false,quoteResult=null,quoteError='';
const macdData=new Map();
const history=new Map(),quotes=new Map(),flows=new Map();
const $=id=>document.getElementById(id);
const escapeHTML=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=(s,n=s.price)=>Number.isFinite(n)?n.toFixed(s.sector.endsWith('ETF')?3:2):'—';
const sign=n=>Number.isFinite(n)?(n>=0?'+':'')+n.toFixed(2)+'%':'—';
const cls=n=>n>0?'up':n<0?'down':'';
const time=t=>t?new Date(t).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—';
function freshness(q){if(!q?.quoteTime)return '暂无行情';return Date.now()-Date.parse(q.quoteTime)>180000?'历史快照 / 非最新报价':'近期报价';}
async function api(path,timeout=12000){const r=await fetch(path,{signal:AbortSignal.timeout(timeout)});const j=await r.json();if(!r.ok)throw new Error(j.error||'请求失败');return j;}
function render(){renderBenchmark();$('sessionDate').textContent='腾讯公开行情';$('sessionTime').textContent=`最近获取：${time(quoteResult?.fetchedAt)}`;const old=[...quotes.values()].some(q=>Date.now()-Date.parse(q.quoteTime)>180000);$('dataStatus').textContent=quoteError||quoteResult?.stale?'获取失败 · 保留旧数据':quoteResult?.missing?.length?'部分行情缺失':!quoteResult?'正在连接行情源':old?'历史快照 · 请核对行情日期':'行情已接入';$('dataStatus').title=quoteError||'超过 3 分钟的报价标记为历史快照；非交易时段保留来源最后报价。';}
async function refresh(){if(busy)return;busy=true;try{const result=await api('/api/quotes');quoteResult=result;quoteError='';// Missing instruments are removed rather than silently retaining an older quote.
quotes.clear();result.quotes.forEach(q=>quotes.set(q.symbol,q));}catch(e){quoteError=e.message;}finally{busy=false;render();}await Promise.all([refreshBenchmark(),refreshBreadth(),refreshEtfMacd(),refreshDailyCandidates(),refreshShareData(),refreshEtfFlows()]);}
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.benchmark)selectBenchmark(b.dataset.benchmark);if(b.hasAttribute('data-focus-target'))document.querySelector('.benchmark-panel').scrollIntoView({behavior:'smooth',block:'start'});if(b.dataset.marketChart){benchmarkMode=b.dataset.marketChart;renderBenchmark();}});
$('pause').addEventListener('click',()=>{paused=!paused;$('pause').textContent=paused?'继续':'暂停';$('tickLabel').textContent=paused?'页面暂停 · 后台仍采样':'报价 30 秒 · 资金采样 60 秒';renderBenchmark();if(!paused)void refresh();});$('refresh').addEventListener('click',()=>void refresh());
$('tickLabel').textContent='报价 30 秒 · 资金采样 60 秒';
render();void refresh();setInterval(()=>{if(!paused)void refresh();else render();},30000);
function renderMacd(symbol,panel,readoutId){
 const d=macdData.get(symbol),instrument=stocks.find(s=>s.symbol===symbol);
 if(!d?.points?.length){panel.innerHTML='<h2>15 分钟 MACD（12,26,9）</h2><p class="muted">'+escapeHTML(d?.error||'正在读取真实 15 分钟 K 线…')+'</p>';return;}
 const points=d.points,confirmed=points.filter(p=>p.confirmed),last=confirmed.at(-1),previous=confirmed.at(-2),forming=points.at(-1).confirmed?null:points.at(-1);
 if(!last){panel.textContent='等待已完成的 15 分钟 K 线';return;}
 const cross=previous&&previous.dif<=previous.dea&&last.dif>last.dea?'本根出现金叉':previous&&previous.dif>=previous.dea&&last.dif<last.dea?'本根出现死叉':last.dif>last.dea?'DIF 位于 DEA 上方':last.dif<last.dea?'DIF 位于 DEA 下方':'DIF 与 DEA 重合';
 const zone=last.dif>=0&&last.dea>=0?'双线位于零轴上方':last.dif<0&&last.dea<0?'双线位于零轴下方':'双线分处零轴两侧';
 const momentum=!previous?'等待比较':Math.abs(last.histogram)>Math.abs(previous.histogram)?(last.histogram>=0?'正柱扩大':'负柱扩大'):Math.abs(last.histogram)<Math.abs(previous.histogram)?(last.histogram>=0?'正柱收缩':'负柱收缩'):'柱长基本不变';
 const volume=last.volumeRatio===null?'成交量基线不足':last.volumeRatio>=2?'15 分钟放量':last.volumeRatio<=.5?'15 分钟缩量':'15 分钟成交量平稳';
 const W=680,P=610,x=i=>6+i/(points.length-1)*(P-12),max=Math.max(.0001,...points.flatMap(p=>[Math.abs(p.dif),Math.abs(p.dea),Math.abs(p.histogram)]))*1.15,y=v=>205-v/max*65;
 const lo=Math.min(...points.map(p=>p.close)),hi=Math.max(...points.map(p=>p.close)),py=v=>100-(v-lo)/(hi-lo||1)*70;
 const line=(key,fn)=>points.map((p,i)=>`${i?'L':'M'}${x(i)},${fn(p[key])}`).join(' ');
 const bars=points.map((p,i)=>`<rect x="${x(i)-2}" y="${Math.min(y(0),y(p.histogram))}" width="4" height="${Math.max(.5,Math.abs(y(p.histogram)-y(0)))}" fill="${p.histogram>=0?'#ff747e':'#46c49a'}" opacity="${p.confirmed?'.8':'.35'}"/>`).join('');
 const detail=p=>`${p.time.slice(0,10)} ${p.time.slice(11,16)} ${p.confirmed?'已完成':'形成中'} ｜ 收盘 ${fmt(instrument,p.close)} ｜ DIF ${p.dif.toFixed(4)} ｜ DEA ${p.dea.toFixed(4)} ｜ 柱 ${p.histogram.toFixed(4)}`;
 const hits=points.map((p,i)=>`<rect x="${x(i)-3.5}" y="20" width="7" height="255" fill="transparent" class="macd-hit" data-detail="${escapeHTML(detail(p))}"><title>${escapeHTML(detail(p))}</title></rect>`).join('');
 panel.innerHTML=`<div class="observation-heading"><h2>15 分钟 MACD（12,26,9）</h2><span>${d.stale?'来源异常 · 保留旧数据':Date.now()-Date.parse(points.at(-1).time)>1200000?'历史 K 线':'近期 K 线'} · ${escapeHTML(d.source)}</span></div><div class="macd-analysis"><b>${cross} · ${zone} · ${momentum}</b><p>分析依据：${last.time.slice(0,10)} ${last.time.slice(11,16)} 已完成 K 线。${volume}${last.volumeRatio===null?'':'（'+last.volumeRatio.toFixed(2)+' 倍此前最多 20 根成交量中位数）'}，本根价格 ${sign(last.changePct)}（开盘至收盘）。</p>${forming?'<p class="observation-divergence">末根 '+forming.time.slice(11,16)+' 尚在形成，指标会变化，不计入上述交叉判断。</p>':''}<small>MACD 描述价格动能；柱长变化不等于价格必然反转。与上方一分钟量价观察分开标注周期，不直接给出买卖指令。</small></div><div id="${readoutId}" class="volume-readout">${escapeHTML(detail(last))}</div><svg viewBox="0 0 ${W} 305" role="img" aria-label="15 分钟收盘价与 MACD"><text x="0" y="12" fill="#8695ab" font-size="11">15 分钟收盘价</text><path d="${line('close',py)}" fill="none" stroke="#8ebce5" stroke-width="1.5"/><text x="618" y="34" fill="#8695ab" font-size="11">${hi.toFixed(2)}</text><text x="618" y="102" fill="#8695ab" font-size="11">${lo.toFixed(2)}</text><text x="0" y="130" fill="#48d3cc" font-size="11">DIF 青色 · DEA 黄色 · 柱＝2×(DIF−DEA)</text><line x1="0" x2="610" y1="205" y2="205" stroke="#496073"/>${bars}<path d="${line('dif',y)}" fill="none" stroke="#48d3cc" stroke-width="1.5"/><path d="${line('dea',y)}" fill="none" stroke="#efc779" stroke-width="1.5"/><text x="618" y="144" fill="#8695ab" font-size="11">${max.toFixed(3)}</text><text x="618" y="209" fill="#8695ab" font-size="11">0</text><text x="618" y="274" fill="#8695ab" font-size="11">${(-max).toFixed(3)}</text>${hits}<text x="0" y="299" fill="#8695ab" font-size="11">${points[0].time.slice(5,16).replace('T',' ')}</text><text x="500" y="299" fill="#8695ab" font-size="11">${points.at(-1).time.slice(5,16).replace('T',' ')}</text></svg><details><summary>指标口径与数据说明</summary><p>以新浪原始价格计算，未另做复权。EMA12−EMA26 为 DIF，DIF 的 EMA9 为 DEA。以首根收盘价初始化 EMA，前 100 根作预热；本次取得 ${d.count} 根，图示最近 ${points.length} 根。不同平台的复权及初始化方法可能产生差异。每 60 秒请求源数据，页面每 30 秒读取。<a href="https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/macd" target="_blank" rel="noopener noreferrer">MACD 指标说明</a></p></details>`;
 const explanation=panel.querySelector('.macd-analysis');if(explanation)panel.querySelector('details').append(explanation);
 panel.querySelectorAll('.macd-hit').forEach(el=>{const show=()=>{$(readoutId).textContent=el.dataset.detail;};el.addEventListener('pointerenter',show);el.addEventListener('click',show);});
}

function overallOutlook(o=etfOverview(stocks,history,quotes)){
 return marketOutlook({overview:o,breadth,whole:currentMarketSummary(),distribution:macdDistribution(stocks,macdData,o),groups:groupStrength(o,stocks),quotes,defs:stocks,macdData,paused,quoteStale:!!(quoteResult?.stale||quoteError)});
}
function selectBenchmark(symbol){if(!stocks.some(s=>s.symbol===symbol&&(s.sector==='指数'||s.sector.endsWith('ETF'))))return;benchmarkSymbol=symbol;renderBenchmark();void refreshBenchmark();}
async function refreshBenchmark(){
 const symbol=benchmarkSymbol;
 await Promise.all([
 (async()=>{const list=stocks;let cursor=0;
 await Promise.all(Array.from({length:4},async()=>{while(cursor<list.length){const n=list[cursor++];try{history.set(n.symbol,await api('/api/intraday?symbol='+n.symbol));}catch(e){history.set(n.symbol,{...history.get(n.symbol),stale:true,error:e.message});}}}));})(),
 (async()=>{try{marketContexts.set(symbol,await api('/api/market-context?symbol='+symbol));}catch(e){const old=marketContexts.get(symbol);marketContexts.set(symbol,{...old,daily:{...old?.daily,stale:true,error:e.message},history:{...old?.history,stale:true,error:e.message}});}})(),
 (async()=>{try{macdData.set(symbol,await api('/api/macd?symbol='+symbol));}catch(e){macdData.set(symbol,{...macdData.get(symbol),stale:true,error:e.message});}})()
 ]);if(benchmarkSymbol===symbol)renderBenchmark();
}
async function refreshBreadth(){try{breadth=await api('/api/market-breadth',60000);}catch(e){breadth={...breadth,stale:true,error:e.message};}renderBenchmark();}
function renderBenchmark(){
 $('benchmarkUniverseLabel').textContent=`${stocks.filter(n=>n.sector.endsWith('ETF')).length} 只 ETF / ${stocks.filter(n=>n.sector==='指数').length} 个指数 · 全部同图，点选查看分析`;

 const def=stocks.find(s=>s.symbol===benchmarkSymbol),q=quotes.get(benchmarkSymbol),market=history.get(benchmarkSymbol),context=marketContexts.get(benchmarkSymbol);
 const tagScroll=$('benchmarkTags').scrollTop;
 const marketDefs=stocks.filter(n=>n.sector==='指数'||n.sector.endsWith('ETF'));
 $('benchmarkTags').innerHTML=['市场整体','大小盘与风格','行业轮动','港股参照'].map(category=>`<div class="benchmark-group"><span class="benchmark-group-title">${category}</span>${marketDefs.filter(n=>n.category===category).map(n=>`<button class="stock-tag ${n.symbol===benchmarkSymbol?'active':''}" data-benchmark="${n.symbol}" aria-pressed="${n.symbol===benchmarkSymbol}" title="${n.code} · ${escapeHTML(n.sector)} · ${escapeHTML(history.get(n.symbol)?.error||history.get(n.symbol)?.date||'分时加载中')}${history.get(n.symbol)?.stale?' · 旧值':''}"><i class="tag-line-color" style="background:${palette[marketDefs.indexOf(n)%palette.length]}"></i>${escapeHTML(n.name)} <small class="${cls(quotes.get(n.symbol)?.changePct)}">${sign(quotes.get(n.symbol)?.changePct)}</small></button>`).join('')}</div>`).join('');
 $('benchmarkTags').scrollTop=tagScroll;
 const trend=context?.daily?.trend,turnover=sameTimeTurnover(market,context?.history?.days);
 const sourceDate=market?.date;
 const breadthAligned=breadthMatches(breadth,market);
 const breadthLabel=breadthAligned?(breadth.upRatio>=.6?'多数个股上涨':breadth.upRatio<=.4?'多数个股下跌':'涨跌分化'):'广度待确认';
 const volumeLabel=turnover?(turnover.ratio>=1.5?'成交明显放大':turnover.ratio<=.7?'成交缩小':'成交接近近期'):'同期基线不足';
 renderEtfOverview();
 $('marketSignals').innerHTML=[['趋势 · '+def.name,trend?.label||'日线待补齐',trend?trend.date+' 收盘 · 60 日位置 '+trend.position.toFixed(0)+'%':'至少需要 60 个交易日'],['量价',volumeLabel,turnover?'前 '+turnover.count+' 日 '+turnover.time+' 累计成交额均值':'至少 3 日同分钟历史'],['A 股广度',breadthLabel,breadthAligned?'涨 '+breadth.up+' / 跌 '+breadth.down+' / 平 '+breadth.flat:'沪深北 A 股 · 独立统计']].map(([label,value,note])=>`<div><span>${label}</span><b>${escapeHTML(value)}</b><small>${escapeHTML(note)}</small></div>`).join('');
 const breadInfo=breadth?.date?`${breadth.date} ${breadth.timeFrom}—${breadth.timeTo}（各股票来源时间范围），覆盖 ${breadth.received}/${breadth.expected}（${(breadth.coverage*100).toFixed(1)}%），有成交 ${breadth.active}，无成交 ${breadth.inactive}。${breadth.usable?'':'覆盖不足 95%，不参与结论。'}${breadth.date!==sourceDate?'与所选图表日期不同，不参与结论。':''}`:'正在统计沪深北 A 股，首次加载可能稍慢。';
 $('marketEvidence').innerHTML=`<p>市场整体由中证全指与沪深北个股涨跌广度共同判断，成交额为已覆盖个股合计，不叠加指数或ETF成交额。ETF强弱只统计 ${stocks.filter(n=>n.sector.endsWith('ETF')&&n.market==='A').length} 只 A 股 ETF，港股独立展示；以同日同分钟、跟踪方向去重后的涨跌幅中位数描述这组 ETF，不代表全市场指数或投资组合收益。覆盖至少 90% 才生成结论。涨跌幅绝对值≤0.05%为近乎持平，上涨／下跌占比≥70%为多数走强／走弱。近5分钟需6个连续分钟端点；跨午休、缺口不计算。异动规则：偏离组内中位数≥1.5个百分点，或近5分钟涨跌≥0.5%，或最新分钟量≥此前5～20分钟中位数3倍且分钟额≥1000万元。仅列最明显3项，描述已发生的行情，不代表资金流入或交易建议。</p><p>以下单项依据：${escapeHTML(def.name)}。</p><p>日线：${trend?trend.date+' 收盘，MA20 '+trend.ma20.toFixed(2)+' / MA60 '+trend.ma60.toFixed(2)+'；近 60 日最高最低区间位置 '+trend.position.toFixed(1)+'%。':'尚无足够数据。'}${escapeHTML(context?.daily?.error||'')} ${context?.daily?.savedAt?'本地已保存 '+context.daily.bars.length+' 个交易日日线。':''}日线仅使用已收盘数据，未另做复权；收盘价＞MA20＞MA60 为偏强，反向为偏弱，其余为分化。</p><p>成交额：${turnover?'截至 '+turnover.time+'，累计 '+(turnover.amount/1e8).toFixed(2)+' 亿，相比 '+turnover.dates.join('、')+' 同分钟平均额 '+(turnover.average/1e8).toFixed(2)+' 亿。':'历史同分钟样本不足，暂不判断日内放缩量。'}≥1.5 倍为明显放大，≤0.7 倍为缩小。${escapeHTML(context?.history?.error||'')}</p><p>市场广度：${escapeHTML(breadInfo)} 上涨占有成交股票 ≥60% 为多数上涨，≤40% 为多数下跌。每 5 分钟采集一次；与图表截止时刻相差超过 6 分钟时不合并，收盘后时间按 15:00 对齐。批量获取不等于同一秒快照，不代表所选 ETF 的成分股广度。${escapeHTML(breadth?.error||'')}</p><p>来源：新浪日线／15 分钟线、腾讯分时／新浪备用分钟K线及腾讯批量行情；新浪 A 股名单。ETF日份额已单独接入，依公布日期观察；融资数据尚未接入。行业联动需先核实参照 ETF 成分，目前仅作宽基参照。</p>`;
 document.querySelectorAll('[data-market-chart]').forEach(b=>{b.classList.toggle('selected',b.dataset.marketChart===benchmarkMode);b.setAttribute('aria-pressed',String(b.dataset.marketChart===benchmarkMode));});
 $('benchmarkChart').hidden=benchmarkMode==='macd';$('benchmarkMacd').hidden=benchmarkMode!=='macd';
 document.querySelector('[data-market-chart=macd]').textContent=def.name+' · 15分 MACD';
 if(benchmarkMode==='macd')return renderMacd(benchmarkSymbol,$('benchmarkMacd'),'benchmarkMacdReadout');
 drawBenchmarkChart(market);
}
function drawBenchmarkChart(market){
 const panel=$('benchmarkChart');
 const defs=stocks.filter(n=>n.sector==='指数'||n.sector.endsWith('ETF'));
 const date=market?.date||defs.map(n=>history.get(n.symbol)?.date).filter(Boolean).sort().at(-1);
 const series=defs.map((n,i)=>{const data=history.get(n.symbol),quote=quotes.get(n.symbol);
 const valid=data?.date===date&&quote?.prev>0&&quote.quoteTime?.slice(0,10)===date;
 const points=valid?analyzeVolume(data.points||[]).map(p=>({...p,value:(p.price/quote.prev-1)*100})):[];
 return {...n,color:palette[i%palette.length],points,stale:data?.stale,error:!points.length?(data?.date&&data.date!==date?'日期不同':data?.error||'等待同日数据'):''};
 });
 const active=series.filter(n=>n.points.length);
 if(!active.length){panel.innerHTML='<div class="empty">等待同日 ETF／大盘分时数据…</div>';return;}
 const W=680,P=610,values=active.flatMap(n=>n.points.map(p=>p.value)),lo=Math.min(0,...values),hi=Math.max(0,...values),pad=Math.max(.1,(hi-lo)*.1),min=lo-pad,max=hi+pad;
 const y=v=>200-(v-min)/(max-min)*175,x=t=>{const [h,m]=t.split(':').map(Number),n=h*60+m;return 4+(n<=690?n-570:120+n-780)/240*(P-8);};
 const line=n=>n.points.map((p,i)=>`${i&&p.continuous?'L':'M'}${x(p.time)},${y(p.value)}`).join(' ');
 let grid='';for(let i=0;i<5;i++){const v=min+(max-min)*i/4;grid+=`<line x1="0" x2="610" y1="${y(v)}" y2="${y(v)}" stroke="#26384a" stroke-dasharray="3 4"/><text x="617" y="${y(v)+4}" fill="#8695ab" font-size="11">${v.toFixed(2)}%</text>`;}
 const focus=series.find(n=>n.symbol===benchmarkSymbol),amountPoints=focus?.points||[],maxAmount=Math.max(1,...amountPoints.map(p=>p.turnover||0));
 const bars=amountPoints.filter(p=>p.turnover!==null).map(p=>`<rect x="${x(p.time)-.9}" y="${302-p.turnover/maxAmount*62}" width="1.8" height="${p.turnover/maxAmount*62}" fill="${p.direction>0?'#ff747e':p.direction<0?'#46c49a':'#788ba4'}"/>`).join('');
 const times=[...new Set(active.flatMap(n=>n.points.map(p=>p.time)))].sort();
 const readout=t=>date+' '+t+' ｜ '+(focus?.name||'所选标的')+' '+sign(focus?.points.find(p=>p.time===t)?.value);
 const paths=active.map(n=>`<path data-series="${n.symbol}" d="${line(n)}" fill="none" stroke="${n.color}" stroke-width="${n.symbol===benchmarkSymbol?'3':'1.3'}" opacity="${n.symbol===benchmarkSymbol?1:.65}"/>`).join('');
 panel.innerHTML=`<div id="benchmarkReadout" class="volume-readout">${escapeHTML(readout(times.at(-1)))}</div><svg viewBox="0 0 ${W} 335" role="img" aria-label="全部 ETF 与指数涨跌幅叠加">${grid}<line x1="0" x2="610" y1="${y(0)}" y2="${y(0)}" stroke="#617689"/>${paths}<text x="0" y="228" fill="#a9b8cc" font-size="11">${escapeHTML(focus?.name||'所选标的')} · 分钟成交额（亿元）</text><text x="617" y="249" fill="#8695ab" font-size="11">${(maxAmount/1e8).toFixed(2)}</text>${bars}${times.map(t=>`<rect x="${x(t)-1.3}" y="20" width="2.6" height="282" fill="transparent" class="chart-hit" data-readout="${escapeHTML(readout(t))}"><title>${escapeHTML(readout(t))}</title></rect>`).join('')}<text x="0" y="328" fill="#8695ab" font-size="11">09:30</text><text x="265" y="328" fill="#8695ab" font-size="11">11:30 / 13:00</text><text x="578" y="328" fill="#8695ab" font-size="11">15:00</text></svg>`;
 panel.querySelectorAll('[data-readout]').forEach(el=>{const show=()=>{$('benchmarkReadout').textContent=el.dataset.readout;};el.addEventListener('pointerenter',show);el.addEventListener('click',show);});
}

function renderEtfOverview(){
 renderCapitalView({defs:stocks,quotes,history,contexts:marketContexts,selected:benchmarkSymbol,quoteStale:!!(quoteResult?.stale||quoteError)});
 const evidenceOpen=$('marketComparison').querySelector('.etf-insight-details')?.open,moreOpen=$('marketComparison').querySelector('.market-extra')?.open;
 const o=etfOverview(stocks,history,quotes);
 updateMarketNews(o);
 const whole=currentMarketSummary(),future=overallOutlook(o);
 $('benchmarkTitle').textContent='市场行情';
 $('benchmarkMeta').textContent=`${future.ready?future.date+' '+future.time+' · '+future.basis:'等待有效数据'} · A股 ETF ${future.ready?future.count:o.count}/${o.total} 只方向依据`;
 const shownChange=whole.ready?whole.change:future.ready?quotes.get('sh000985')?.changePct:null;
 $('benchmarkPrice').textContent=sign(shownChange);$('benchmarkPrice').className=cls(shownChange);
 $('benchmarkChange').textContent='中证全指';$('benchmarkChange').className='muted';
 const marketText=`<p class="market-wide-summary">${escapeHTML(whole.text)}${whole.ready?`<small>依据 ${whole.date} ${whole.time}</small>`:''}</p>`,hk=quotes.get('sz159740');
 const hkText=`<p class="muted">港股参照 · 恒生科技 ${sign(hk?.changePct)}${hk?.quoteTime?' · '+escapeHTML(hk.quoteTime.slice(0,16).replace('T',' ')):''}（${quoteResult?.stale||quoteError?'来源异常，保留旧值；':''}独立报价，不参与 A 股统计）</p>`;
 if(!o.ready){$('marketComparison').innerHTML=symbolNewsMarkup(benchmarkSymbol)+'<details class="market-extra"><summary>实时行情依据（不改晨间计划）</summary><p>'+escapeHTML(future.missing?.join('；')||o.reason)+'</p>'+marketText+hkText+'</details>';return;}

 const movement=o.recent===null?'近 5 分钟连续样本不足':`近 5 分钟${o.recent>=.2?'整体抬升':o.recent<=-.2?'整体回落':'整体变化较小'}（中位数 ${sign(o.recent)}）`;
 const groups=groupStrength(o,stocks),episodes=anomalyEpisodes(o),distribution=macdDistribution(stocks,macdData,o);
 const available=groups.filter(g=>g.ready&&g.category==='行业轮动'),strong=available[0],weak=available.at(-1);
 const rotation=available.filter(g=>g.rankChange>0&&Math.abs(g.relative15)>=.2).sort((a,b)=>b.rankChange-a.rankChange)[0];
 const groupText=strong&&weak&&strong!==weak?`${strong.name}组相对较强（${sign(strong.change)}），${weak.name}组相对偏弱（${sign(weak.change)}）`:'';
 const rotationText=rotation?`${rotation.name}组较 ${rotation.from} 上升 ${rotation.rankChange} 位`:available.some(g=>g.rankChange!==null)?'近15分钟暂无明显排名上移':'轮动比较等待连续15分钟';
 const overall=`A股 ETF ${o.trend}（监测方向中位数 ${sign(o.middle)}）：去重后 ${o.up} 涨 / ${o.down} 跌 / ${o.flat} 近乎持平；${movement}。${groupText}；${rotationText}。`;
 const macdText=distribution.ready?`15分钟动能偏多 ${distribution.bullish}/${distribution.units} 个方向，零轴上 ${distribution.above}，零轴下修复 ${distribution.repair}${distribution.bullishChange===null?'':`；较 ${distribution.previous} ${distribution.bullishChange>0?'增加':distribution.bullishChange<0?'减少':'持平'}${distribution.bullishChange?Math.abs(distribution.bullishChange)+' 个方向':''}`}（${distribution.time} 已完成线）`:`全体 MACD：${distribution.reason}`;
 const alerts=o.alerts.slice(0,3).map(n=>{
 const reasons=n.reasons.map(r=>r.type==='relative'?`${r.value>0?'强于':'弱于'}监测ETF ${Math.abs(r.value).toFixed(2)} 个百分点`:r.type==='move'?`${n.from}—${o.time} ${sign(r.value)}`:`${o.time} 分钟放量 ${r.value.toFixed(1)} 倍`);
 const ongoing=episodes.current.get(n.symbol)||[],longest=[...ongoing].sort((a,b)=>b.minutes-a.minutes)[0];
 const persistence=longest?`${({relative:'偏离',move:'急变',volume:'放量'})[longest.type]}${longest.minutes?'持续 '+longest.minutes+' 分钟':'刚出现'}`:'';
 if(persistence)reasons.push(persistence);
 return `<div class="etf-outlier"><button class="text-button" data-benchmark="${n.symbol}">${escapeHTML(n.name)}</button><span>${escapeHTML(reasons.join('，'))}</span></div>`;
 }).join('');
 $('marketComparison').innerHTML=`${symbolNewsMarkup(benchmarkSymbol)}<details class="market-extra" ${moreOpen?'open':''}><summary>实时行情依据（不改晨间计划）</summary>${marketText}<p>市场建议区分普涨共振、动能降温、指数与广度背离、个股回暖但ETF分化、行业轮动、普跌及数据不足。扩大参与需上涨占比≥60%、上涨ETF方向≥70%、15分钟偏多方向≥60%且数量不再下降；上涨占比≤40%且下跌ETF方向≥70%时优先收缩。ETF按暴露方向去重。阈值未作概率或收益回测。</p><p>${escapeHTML(overall)}</p>${hkText}<p class="etf-macd-summary">${escapeHTML(sharesOverviewText())}</p><p class="etf-macd-summary">${escapeHTML(macdText)}</p>${alerts||'<p class="muted">当前截面未触发明显偏离、急涨急跌或放量条件。</p>'}${o.alerts.length>3?`<small>共 ${o.alerts.length} 只触发条件，展示最明显的 3 只。</small>`:''}${renderEtfEvidence(o,groups,episodes,distribution)}</details>`;
 if(evidenceOpen)$('marketComparison').querySelector('.etf-insight-details').open=true;
}

async function refreshEtfMacd(){
 if(etfMacdPending)return etfMacdPending;
 etfMacdPending=(async()=>{const defs=stocks.filter(n=>n.sector.endsWith('ETF'));let cursor=0;
 await Promise.all(Array.from({length:3},async()=>{while(cursor<defs.length){const n=defs[cursor++];try{macdData.set(n.symbol,await api('/api/macd?symbol='+n.symbol));}catch(e){macdData.set(n.symbol,{...macdData.get(n.symbol),stale:true,error:e.message});}}}));renderBenchmark();})();
 try{await etfMacdPending;}finally{etfMacdPending=null;}
}
function renderEtfEvidence(o,groups,episodes,m){
 const rows=groups.map(g=>`<tr><td>${g.category} · ${g.name}${g.total===1?'（单方向）':''}</td><td>${g.ready?sign(g.change):'样本不足'}</td><td>${g.rankChange===null?'—':g.rankChange>0?'↑'+g.rankChange:g.rankChange<0?'↓'+Math.abs(g.rankChange):'不变'}</td><td>${g.count}/${g.total}</td></tr>`).join('');
 const labels={relative:'相对偏离',move:'5分钟急变',volume:'分钟放量'};
 const currentDetails=o.alerts.slice(0,3).map(n=>{
 const first=episodes.events.find(e=>e.symbol===n.symbol),ongoing=episodes.current.get(n.symbol)||[],volume=episodes.volumeHits.get(n.symbol)||0;
 return `<p><b>${escapeHTML(n.name)}</b>：当日所获分时首次触发 ${first?.first||'—'}；${ongoing.map(e=>`${labels[e.type]} ${e.first} 起 ${e.minutes} 分钟，${e.direction<0?'低点反弹':'区间高点回落'} ${e.adverse.toFixed(2)}%`).join('；')}；当日 ${volume} 个分钟放量达标。</p>`;
 }).join('');
 const events=episodes.events.slice(-12).reverse().map(e=>`<div class="etf-event"><b>${escapeHTML(e.name)} · ${labels[e.type]}${e.direction?e.direction>0?'向上':'向下':''}</b><span>${e.first}—${e.last} · ${e.minutes} 分钟 · ${e.status}</span></div>`).join('');
 return `<details class="etf-insight-details"><summary>分组、异动过程与 MACD 依据</summary><table><thead><tr><th>分组</th><th>涨跌中位数</th><th>15分钟排名变化</th><th>方向覆盖</th></tr></thead><tbody>${rows}</tbody></table><p>${o.total} 只 ETF，每个跟踪指数保留一只代表产品；双创50保留易方达（159781）。成分重叠但跟踪范围不同的指数单独观察。组内等权观察；大小盘与风格、行业轮动分别排名，行业每个赛道独立观察。港股不参与A股统计。绿色电力代表电力运营方向，不作为风电设备的直接替代。组间涨跌幅差≤0.05个百分点视为并列，覆盖不足90%的组不判断；排名比较需同一组别集合和连续15分钟。</p><p>MACD：${m.count}/${m.total} 只 ETF 覆盖${m.ready?`，${m.time} 同一根已完成线；${m.units}/${m.totalUnits} 个方向，零轴下 ${m.below}`:''}。DIF与DEA均≥0为零轴上，均&lt;0且DIF&gt;DEA为零轴下修复；动能偏多指DIF&gt;DEA。每只ETF独立判断动能，不平均不同价格尺度的MACD数值。数量变化比较同一批标的的前一根完整线，不代表未来上涨概率。</p><p>异动按来源当日分时回看，非本地首次发现时间。每个条件与方向独立计时，午休、缺口及条件消退会结束一段；上方持续时间取当前最长一段。重复刷新不会增加持续时间或放量次数。这里只覆盖已取得的分时，过去交易日未归档。</p>${currentDetails}<div class="etf-event-list">${events||'当日已取得分时暂无达标异动。'}</div><small>当日共 ${episodes.events.length} 段，显示最近12段；“持续中”是截至 ${o.date} ${o.time} 的状态。</small></details>`;
}

let dailyPending=false;
async function refreshDailyCandidates(){
 if(dailyPending)return;dailyPending=true;
 const el=$('dailyCandidates'),wasOpen=el.querySelector('.daily-rules')?.open;
 try{
  const d=await api('/api/daily-candidates',90000);dailyFocus=d;updateMarketNews();
  const header=`<div class="daily-heading"><b>日级别候选</b><small>${d.date?escapeHTML(d.date)+' 收盘 · ':''}${d.count}/${d.total} 只覆盖</small></div>`;
  if(!d.ready){el.innerHTML=header+`<p>${escapeHTML(d.reason)}</p>${trackingMarkup(d.tracking)}`;return;}
  const rows=d.rows.map(r=>`<article><div><button class="text-button" data-benchmark="${r.symbol}">${escapeHTML(r.name)}</button><span>${escapeHTML(r.status)}</span></div><p>5 / 20 日强于沪深300 ${r.rs5.toFixed(2)} / ${r.rs20.toFixed(2)} 个百分点</p><p class="candidate-shares">${escapeHTML(r.shareEvidence||'份额依据待补齐')}</p><p>条件：${escapeHTML(r.trigger)}；跌破 <b>${r.invalidation.toFixed(3)}</b> 失效。</p></article>`).join('');
  el.innerHTML=header+`<p class="daily-verdict">${d.marketOK?'沪深300趋势条件通过':'沪深300趋势条件未通过，候选暂观察'} · ${d.qualified?'有 '+d.qualified+' 个方向入选，展示前 '+d.rows.length+' 个':'暂无符合全部条件的方向'}</p>${rows}${trackingMarkup(d.tracking)}<details class="daily-rules"${wasOpen?' open':''}><summary>筛选规则与限制</summary><p>仅供信号日期之后的交易日观察，每个收盘重新筛选，不是已触发的买入指令。需在观察时确认行情仍有效；15 分钟 MACD 不参与本次筛选。份额仅作独立补充证据，不改变排序或自动认定买点。</p><p>条件：收盘价＞20日均线＞60日均线，20日均线高于5个交易日前，5 / 20日收益均强于沪深300。两周期超额收益均值排序，同方向仅保留排名最高的一只。沪深300收盘在20日均线上且均线抬升才通过环境条件；偏离20日均线超过8%时暂观察。</p><p>突破位＝信号日前20个交易日最高价，失效位＝截至信号日最近5个交易日最低价；新候选每日筛选；已记录候选的原突破位、失效位固定，由后续已收盘日线跟踪，盘中不自动判定触发。失效价是观察边界，不保证能在该价退出。${escapeHTML(d.source)}，分红除权可能影响比较；规则尚未回测，不提供胜率或收益承诺。</p></details>`;
 }catch{dailyFocus=null;updateMarketNews();el.innerHTML='<b>日级别候选</b><p>日线获取失败，暂停展示候选，稍后重试。</p>';}
 finally{dailyPending=false;}
}

async function refreshShareData(){await refreshSharesView();renderEtfOverview();}

function currentMarketSummary(){return marketSummary({quote:quotes.get('sh000985'),entry:history.get('sh000985'),breadth,quoteStale:!!(quoteResult?.stale||quoteError)});}

async function refreshEtfFlows(){
 const defs=stocks.filter(n=>['sh510300','sh512100'].includes(n.symbol));let cursor=0;
 await Promise.all(Array.from({length:3},async()=>{while(cursor<defs.length){const n=defs[cursor++];try{flows.set(n.symbol,await api('/api/money-flow?symbol='+n.symbol));}catch{flows.set(n.symbol,{...flows.get(n.symbol),stale:true});}}}));renderBenchmark();
}
window.addEventListener('gp-news-updated',()=>renderBenchmark());
function updateMarketNews(){
 updateNewsMarket({history,flows,shares:currentSharesSnapshot(),quoteStale:!!(quoteResult?.stale||quoteError)});
}

function trackingMarkup(t){
 if(!t||t.error)return `<div class="candidate-tracking"><b>跨日跟踪</b><p>${escapeHTML(t?.error||'等待跟踪记录')}</p></div>`;
 const all=t.items||[],active=all.filter(r=>!r.terminal),shown=[...active,...all.filter(r=>r.terminal)].slice(0,3);
 const rows=shown.map(r=>`<article><div><button class="text-button" data-benchmark="${r.symbol}">${escapeHTML(r.name)}</button><b>${escapeHTML(r.status)}</b></div><p>${r.signalDate} 原条件 · 突破 ${r.resistance.toFixed(3)} / 失效 ${r.invalidation.toFixed(3)} · 截至 ${r.asOf}（${r.age}/10个交易日）</p><p>${escapeHTML(r.blocked||r.gate||r.events.at(-1)?.reason||'等待下一交易日')}${r.confirmedAt?'；曾于 '+r.confirmedAt+' 确认条件':''}</p></article>`).join('');
 return `<div class="candidate-tracking"><b>跨日跟踪 · ${active.length} 个观察中</b>${rows||'<p>当前暂无候选记录；后续产生候选时自动保存原条件，不补造历史信号。</p>'}<details class="tracking-detail"${document.querySelector('#dailyCandidates .tracking-detail')?.open?' open':''}><summary>原条件与状态记录（${all.length} 条）</summary><p>从 ${escapeHTML(new Date(t.startedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}))} 开始记录实际出现的合格候选，同方向已有有效记录时沿用原价位。最多观察10个后续交易日。</p><p>规则：收盘突破原价位 → 后续交易日最低价进入原突破位±1%且收盘守住 → 再后续交易日收盘超过回踩日高点，标记“条件已确认”。市场条件未通过或偏离MA20超过8%时暂停向确认推进；最低价跌破原失效位优先判失效，同日触发和失效并存时不推测先后。收盘跌回突破位下方则重新等待突破。</p><p>只用已收盘日线；缺口或来源异常暂停判断，保留上次记录。份额不参与触发；条件确认不是买入指令。满10个交易日结束本轮观察，未复权及除权影响需人工核实。</p>${all.map(r=>`<p><b>${escapeHTML(r.name)} · ${r.signalDate}</b><br>实际记录于 ${escapeHTML(new Date(r.observedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}))}<br>${r.events.map(e=>`${e.date} ${escapeHTML(e.label)}：${escapeHTML(e.reason)}`).join('<br>')}</p>`).join('')}</details></div>`;
}

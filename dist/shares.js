import {etfCapital} from './etf-capital.js';
let snapshot=null,pending=false;
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct=n=>(n>0?'+':'')+n.toFixed(2)+'%';
const units=n=>(n/1e8).toFixed(3)+'亿份';
function issue(d){return d.error||Object.values(d.sources||{}).some(s=>s.error);}
export function sharesOverviewText(){
 const d=snapshot;if(!d)return '日份额：正在读取，不属于盘中资金数据。';
 if(d.failed)return '日份额：接口暂不可用，暂停合并判断。';
 const suffix=issue(d)?'；来源异常，保留历史值':d.progress.running?'；历史补齐中':'';
 if(!d.ready)return `日份额：${d.target?'目标日期 '+d.target+'，':''}相邻交易日有效覆盖 ${d.count}/${d.total}，暂不判断整体增减${suffix}。`;
 return `监测ETF日份额（含港股参照）截至 ${d.target}：${d.up} 个方向增加、${d.down} 个减少、${d.flat} 个持平${d.split?'、'+d.split+' 个产品间分歧':''}（覆盖 ${d.units}/${d.totalUnits} 个方向）${suffix}；非实时申赎。`;
}
export async function refreshSharesView(){
 if(pending)return;pending=true;
 const el=document.getElementById('etfShares'),open=el.querySelector('details')?.open;
 try{
  const r=await fetch('/api/etf-shares',{signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error();const d=await r.json();snapshot=d;
  const change=w=>w?.ready?`<span>${pct(w.pct)}</span><small>${w.delta>0?'+':''}${units(w.delta)}</small>`:`<span title="${esc(w?.reason||'暂无数据')}">—</span>`;
  const rows=d.items.map(n=>`<tr><td><button class="text-button" data-benchmark="${n.symbol}">${esc(n.name)}</button></td><td>${n.date||'—'}${n.lag?'<small>落后 '+n.lag+' 个交易日</small>':''}</td><td>${n.available?units(n.shares):'—'}</td><td>${change(n.day)}</td><td>${change(n.five)}</td><td>${change(n.twenty)}</td><td>${n.streak?'连续'+n.streak+'日'+(n.direction>0?'增加':'减少'):'—'}</td><td>${esc(n.relation||n.day?.reason||'暂无同日对照')}<small>${n.count}/61 日覆盖</small></td></tr>`).join('');
  const status=d.progress.running?`历史补齐中 ${d.progress.done}/${d.progress.total} 批`:`${d.complete}/${d.total} 只取得61个交易日份额`;
  el.innerHTML=`<details${open?' open':''}><summary>份额数据 · ${d.total} 只明细 <small>${esc(status)}</small></summary><p>目标日期 ${d.target||'等待交易日日线'}；日份额清算后公布，盘中沿用最近已公布值。1／5／20日变化须覆盖完整交易日，缺口不补零。</p><div class="shares-table"><table><thead><tr><th>ETF</th><th>份额日期</th><th>总份额</th><th>单日变化</th><th>5日变化</th><th>20日变化</th><th>连续性</th><th>同日价格对照</th></tr></thead><tbody>${rows}</tbody></table></div><p>上交所：${esc(d.sources.sh?.error||d.sources.sh?.status||'等待获取')}；深交所：${esc(d.sources.sz?.error||d.sources.sz?.status||'等待获取')}。${esc(d.error||'')}最近检查：${esc(d.lastAttempt?new Date(d.lastAttempt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—')}。</p><p>交易日基准取沪深300已收盘日线。单日份额变化超过25%标为待核实，跨越该日的增减判断暂停；此规则无法识别全部拆分、合并等非申赎变化。未接入基金公司份额折算事件，原始份额变化仅作观察，不等于现金流或机构身份。价格对照仅使用同日及前一交易日收盘数据。每个跟踪指数仅保留一只代表ETF，各方向独立计票；不把不同ETF的份额相加为资金金额。</p><p>后台启动时补齐历史，随后北京时间8—9点、16—22点每小时检查一次，并复查最近5个交易日修订；无需页面保持打开。</p></details>`;
 }catch{snapshot={failed:true};el.innerHTML='<p>份额接口暂不可用，稍后重试。</p>';}
 finally{pending=false;}
}

const money=n=>Number.isFinite(n)?(n>=0?'+':'')+(n/1e8).toFixed(2)+'亿':'—';
export function renderCapitalView(input){
 const el=document.getElementById('etfCapital');if(!el)return;
 const open=el.querySelector('details')?.open,d=etfCapital({...input,shares:snapshot});
 const trade=d.tradeReady?`监测 A 股 ETF 成交 ${(d.amount/1e8).toFixed(2)} 亿元，成交最活跃：${d.active.map(n=>n.name).join('、')}。`:`成交额覆盖 ${d.tradeCount}/${d.total}，暂不判断整体活跃度。`;
 const named=rows=>rows.map(n=>`${n.name} ${money(n.share.day.marketValue)}`).join('、');
 const share=d.shareReady?`份额增加 ${d.up} 只、减少 ${d.down} 只。${d.increases.length?'增加折算额较大：'+named(d.increases)+'。':''}${d.decreases.length?'减少折算额较大：'+named(d.decreases)+'。':''}`:`有效份额覆盖 ${d.shareCount}/${d.total}，等待公布或来源恢复。`;
 const selected=d.items.find(n=>n.symbol===input.selected),s=selected?.share;
 const value=w=>w?.ready?`${pct(w.pct)} / ${money(w.marketValue)}`:'待补齐';
 const detail=selected?`<p><b>${esc(selected.name)}</b> · ${esc(selected.relation)}${selected.shareOK?'（'+s.date+'）':''}</p><p>成交额 ${selected.amount===null?'待确认':(selected.amount/1e8).toFixed(2)+' 亿'}${selected.tradeOK?' · '+selected.date+' '+selected.time:''}；同期成交 ${selected.turnover?selected.turnover.ratio.toFixed(2)+' 倍（前 '+selected.turnover.count+' 日同分钟均值）':'基线待补齐'}。</p>${selected.shareOK?`<p>份额单日 ${s.day.delta>=0?'+':''}${units(s.day.delta)}；5日 ${s.five.ready?pct(s.five.pct):'待补齐'}；20日 ${s.twenty.ready?pct(s.twenty.pct):'待补齐'}${s.streak?'；连续 '+s.streak+' 日'+(s.direction>0?'增加':'减少'):''}。</p>`:''}`:'<p class="muted">点选 ETF 标签，查看成交、份额与同日价格的联合分析。</p>';
 const rows=d.items.map(n=>`<tr><td><button class="text-button" data-benchmark="${n.symbol}">${esc(n.name)}</button>${n.market==='HK'?'<small>港股参照</small>':''}</td><td>${n.amount===null?'—':(n.amount/1e8).toFixed(2)+'亿'}<small>${n.date||''} ${n.time||''}</small></td><td>${n.turnover?n.turnover.ratio.toFixed(2)+'倍':'—'}</td><td>${n.shareOK?value(n.share.day):'待确认'}</td><td>${n.shareOK?value(n.share.five):'待确认'}</td><td>${n.shareOK?value(n.share.twenty):'待确认'}</td><td>${esc(n.relation)}<small>${n.share?.date||''}</small></td></tr>`).join('');
 el.innerHTML=`<div class="daily-heading"><b>ETF 成交与申赎观察</b><small>成交 ${d.date||'待更新'} ${d.time||''} · 份额 ${d.shareDate||'待公布'}</small></div><p>${esc(trade)}</p><p>${esc(share)}</p>${detail}<details${open?' open':''}><summary>全部 ETF 资金量与份额明细</summary><div class="shares-table"><table><thead><tr><th>ETF</th><th>成交额</th><th>同期额倍数</th><th>1日份额% / 折算额</th><th>5日</th><th>20日</th><th>同日价份关系</th></tr></thead><tbody>${rows}</tbody></table></div><p>成交额反映买卖活跃度，不是净流入。份额净变化＝期末−期初，是净申赎方向的代理，无法拆分申购总量与赎回总量。折算额＝逐日份额变化×当日收盘价后求和，不使用期末价一次相乘；这不是净值口径或真实现金净流入。缺少当日价格时不折算。价份关系只比较份额日期的已收盘价格，不与今天盘中行情强行合并。</p><p>拆分、合并等也会改变份额；超过25%的单日变化暂停推断，仍可能遗漏其他份额事件。逆势增份额不代表价格即将反弹，套利也可能影响申赎。港股不参与A股汇总；汇总仅代表监测的ETF。份额清算后更新，盘中成交随行情刷新；同期基线随点选加载。</p><a href="https://www.sse.com.cn/assortment/fund/etf/question/" target="_blank" rel="noopener noreferrer">上交所 ETF 申赎说明</a></details>`;
}

export function currentSharesSnapshot(){return snapshot;}

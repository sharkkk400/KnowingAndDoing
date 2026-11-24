import {instruments} from './instruments.js';
import {analyzeNewsMarket,newsMarketHighlights,newsForSymbol} from './news-market.js';
let payload=null,marketContext=null,analyses=[],busy=false,failed=false;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stamp=n=>n.datePrecision==='day'?n.publishedAt.slice(0,10)+'（发布日期）':new Date(n.publishedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
export function updateNewsMarket(context){
 marketContext=context;
 analyses=analyzeNewsMarket(payload?.items||[],instruments,context);
 return failed||payload?.stale?[]:newsMarketHighlights(analyses);
}
export function symbolNewsMarkup(symbol){
 const row=newsForSymbol(analyses,symbol)[0];
 if(!row)return `<div class="inline-news muted">${payload?'暂无明确关联资讯':'资讯读取中…'}</div>`;
 const {news:n,response:r}=row,topic=r.kind==='direct'?'公司或指数消息':r.association.split('，')[0],origin=(n.origins||[{source:n.source,url:n.url}])[0];
 let impact;
 if(failed||payload?.stale)impact='来源异常，影响待核实';
 else if(r.status==='已有响应')impact=`${r.price>0?'向上':'向下'}响应 · 成交放大 ${r.volumeRatio.toFixed(1)} 倍`;
 else if(r.status==='响应衰减')impact=topic+' · 早期响应减弱';
 else if(r.status==='暂无明显响应')impact=topic+' · 暂未明显响应';
 else impact=topic+' · '+(r.reason.includes('盘后')?'盘后待验证':'影响待验证');
 return `<div class="inline-news" data-symbol-news="${esc(symbol)}"><a href="${esc(origin?.url||n.url)}" target="_blank" rel="noopener noreferrer" title="${esc(stamp(n))} · ${esc(origin?.source||n.source)}">${esc(n.title)} ↗</a><span>影响：${esc(impact)}</span></div>`;
}
async function load(){
 if(busy)return;busy=true;
 try{const r=await fetch('/api/news',{signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error('资讯读取失败');payload=await r.json();failed=false;}catch{failed=true;}
 finally{busy=false;if(marketContext)updateNewsMarket(marketContext);window.dispatchEvent(new Event('gp-news-updated'));}
}
void load();setInterval(()=>void load(),30000);

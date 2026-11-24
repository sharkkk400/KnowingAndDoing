import {instruments} from './dist/instruments.js';
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {createHash} from 'node:crypto';
export const NEWS_SOURCE='新浪财经 7×24';
export const categories=['政策监管','宏观经济','海外市场','行业动态','公司事件','市场动态'];
const rules=[
 {category:'政策监管',keywords:['国务院','证监会','央行','发改委','财政部','金融监管','降准','降息','监管新规','关税'],factor:'政策与流动性',note:'关注政策适用范围、生效时间和执行细则；再观察利率、成交额与相关板块反应。'},
 {category:'宏观经济',keywords:['CPI','PPI','PMI','非农','通胀','GDP','失业率','社融','人民币','汇率','国债收益率','进出口'],factor:'增长、利率与汇率',note:'需要比较数据与市场预期的差异；汇率和利率变化可能影响估值及进出口企业。'},
 {category:'海外市场',keywords:['美联储','美股','纳斯达克','标普','道琼斯','欧洲央行','日本央行','地缘','停火','冲突','伊朗','乌克兰','俄罗斯'],factor:'海外风险偏好',note:'可能通过海外股市、汇率及风险偏好传导；A 股是否跟随仍需盘面验证。'},
 {category:'行业动态',keywords:['原油','石油','天然气','黄金','铜价','煤炭','钢铁'],factor:'商品与成本',note:'价格变化可能改变上下游成本和利润分配；需区分受益端与成本承压端。'},
 {category:'行业动态',keywords:['半导体','芯片','算力','人工智能','AI','英伟达','光伏','锂电','电池','新能源汽车','白酒','房地产','银行业'],factor:'产业需求与供给',note:'关注订单、价格、产能和竞争变化；行业消息不等于每家相关公司都会受益。'},
 {category:'公司事件',keywords:['公告','回购','减持','增持','业绩','净利润','收购','重组','订单','停牌','复牌','分红'],factor:'公司基本面与供给',note:'回到公司公告核实金额、比例和实施条件；区分计划、进展和已完成事项。'}
];
const watchTerms=instruments.map(n=>[n.code,[n.name.replace(/ ETF.*$/, '')]]);
export function cleanText(value){return String(value||'').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#(\d+);/g,(_,n)=>Number(n)<0x110000?String.fromCodePoint(Number(n)):'').replace(/\s+/g,' ').trim();}
export function classify(text){
 const matches=rules.map(r=>({...r,hits:r.keywords.filter(k=>k==='AI'?/\bAI\b/i.test(text):text.toLowerCase().includes(k.toLowerCase()))})).filter(r=>r.hits.length).filter(r=>!(r.category==='公司事件'&&/国债|财政部|逆回购/.test(text)&&r.hits.every(k=>k==='回购')));
 return {category:matches[0]?.category||'市场动态',categories:[...new Set(matches.map(r=>r.category))],factors:matches.map(({factor,note,hits})=>({name:factor,note,hits})),watchCodes:watchTerms.filter(([,terms])=>terms.some(t=>text.includes(t))).map(([code])=>code)};
}
function articleUrl(item){let ext={};try{ext=JSON.parse(item.ext||'{}');}catch{}
 for(const value of [item.docurl,ext.docurl]){try{const u=new URL(value);if(u.protocol==='https:'&&(u.hostname==='sina.cn'||u.hostname.endsWith('.sina.cn')||u.hostname==='sina.com.cn'||u.hostname.endsWith('.sina.com.cn')))return u.href;}catch{}}
 return 'https://finance.sina.com.cn/7x24/';
}
export function parseNews(json){
 const feed=json?.result?.data?.feed?.list;
 if(json?.result?.status?.code!==0||!Array.isArray(feed))throw Error('资讯源格式异常');
 return feed.filter(i=>!Number(i.is_delete)).map(item=>{
 const body=cleanText(item.rich_text);const stamp=String(item.create_time||'');
 if(!body||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stamp))return null;
 const publishedAt=stamp.replace(' ','T')+'+08:00';if(!Number.isFinite(Date.parse(publishedAt)))return null;
 const heading=body.match(/^【([^】]+)】/);
 const title=heading?heading[1]:body.length>82?body.slice(0,82)+'…':body;
 return {id:'sina-'+String(item.id),title,body,publishedAt,source:NEWS_SOURCE,url:articleUrl(item),publisherImportant:Number(item.is_focus)>0,fingerprint:createHash('sha256').update(body.replace(/[\s\p{P}]/gu,'')).digest('hex'),...classify(body)};
 }).filter(Boolean);
}
export function makeItem(source,id,title,body,publishedAt,url,extra={}) {
 title=cleanText(title);body=cleanText(body)||title;
 if(!title||!Number.isFinite(Date.parse(publishedAt)))return null;
 return {id:source.id+'-'+id,title,body,publishedAt,source:source.name,sourceId:source.id,url,publisherImportant:false,fingerprint:createHash('sha256').update(body.replace(/[\s\p{P}]/gu,'')).digest('hex'),...classify(body),...extra};
}
// Matches the public web client's parameter checksum; no user token is used.
export function clsEndpoint(){
 const params={app:'CailianpressWeb',category:'',last_time:Math.floor(Date.now()/1000),os:'web',refresh_type:1,rn:50,sv:'8.7.9'};
 const query=Object.keys(params).sort().map(k=>k+'='+params[k]).join('&');
 const sign=createHash('md5').update(createHash('sha1').update(query).digest('hex')).digest('hex');
 return 'https://www.cls.cn/v1/roll/get_roll_list?'+query+'&sign='+sign;
}
export function parseCls(json){
 if(Number(json?.errno)!==0||!Array.isArray(json?.data?.roll_data))throw Error('财联社返回异常');
 return json.data.roll_data.filter(n=>!n.is_ad&&/^\d+$/.test(String(n.id))&&Number.isFinite(n.ctime)&&n.ctime>0).map(n=>{
 const body=cleanText(n.content);const title=cleanText(n.title)||body.match(/^【([^】]+)】/)?.[1]||body.slice(0,82);
 return makeItem({id:'cls',name:'财联社'},n.id,title,body,new Date(n.ctime*1000).toISOString(),'https://www.cls.cn/detail/'+n.id,{publisherImportant:n.level==='A'||n.level==='B'});
 }).filter(Boolean);
}
export function parsePolicy(json){
 if(!Array.isArray(json))throw Error('政策格式异常');
 return json.filter(n=>/^https:\/\/www\.gov\.cn\//.test(n.URL)&&/^\d{4}-\d{2}-\d{2}$/.test(n.DOCRELPUBTIME)).map(n=>makeItem({id:'gov',name:'中国政府网'},n.URL,n.TITLE,n.TITLE,n.DOCRELPUBTIME+'T00:00:00+08:00',n.URL,{datePrecision:'day',retentionDays:30,category:'政策监管',categories:['政策监管']})).filter(Boolean);
}
export function parseAnnouncements(json){
 if(!Array.isArray(json?.announcements))throw Error('公告格式异常');
 return json.announcements.filter(n=>/^finalpage\/[\d/-]+\/[\w.-]+\.PDF$/i.test(n.adjunctUrl)).map(n=>{
 const date=n.adjunctUrl.match(/finalpage\/(\d{4}-\d{2}-\d{2})\//)?.[1];
 return makeItem({id:'cninfo',name:'巨潮资讯'},n.announcementId,n.secName+' · '+cleanText(n.announcementTitle),n.secName+'（'+n.secCode+'）公告：'+cleanText(n.announcementTitle),date?date+'T00:00:00+08:00':'', 'https://static.cninfo.com.cn/'+n.adjunctUrl,{datePrecision:'day',retentionDays:30,category:'公司事件',categories:['公司事件'],watchCodes:watchTerms.some(([c])=>c===n.secCode)?[n.secCode]:[]});
 }).filter(Boolean);
}
export function mergeNews(old,incoming,now=Date.now()){
 const byId=new Map(old.map(n=>[n.id,n]));incoming.forEach(n=>{const prior=byId.get(n.id);byId.set(n.id,prior?.fingerprint===n.fingerprint?{...n,firstObservedAt:prior.firstObservedAt||n.firstObservedAt,origins:prior.origins}:n);});
 const grouped=new Map();
 for(const n of [...byId.values()].filter(n=>Date.parse(n.publishedAt)>now-(n.retentionDays||2)*86400000&&Date.parse(n.publishedAt)<now+300000).sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt))){
 const origins=n.origins||[{sourceId:n.sourceId||'sina',source:n.source,url:n.url}];
 const existing=grouped.get(n.fingerprint);
 if(existing){existing.origins=[...new Map([...existing.origins,...origins].map(o=>[o.url+'|'+o.sourceId,o])).values()];}
 else grouped.set(n.fingerprint,{...n,sourceId:n.sourceId||'sina',origins});
 }return [...grouped.values()].slice(0,1200);
}
const sources=[
 {id:'sina',name:NEWS_SOURCE,url:'https://finance.sina.com.cn/7x24/',interval:90,endpoint:'https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=100&zhibo_id=152',parse:parseNews},
 {id:'gov',name:'中国政府网',url:'https://www.gov.cn/zhengce/zuixin/',interval:900,endpoint:'https://www.gov.cn/zhengce/zuixin/ZUIXINZHENGCE.json',parse:parsePolicy},
 {id:'cls',name:'财联社',url:'https://www.cls.cn/telegraph',interval:90,endpoint:clsEndpoint,parse:parseCls},
 {id:'jin10',name:'金十数据',url:'https://www.jin10.com/',blocked:'待接入：公开接口返回 502，需确认可用数据接口及授权'}
];
const directory=new URL('./data/',import.meta.url);let items=[],pending=null;
const states=new Map(sources.map(s=>[s.id,{lastSuccessAt:null,lastAttemptAt:null,error:null,failures:0,nextAttempt:0,count:0}]));
export async function refreshNews(){
 if(pending)return pending;
 pending=(async()=>{
 await Promise.all(sources.filter(s=>!s.blocked).map(async s=>{
 const state=states.get(s.id);if(Date.now()<state.nextAttempt)return;
 state.lastAttemptAt=new Date().toISOString();
 try{
 const response=await fetch(typeof s.endpoint==='function'?s.endpoint():s.endpoint,{...s.options,signal:AbortSignal.timeout(12000),headers:{'User-Agent':'Mozilla/5.0',Referer:s.url,...s.options?.headers}});
 if(!response.ok)throw Error('HTTP '+response.status);
 const payload=await response.json(),observedAt=new Date().toISOString();
 const fresh=s.parse(payload).map(n=>({...n,firstObservedAt:observedAt}));if(!fresh.length)throw Error('未返回有效条目');
 items=mergeNews(items,fresh).filter(n=>n.sourceId!=='cninfo'&&!n.categories?.includes('公司事件'));state.count=fresh.length;state.lastSuccessAt=new Date().toISOString();state.recentSuccesses=[...(state.recentSuccesses||[]),state.lastSuccessAt].slice(-2000);state.error=null;state.failures=0;
 }catch(e){state.error=e.message;state.failures++;}
 state.nextAttempt=Date.now()+Math.min(s.interval*1000*2**Math.min(state.failures,4),3600000);
 }));
 try{await mkdir(directory,{recursive:true});await writeFile(new URL('news.json.tmp',directory),JSON.stringify({items,states:Object.fromEntries(states)}));await rename(new URL('news.json.tmp',directory),new URL('news.json',directory));}catch(e){console.error('资讯缓存保存失败:',e.message);}
 })();try{await pending;}finally{pending=null;}
}
export function getNews(){
 const visible=mergeNews(items,[]).filter(n=>n.sourceId!=='cninfo'&&!n.categories?.includes('公司事件')).map(n=>({...n,watchCodes:[...new Set([...classify(n.title+' '+n.body).watchCodes,...(n.watchCodes||[]).filter(c=>watchTerms.some(([code])=>code===c))])]}));
 const channels=sources.map(s=>{const t=states.get(s.id);return {id:s.id,name:s.name,url:s.url,intervalSeconds:s.interval||null,lastSuccessAt:t.lastSuccessAt,recentSuccesses:t.recentSuccesses||[],lastAttemptAt:t.lastAttemptAt,error:s.blocked||t.error,count:visible.filter(n=>n.origins.some(o=>o.sourceId===s.id)).length,status:s.blocked?'pending':t.error?'error':!t.lastSuccessAt?'loading':Date.now()-Date.parse(t.lastSuccessAt)>s.interval*2000?'stale':'connected'};});
 const healthy=channels.filter(s=>s.status==='connected');
 return {items:visible,sources:channels,source:'多源资讯',lastSuccessAt:channels.map(s=>s.lastSuccessAt).filter(Boolean).sort().at(-1)||null,newestPublishedAt:visible[0]?.publishedAt||null,stale:!healthy.length,error:!healthy.length?'暂无健康来源':null,method:'关键词仅用于线索发现；相同内容合并保留来源，不代表独立核实。'};
}
export async function startNewsCollector(){
 try{const saved=JSON.parse(await readFile(new URL('news.json',directory),'utf8'));if(Array.isArray(saved.items))items=mergeNews(saved.items,[]);for(const [id,state] of Object.entries(saved.states||{}))if(states.has(id))states.set(id,{...states.get(id),...state,nextAttempt:0});}catch(e){if(e.code!=='ENOENT')console.error('历史资讯读取失败');}
 void refreshNews();const timer=setInterval(()=>void refreshNews(),15000);timer.unref();return timer;
}

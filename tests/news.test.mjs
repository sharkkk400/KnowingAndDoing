import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseNews,mergeNews,classify,cleanText} from '../news.mjs';
function payload(list){return {result:{status:{code:0},data:{feed:{list}}}};}
const item={id:1,create_time:'2026-10-09 10:00:00',rich_text:'【上汽集团业绩公告】上汽集团公布净利润及电池订单。',docurl:'https://finance.sina.cn/test'};
test('provider time, category, watchlist and neutral factor mapping',()=>{const [n]=parseNews(payload([item]));assert.equal(n.publishedAt,'2026-10-09T10:00:00+08:00');assert.deepEqual(n.watchCodes,[]);assert(n.categories.includes('公司事件'));assert(n.factors.some(f=>f.hits.includes('电池')));assert.equal(n.url,item.docurl);assert(!classify('普通天气消息').watchCodes.length);});
test('reject malformed feed, unsafe URL and HTML',()=>{assert.throws(()=>parseNews({}));assert.equal(parseNews(payload([{...item,create_time:'bad'}])).length,0);assert.equal(parseNews(payload([{...item,is_delete:1}])).length,0);const [n]=parseNews(payload([{...item,docurl:'javascript:alert(1)',rich_text:'<script>alert(1)</script><b>央行公告</b>'}]));assert.equal(n.url,'https://finance.sina.com.cn/7x24/');assert.equal(n.body,'央行公告');assert.equal(cleanText('<img src=x onerror=evil>消息'),'消息');});
test('merge removes duplicate content, updates IDs and enforces time window',()=>{const now=Date.parse('2026-10-09T12:00:00+08:00');const [a,b]=parseNews(payload([item,{...item,id:2,create_time:'2026-10-09 11:00:00'}]));assert.equal(mergeNews([a],[b],now).length,1);const [updated]=parseNews(payload([{...item,rich_text:'更新后的公司公告'}]));assert.equal(mergeNews([a],[updated],now)[0].body,updated.body);assert.equal(mergeNews([a],[],now+49*3600000).length,0);assert.equal(mergeNews([a],[],now-24*3600000).length,0);});

test('official documents preserve date precision and safe links',async()=>{
 const {parsePolicy,parseAnnouncements}=await import('../news.mjs');
 const p=parsePolicy([{TITLE:'国务院政策',URL:'https://www.gov.cn/zhengce/test.htm',DOCRELPUBTIME:'2026-10-08'}])[0];
 assert.equal(p.datePrecision,'day');assert.equal(p.category,'政策监管');
 assert.equal(parsePolicy([{TITLE:'坏链接',URL:'https://evil.example/',DOCRELPUBTIME:'2026-10-08'}]).length,0);
 const n=parseAnnouncements({announcements:[{secCode:'600104',secName:'上汽集团',announcementId:'123',announcementTitle:'<b>业绩公告</b>',adjunctUrl:'finalpage/2026-10-08/123.PDF'}]})[0];
 assert.deepEqual(n.watchCodes,[]);assert.equal(n.publishedAt,'2026-10-08T00:00:00+08:00');assert.equal(n.datePrecision,'day');
 assert.equal(mergeNews([p],[],Date.parse('2026-10-15T12:00:00+08:00')).length,1);
});
test('cross-source duplicate retains both original links',async()=>{
 const {makeItem}=await import('../news.mjs');const now=Date.parse('2026-10-09T12:00:00+08:00');
 const a=makeItem({id:'sina',name:'新浪'},'1','消息','相同消息','2026-10-09T10:00:00+08:00','https://finance.sina.cn/a');
 const b=makeItem({id:'cls',name:'财联社'},'2','消息','相同消息','2026-10-09T10:01:00+08:00','https://www.cls.cn/detail/2');
 const merged=mergeNews([a],[b],now);assert.equal(merged.length,1);assert.equal(merged[0].origins.length,2);assert.equal(mergeNews(merged,[b],now)[0].origins.length,2);
});
test('CLS rejects error payload and ads, maps unix source time',async()=>{
 const {parseCls}=await import('../news.mjs');assert.throws(()=>parseCls({errno:10012}));
 const input={id:123,ctime:1791483774,content:'上汽集团电池订单',level:'B'};
 const rows=parseCls({errno:0,data:{roll_data:[input,{...input,is_ad:1}]}});
 assert.equal(rows.length,1);assert.equal(rows[0].publishedAt,new Date(input.ctime*1000).toISOString());assert.equal(rows[0].sourceId,'cls');assert.deepEqual(rows[0].watchCodes,[]);
});

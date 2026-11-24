// Market data for the pinned Resonance replay, including the pre-period for indicators.
import {writeFile} from 'node:fs/promises';
const end='2026-11-18',start='2024-06-01';
const symbols=['sh510300','sh510050','sh510500','sh512100','sh515080','sh588000','sh589680','sz159780','sz159352','sh000300'];
const prices={};
for(const s of symbols){
 const u='https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param='+[s,'day',start,end,640,'qfq'].join(',');
 const n=(await(await fetch(u)).json()).data[s];prices[s.slice(2)]=n.qfqday||n.day;
}
const turnover={};
for(const secid of ['1.000001','0.399106']){
 const u='https://push2his.eastmoney.com/api/qt/stock/kline/get?secid='+secid+'&klt=101&fqt=0&beg=20240401&end=20261118&fields1=f1,f2&fields2=f51,f52,f53,f54,f55,f56,f57';
 turnover[secid]=Object.fromEntries((await(await fetch(u)).json()).data.klines.map(x=>{const a=x.split(',');return [a[0],Number(a[6])/1e8];}));
}
const margin={};
for(let page=1;page<=2;page++){
 const u='https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_WEB_MARGIN_DAILYTRADE&columns=ALL&pageSize=500&sortColumns=STATISTICS_DATE&sortTypes=-1&pageNumber='+page;
 for(const r of (await(await fetch(u)).json()).result.data)margin[r.STATISTICS_DATE.slice(0,10)]=r.FIN_BALANCE;
}
await writeFile(new URL('../data/resonance-review/inputs.json',import.meta.url),JSON.stringify({prices,turnover,margin}));

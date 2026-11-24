import {readFile, writeFile, rename} from 'node:fs/promises';
import {sse,szse} from '../shares.mjs';
import {instruments} from '../dist/instruments.js';
const root=new URL('../data/',import.meta.url);
const read=async name=>JSON.parse(await readFile(new URL(name,root),'utf8'));
const path=new URL('etf-share-history.json',root);
let archive=[];
try { archive=(await read('etf-share-history.json')).rows; } catch(e){if(e.code!=='ENOENT')throw e;}
const versions=new Map(), present=new Set(), expected=new Map();
function add(rows){
 for(const r of rows){
  const key=r.symbol+'|'+r.date, version=key+'|'+r.fetchedAt;
  versions.set(version,r);present.add(key);
 }
}
add(archive);add((await read('etf-shares.json')).rows);
const extended=process.argv.includes('--since-2024')?await read('minute-research/annual-daily.json'):null;
for(const d of instruments.filter(d=>d.sector.endsWith('ETF'))){
 for(const b of extended?extended[d.symbol].filter(b=>b.date>='2024-01-01'):(await read('daily/'+d.symbol+'.json')).bars){
  if(!expected.has(b.date))expected.set(b.date,[]);
  expected.get(b.date).push(d.symbol);
 }
}
const tasks=[];
for(const prefix of ['sh','sz']){
 const dates=[...expected.keys()].sort().filter(date=>expected.get(date).some(s=>s.startsWith(prefix)&&!present.has(s+'|'+date)));
 const size=prefix==='sh'?1:5;
 for(let i=0;i<dates.length;i+=size){
  const chunk=dates.slice(i,i+size);
  tasks.push(async()=>add(prefix==='sh'?await sse(chunk[0]):await szse(chunk[0],chunk.at(-1))));
 }
}
let cursor=0;
await Promise.all(Array.from({length:4},async()=>{while(cursor<tasks.length){
 const task=tasks[cursor++];try{await task();}catch(e){console.error(e.message);}
}}));
const tmp=new URL('etf-share-history.tmp',root);
await writeFile(tmp,JSON.stringify({version:1,rows:[...versions.values()]}));await rename(tmp,path);
const missing=[...expected].flatMap(([date,symbols])=>symbols.filter(s=>!present.has(s+'|'+date)).map(s=>s+'|'+date));
console.log('expected', [...expected.values()].flat().length,'missing',missing.length,missing.slice(0,15));

import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
const root=new URL('./data/daily/',import.meta.url);
const path=s=>{if(!/^(sh|sz)\d{6}$/.test(s))throw Error('无效日线标的');return new URL(s+'.json',root);};
export function mergeDaily(old,bars,now=Date.now()){
 const map=new Map();
 for(const b of [...old,...bars]){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(b.date)||![b.close,b.high,b.low].every(n=>Number.isFinite(n)&&n>0)||b.low>b.close||b.high<b.close)throw Error('日线存储字段异常');
  if(Date.parse(b.date+'T15:05:00+08:00')<=now)map.set(b.date,b);
 }
 return [...map.values()].sort((a,b)=>a.date.localeCompare(b.date)).slice(-500);
}
export async function loadDaily(symbol){
 try{const d=JSON.parse(await readFile(path(symbol),'utf8'));if(d.symbol!==symbol)throw Error('标的不符');return {...d,bars:mergeDaily([],d.bars)};}catch{return null;}
}
export async function saveDaily(symbol,data){
 const old=await loadDaily(symbol),bars=mergeDaily(old?.bars||[],data.bars);
 const saved={...data,symbol,bars,savedAt:new Date().toISOString()};
 await mkdir(root,{recursive:true});const file=path(symbol),tmp=new URL(symbol+'.tmp',root);
 await writeFile(tmp,JSON.stringify(saved));await rename(tmp,file);return saved;
}
export function dailyCoverage(bars,expected){const dates=new Set(bars.map(b=>b.date));const missing=expected.filter(d=>!dates.has(d));return {expected:expected.length,count:expected.length-missing.length,missing,from:expected[0],to:expected.at(-1),complete:expected.length===30&&!missing.length};}

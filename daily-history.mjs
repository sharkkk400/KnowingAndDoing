import {getDaily} from './market-context.mjs';
import {instruments} from './dist/instruments.js';
import {dailyCoverage} from './daily-store.mjs';
let pending;
export async function backfillDaily(){
 if(pending)return pending;
 pending=(async()=>{
  const benchmark=await getDaily('sh000300');
  if(benchmark.stale||!benchmark.bars?.length)throw Error('交易日基准不可用，无法核对30日覆盖');
  const expected=benchmark.bars.slice(-30).map(b=>b.date),items=[];let cursor=0;
  await Promise.all(Array.from({length:3},async()=>{while(cursor<instruments.length){const d=instruments[cursor++],daily=await getDaily(d.symbol);items.push({...d,...dailyCoverage(daily.bars||[],expected),stored:daily.bars?.length||0,savedAt:daily.savedAt,stale:daily.stale,error:daily.error});}}));
  return {from:expected[0],to:expected.at(-1),total:items.length,complete:items.filter(d=>d.complete&&d.savedAt).length,unavailable:items.filter(d=>d.stale).length,items};
 })();try{return await pending;}finally{pending=null;}
}

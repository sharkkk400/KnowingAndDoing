import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile);
// The threshold is the one tested in the regime strategy. Keep reserved slots frozen.
export const pentadPolicy = Object.freeze({
  version:'regime-pentad-v1', entryCrowdingZ:1, reference:'Pentad 49487f4',
  referenceMode:'comparison', referenceHoldings:5, referenceBuffer:15, referenceInterval:5
});

export function applyEntryCrowding(plan, holdings, amounts) {
  plan.pentadPolicy=pentadPolicy;
  if(plan.market.regime!=='strong')return;
  for(const item of plan.items){
    if(!amounts.has(item.symbol)||holdings.has(item.symbol)||!item.entryRule?.enabled)continue;
    const amounts60=item.evidence?.slice(-60).map(b=>b.close*b.volume);
    if(amounts60?.length!==60||!amounts60.every(v=>Number.isFinite(v)&&v>=0))continue;
    const avg=values=>values.reduce((a,b)=>a+b,0)/values.length;
    const mean=avg(amounts60), sd=Math.sqrt(avg(amounts60.map(v=>(v-mean)**2)));
    const recent=avg(amounts60.slice(-5));
    item.turnoverCrowdingZ=sd?(recent-mean)/sd:0;
    if(item.turnoverCrowdingZ<=pentadPolicy.entryCrowdingZ)continue;
    amounts.delete(item.symbol);
    item.entryRule.enabled=false;
    item.status='成交持续过热，暂缓首次建仓';
  }
}

export async function weakWatchFactors(date){
  const file=path=>fileURLToPath(new URL(path,import.meta.url));
  const {stdout}=await run(file('./Pentad/.venv/bin/python'),[file('./scripts/weak-defense-score.py'),date],{timeout:60000});
  return new Map(JSON.parse(stdout));
}

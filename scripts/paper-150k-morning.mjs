import {createResearchStore} from '../research-store.mjs';
import {createMorningPlanner} from '../morning-plan.mjs';
import {weakWatchFactors} from '../pentad-policy.mjs';
import {getDaily} from '../market-context.mjs';
import {getNews} from '../news.mjs';
const root=new URL('../data/paper-150k/',import.meta.url);
const positions=createResearchStore(new URL('position-log.json',root),{version:1,records:[]});
const planner=createMorningPlanner({getDaily,getNews,positions,getWeakWatchFactors:weakWatchFactors,
  file:new URL('morning-plans.json',root)});
const time=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date());
if(time<'08:00'||time>'09:00')throw Error('模拟晨报须在北京时间08:00至09:00生成');
const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
await positions.update(state=>({...state,confirmedDate:date}));
const plan=await planner.generate();
console.log(JSON.stringify({date:plan.date,status:plan.status,warnings:plan.warnings}));

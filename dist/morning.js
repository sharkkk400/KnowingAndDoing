import {instruments,instrumentCatalog} from './instruments.js';
import {compactStrategyMarkup,executionMarkup} from './execution-markup.js';
const $=id=>document.getElementById(id);
let active=true,busy=false,sequence=0,manualDate=false;
let executionBusy=false,seeded=false,knownEvents=new Set();
let lastPlanMarkup='';
async function request(path,method='GET'){
 const response=await fetch(path,{method,signal:AbortSignal.timeout(120000)}),data=await response.json();
 if(!response.ok)throw Error(data.error||'晨间计划暂不可用');return data;
}
function show(plan){const html=compactStrategyMarkup(plan);if(lastPlanMarkup!==html){lastPlanMarkup=html;$('morningContent').innerHTML=html;}}
function note(text,error=false){$('morningStatus').hidden=!text;$('morningStatus').textContent=text;$('morningStatus').classList.toggle('research-warning',error);}
async function load(){
 const serial=++sequence,date=manualDate?$('morningDate').value:'';
 try{const result=await request('/api/morning-plan'+(date?'?date='+encodeURIComponent(date):''));if(serial!==sequence)return;
  const selected=date||result.today;
  $('actualPositions').textContent=result.actualPositions?.length?result.actualPositions.map(([s,q])=>(instrumentCatalog.find(i=>i.symbol===s)?.name||s)+' '+s.slice(2)+' · '+q+' 份').join('，'):'当前空仓';
  $('morningRun').hidden=selected!==result.today||!!result.plan;
  $('morningDate').replaceChildren(...[...new Set([result.today,...result.dates])].map(d=>{const option=document.createElement('option');option.value=d;option.textContent=d;return option;}));
  $('morningDate').value=selected;show(result.plan);
  note(result.scheduler.running?'正在生成策略…':result.plan?'':result.scheduler.lastError||'');
 }catch(error){note(error.message,true);}
}
document.addEventListener('click',async e=>{
 const button=e.target.closest('button');if(!button)return;
 if(button.dataset.view){active=button.dataset.view!=='research';window.history.replaceState(null,'',active?'#morning':'#research');if(active){void load();void loadExecution();}}
 if(!['morningRun','morningRefresh'].includes(button.id))return;
 if(button.id==='morningRefresh'){void load();return;}
 if(busy)return;busy=true;++sequence;
 for(const id of ['morningRun'])$(id).disabled=true;
 note('正在核对上一交易日收盘数据与8点前消息…');
 try{const r=await request('/api/morning-plan/confirm','POST');manualDate=false;await load();
  note(r.plan.late?'已显示今日补生成的冻结计划；不追溯8点提醒。':'已显示今日冻结计划，重复生成不会覆盖。');
 }catch(error){note(error.message,true);}finally{busy=false;$('morningRun').disabled=false;}
});
$('morningDate').addEventListener('change',()=>{manualDate=true;void load();});
setInterval(()=>{if(active&&!busy)void load();},30000);
async function loadExecution(){
 if(executionBusy)return;executionBusy=true;
 try{const payload=await request('/api/plan-execution'),html=executionMarkup(payload);
  if($('executionContent').innerHTML!==html)$('executionContent').innerHTML=html;
  for(const e of payload.records||[]){
   if(seeded&&!knownEvents.has(e.id)&&Date.now()-Date.parse(e.observedAt)<=120000&&
     Date.now()-Date.parse(e.observedAt)>=0&&'Notification' in window&&Notification.permission==='granted'){
    try{new Notification(e.kind==='entry'?'沙克知行录 · 入场条件满足':'沙克知行录 · 风险提醒',{body:e.text,tag:e.id});}catch{}
   }
   knownEvents.add(e.id);
  }
  seeded=true;
 }catch{$('executionContent').textContent='执行检查暂不可用，暂停入场提醒；原计划保留。';}
 finally{executionBusy=false;}
}
$('enablePlanNotifications').addEventListener('click',async()=>{
 const button=$('enablePlanNotifications');
 if(!('Notification' in window)){button.textContent='当前浏览器不支持通知，页面提醒仍有效';return;}
 const permission=await Notification.requestPermission();
 button.textContent=permission==='granted'?'浏览器通知已启用（页面需保持打开）':'未启用系统通知，仍保留页面提醒';
});
setInterval(()=>void loadExecution(),30000);
queueMicrotask(()=>document.querySelector(window.location.hash==='#research'?'[data-view="research"]':'[data-view="morning"]').click());

for(const i of instrumentCatalog.filter(x=>x.sector.endsWith('ETF')))$('holdingSymbol').add(new Option(i.name+(instruments.includes(i)?'':'（仅登记已有持仓）'),i.symbol));
const showBounceField=()=>{const visible=$('holdingSymbol').value==='sh510300';$('bounceField').hidden=!visible;if(!visible)$('bouncePosition').checked=false;};
$('holdingSymbol').addEventListener('change',showBounceField);
showBounceField();
$('holdingForm').addEventListener('submit',async e=>{
 e.preventDefault();
 try{const params=new URLSearchParams({symbol:$('holdingSymbol').value,marketValue:$('holdingValue').value,price:$('holdingPrice').value});
 if($('bouncePosition').checked)params.set('bounce','1');
 if($('holdingFirstFill').value)params.set('firstFillPrice',$('holdingFirstFill').value);
 if($('holdingEntryDate').value)params.set('entryDate',$('holdingEntryDate').value);
 const result=await request('/api/morning-plan/position?'+params,'POST');
 $('holdingResult').textContent='已记录 '+result.symbol+' 市值 '+result.marketValue+' 元，折合 '+result.quantity+' 份。'+(result.quantity?(result.bounce?'反弹试仓已登记。':result.entrySupport?'首次风险位 '+result.entrySupport:'首次风险位待核实，暂按60日线清仓。'):'');$('holdingFirstFill').value='';$('holdingEntryDate').value='';$('bouncePosition').checked=false;await load();
 }catch(err){$('holdingResult').textContent=err.message;}
});


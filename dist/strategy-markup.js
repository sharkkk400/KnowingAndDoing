const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
const stageNames={
 confirmed:'条件已确认',
 confirmation:'回踩守住，等待再次走强',
 retest:'收盘突破，等待回踩',
 breakout:'等待收盘突破',
 waiting:'等待条件恢复'
};
const genericAdvice={
 broad_repair:'等15分钟偏多方向数量不再下降、目标回踩守住支撑并再次收盘走强后，再分批参与；支撑失守则收缩。',
 selective:'精选回踩，满足标的转强价与量价条件后再分批参与；持续落后且反弹不过压力时减仓。',
 rotation:'留强减弱，等回踩止跌并重新转强后再参与；标的破位或反弹失败时减仓。'
};
const defensive=new Set(['defensive','fragile','index_divergence','cooling']);
const wrap=(body,change='')=>body?`<div class="action-plan"><div><b>当前建议</b><p>${body}</p>${change}</div></div>`:'';
const actionText=future=>[...new Set((Array.isArray(future?.actions)?future.actions:[]).map(action=>action?.text).filter(text=>typeof text==='string'&&text.trim()))].join('');
const candidateMarkup=item=>`<button type="button" class="text-button" data-benchmark="${esc(item.symbol)}">${esc(item.name||item.symbol)}</button>（${esc(item.stage==='waiting'?item.reason||stageNames.waiting:item.label||stageNames[item.stage])}）`;

export function topStrategyAdviceMarkup(future,strategy) {
 const original=actionText(future);
 const usable=strategy?.ready===true&&future?.ready!==false&&validDate(strategy.date)&&validDate(strategy.dailyDate)&&
  strategy.dailyDate<=strategy.date&&(!future?.date||future.date===strategy.date);
 if(!usable)return wrap(esc(original));

 const seen=new Set();
 const items=(Array.isArray(strategy.items)?strategy.items:[]).filter(item=>{
  if(!item||typeof item.symbol!=='string'||!item.symbol||!stageNames[item.stage])return false;
  const key=item.exposure||item.symbol;
  if(seen.has(key))return false;
  seen.add(key);return true;
 }).slice(0,3);
 const active=items.some(item=>item.stage!=='waiting');
 const caution=defensive.has(future?.regime);
 const advice=genericAdvice[future?.regime]||original;
 let body=esc(advice);
 const basis=`日线依据 ${esc(strategy.dailyDate)}`;
 if(items.length) {
  const order=items.map((item,index)=>`${active?(index?'再看':'先看'):''}${candidateMarkup(item)}`).join('，');
  const limit=caution?'暂缓参与，以下顺序仅供观察。':
   !active?'当前候选均在等待条件恢复，仅观察。':
   !items.some(item=>item.stage==='confirmed')?'确认条件满足前仅观察。':'';
  body+=`${body?' ':''}${limit}${active?'候选中':'日线候选：'}${order}（${basis}）。`;
 } else {
  body+=`${body?' ':''}${caution?'暂缓参与。':''}${basis}：暂无合格候选，等待新的确认条件。`;
 }
 const update=strategy.change;
 const change=update&&update.date===strategy.date&&typeof update.text==='string'&&update.text.trim()
  ?`<small class="strategy-change">计划变化${update.time?' · '+esc(update.time):''}：${esc(update.text)}</small>`:'';
 return wrap(body,change);
}

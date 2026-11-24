const finite=value=>typeof value==='number'&&Number.isFinite(value);
const positive=value=>finite(value)&&value>0;

// These plans describe observable entry and exit conditions, not price targets.
export function instrumentAdvice({
 bias='limited',price,support,pressure,nextPressure,ma5,ma20,ma60,vwap,
 change,relative,volumeRatio,flowMain,macdTrend,sector='',dailyOK=false
}={}) {
 const isIndex=sector==='指数',digits=String(sector||'').endsWith('ETF')?3:2;
 const fmt=value=>value.toFixed(digits);
 const p=positive(price)?price:null;
 const floor=p&&positive(support)&&support<p?support:null;
 const ceiling=p?[pressure,nextPressure].filter(value=>positive(value)&&value>p).sort((a,b)=>a-b)[0]??null:null;
 const down=floor?(p-floor)/p*100:null,up=ceiling?(ceiling-p)/p*100:null;
 const dailyStrong=dailyOK&&p&&positive(ma20)&&positive(ma60)&&p>ma20&&ma20>ma60;
 const dailyWeak=dailyOK&&p&&positive(ma20)&&positive(ma60)&&p<ma20&&ma20<ma60;
 const nearCeiling=up!==null&&up<=1,nearFloor=down!==null&&down<=1;
 const rangePosition=floor&&ceiling?(p-floor)/(ceiling-floor):null;
 const evidence=[];
 if(dailyStrong)evidence.push(`现价高于20日均线 ${fmt(ma20)}，20日均线高于60日均线`);
 else if(dailyWeak)evidence.push(`现价低于20日均线 ${fmt(ma20)}，20日均线低于60日均线`);
 else if(dailyOK&&positive(ma20)&&p)evidence.push(`现价${p>=ma20?'高于':'低于'}20日均线 ${fmt(ma20)}`);
 if(finite(relative)&&Math.abs(relative)>=.5)evidence.push(`较参照${relative>=0?'强':'弱'} ${Math.abs(relative).toFixed(2)} 个百分点`);
 if(finite(volumeRatio)&&volumeRatio>0)evidence.push(`成交量为前5日均量 ${volumeRatio.toFixed(2)} 倍`);
 if(finite(flowMain)&&flowMain!==0)evidence.push(`同期主力净额${flowMain>0?'为正':'为负'}`);
 if(macdTrend==='improving')evidence.push('15分钟动能改善');
 else if(macdTrend==='weakening')evidence.push('15分钟动能回落');
 const location=p?[`观察价 ${fmt(p)}`,ceiling?`距上方压力 ${fmt(ceiling)} 约 ${up.toFixed(2)}%`:null,floor?`距下方支撑 ${fmt(floor)} 约 ${down.toFixed(2)}%`:null].filter(Boolean).join('；'):'当前有效报价缺失';
 const summary=extra=>`${location}。${[extra,...evidence.slice(0,2)].filter(Boolean).join('；')}${extra||evidence.length?'。':''}`;
 const result=(regime,title,extra,advice)=>({
  regime,title,summary:summary(extra),
  actions:[{label:'当前建议',text:(isIndex?'针对跟踪该指数的产品，':'')+advice}]
 });
 const guard=floor?`跌破 ${fmt(floor)} 且不能收回时减仓`:'先明确可承受的回撤边界，再决定是否继续持有';
 const reclaim=positive(vwap)&&p&&vwap>p?`重新站上日内均价 ${fmt(vwap)}`:positive(ma5)&&p&&ma5>p?`重新站上5日均线 ${fmt(ma5)}`:'停止创新低且短线动能转好';
 const breakout=ceiling?`放量突破 ${fmt(ceiling)} 后回踩不失守`:'形成可确认的上方突破位并完成回踩确认';
 const retreat=floor?`回落至 ${fmt(floor)} 一带企稳`:'回踩已确认的支撑并企稳';

 if(!p||!dailyOK||bias==='limited') {
  const missing=!p?'有效报价缺失':!dailyOK?'近期日线不足，趋势依据不完整':'有效证据尚不足以支持新增敞口';
  return result('insufficient','先不新开，等证据补齐',missing,`暂不新增敞口，等有效日线和同日短线证据恢复后重新评估。${floor?guard:'期间按已有风险计划管理回撤'}。`);
 }
 if(!floor&&!ceiling)return result('unbounded','价格边界不清，先不新增', '现有支撑或压力未位于现价两侧，无法据此判断参与空间','暂不新增敞口，等有效支撑和上方压力明确后再选择参与位置；期间按已有风险计划管理回撤。');

 const rebound=finite(change)&&change>0||macdTrend==='improving';
 if(bias==='weak'||dailyWeak) {
  if(rebound)return result('weak-rebound','反弹先减风险，暂不按反转追入',dailyWeak?'短线改善仍处于偏弱日线之下':'短线改善尚未扭转整体偏弱证据',
   `${ceiling?`反弹接近 ${fmt(ceiling)} 却站不稳时减仓`:'反弹力度衰减、动能再次转弱时减仓'}。等${breakout}且${dailyWeak?'20日趋势':'资金与短线动能'}改善，再考虑参与。`);
  return result('weak-trend','弱势未止，优先降低敞口',null,
   `暂不抄底，先等${reclaim}再评估反弹；${guard}。`);
 }
 if(down!==null&&up!==null&&down>=5&&down>up)return result('wait-closer-support','下方边界较远，先等更近支撑','当前价与下方观察边界的距离较大，突破前还需重新评估参与位置',
  `不因冲高追加，先等回踩形成更近的有效支撑、承接与动能恢复后再参与。冲击 ${fmt(ceiling)} 失败且动能转弱时减仓。`);
 if(bias==='strong'&&nearCeiling)return result('strong-near-pressure','趋势偏强，但临近压力先不追',null,
  `先不追涨，等${breakout}后再参与；若压力附近放量滞涨或动能转弱，可先兑现部分。`);
 const stretched=positive(ma20)&&p>ma20&&(p/ma20-1)*100>=8;
 if(bias==='strong'&&stretched)return result('strong-extended','强势已拉开距离，等回踩再参与',`现价高于20日均线 ${((p/ma20-1)*100).toFixed(2)}%，追涨后的回撤余地较大`,
  `先等${retreat}且动能改善后再参与；急涨后动能转弱时兑现部分，${guard}。`);
 if(bias==='strong'&&nearFloor)return result('strong-pullback','回踩接近支撑，等承接确认',null,
  `守住 ${fmt(floor)} 并${reclaim}后再考虑参与；${guard}。`);
 if(bias==='strong')return result('strong-trend','趋势占优，优先持有并等待回踩',null,
  `趋势未转弱时继续持有，新增参与等${retreat}且动能恢复；${guard}。`);
 if(bias==='repair')return result('repair-confirmation','修复尚待突破，满足条件再加仓',null,
  `等${breakout}且保持相对参照走强后再考虑加仓；${guard}。`);
 if(rangePosition!==null?rangePosition>=.7:nearCeiling)return result('range-upper','区间上沿，不追涨并关注兑现',null,
  `先不追涨，冲击 ${fmt(ceiling)} 失败且动能转弱时减仓；等${breakout}后再考虑参与。`);
 if(rangePosition!==null?rangePosition<=.3:nearFloor)return result('range-lower','区间下沿，等企稳再考虑参与',null,
  `确认 ${fmt(floor)} 不再被有效跌破且${reclaim}后再参与；${guard}。${ceiling?`反弹至 ${fmt(ceiling)} 仍未突破时可兑现部分。`:''}`);
 return result('range-middle','区间中段，等待更明确的参与位置',null,
  `暂不在区间中段追加，等${retreat}或${breakout}后再参与；${guard}。`);
}

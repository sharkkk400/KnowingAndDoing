const finite = Number.isFinite;
const signed = n => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

// These are explicit planning rules, not calibrated return forecasts.
export function marketAdvice({overview: o, breadthRatio, momentum, momentumChange, indexChange, groups = []}) {
  const count = o.units.length, upRatio = o.up / count, downRatio = o.down / count;
  const aligned = finite(breadthRatio), hasMomentum = finite(momentum);
  const broadUp = aligned && breadthRatio >= .6, broadDown = aligned && breadthRatio <= .4;
  const cooling = hasMomentum && finite(momentumChange) && momentumChange < 0;
  const sectors = groups.filter(g => g.ready && g.category === '行业轮动' && finite(g.change)).sort((a, b) => b.change - a.change);
  const leaders = sectors.filter(g => g.change > .05).slice(0, 2);
  const laggards = sectors.filter(g => g.change < -.05).slice(-2).reverse();
  const candidateNames = leaders.map(g => g.name).join('、');
  const target = candidateNames || '相对市场更强的方向';
  let regime, bias = 'mixed', title, advice;
  if (!aligned) {
    regime = 'breadth_missing'; bias = 'limited'; title = '上涨是否普遍还不清楚，先暂停新增仓位';
    advice = '先等全市场涨跌家数补齐，再判断是否适合参与；期间以各标的支撑位作为风险边界。';
  } else if (broadDown && downRatio >= .7) {
    regime = 'defensive'; bias = 'weak'; title = '普跌占优，先减弱势仓位，暂缓抄底';
    advice = '优先减掉跌破支撑且反抽未收复的仓位，暂停加仓。等待上涨占比回到40%以上、下跌ETF方向降至70%以下，再筛选止跌标的。';
  } else if (finite(indexChange) && indexChange > .05 && broadDown) {
    regime = 'index_divergence'; title = '指数红、个股弱，别跟着指数加仓';
    advice = '优先检查逆市下跌的标的，反弹无法收复压力时减仓；等上涨占比回到40%以上、目标重新强于市场，再考虑参与。';
  } else if (!hasMomentum) {
    regime = 'momentum_missing'; bias = 'limited'; title = '涨跌分布已知，动能待确认，先不追涨';
    advice = `将${target}列入观察，等有效15分钟动能与该标的突破条件同时确认再参与，避免只凭领涨排名追入。`;
  } else if (cooling && (broadUp || upRatio >= .7)) {
    regime = 'cooling'; title = '上涨面还在，动能正在收缩，先停止追买';
    advice = '等15分钟偏多方向数量不再下降、目标回踩守住支撑，再考虑参与；跌破支撑或反弹不过压力时优先减仓。';
  } else if (broadUp && upRatio >= .7 && momentum >= .6) {
    regime = 'broad_repair'; bias = 'repair'; title = finite(momentumChange) ? '普涨与动能共振，可分批参与强势回踩' : '普涨已出现，等动能延续后分批参与';
    advice = `优先看${target}。${finite(momentumChange) ? '' : '先取得下一根15分钟线、确认偏多方向数量不下降；'}回踩守住支撑、15分钟收盘重新站上观察价后，再分批参与；支撑失守则收缩。`;
  } else if (broadDown || downRatio >= .7) {
    regime = 'fragile'; title = '多数方向仍承压，先降低试错频率';
    advice = '弱于市场且跌破支撑时优先减仓；等上涨占比超过40%、下跌ETF方向少于70%后，再考虑新增参与。';
  } else if (broadUp && upRatio < .7) {
    regime = 'selective'; title = '个股回暖、ETF分化，精选回踩，暂缓全面加仓';
    advice = `优先看${target}的回踩承接，满足转强价与量价条件后小额分批参与；持续落后且反弹不过压力时减仓。`;
  } else if (leaders.length && laggards.length) {
    regime = 'rotation'; title = '行业强弱分明，留强减弱，等回踩再买';
    advice = `观察${target}在支撑附近止跌并重新转强的机会；${laggards.map(g => g.name).join('、')}相关方向，仅在标的自身破位或反弹失败时减仓。`;
  } else {
    regime = 'balanced'; title = '多空尚未拉开，先持有观察，等突破再加';
    advice = '区间内减少频繁换仓；突破压力且量价、相对强弱共同确认后再参与，跌破支撑则减仓控制损失。';
  }
  const evidence = [aligned ? `上涨个股 ${(breadthRatio * 100).toFixed(1)}%` : '全市场上涨占比缺失',
    `ETF方向 ${o.up}/${count} 上涨、${o.down}/${count} 下跌`,
    hasMomentum ? `15分钟偏多 ${(momentum * 100).toFixed(0)}%${finite(momentumChange) ? `（较上一根${momentumChange > 0 ? '增加' : momentumChange < 0 ? '减少' : '持平'}${momentumChange ? Math.abs(momentumChange) + '个方向' : ''}）` : ''}` : '15分钟动能未齐'];
  if (finite(indexChange)) evidence.unshift(`中证全指 ${signed(indexChange)}`);
  const leaderText = leaders.length ? `当日较强：${leaders.map(g => `${g.name} ${signed(g.change)}${finite(g.rankChange) && g.rankChange > 0 ? `，15分钟排名上升${g.rankChange}位` : ''}`).join('；')}。` : '';
  return {bias, regime, title, summary: evidence.join('；') + '。', evidence,
    actions: [{label: '当前建议', text: advice}],
    leadership: leaderText, conditions: [
      {label: '扩大参与', text: '上涨占比≥60%、上涨ETF方向≥70%、15分钟偏多方向≥60%，且偏多方向数量不再下降；再核对具体标的的买入条件。'},
      {label: '收缩仓位', text: '上涨占比≤40%且下跌ETF方向≥70%，或持仓跌破自身支撑且未收复时，优先减少弱势仓位。'}]};
}

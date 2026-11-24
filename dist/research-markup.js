export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
export const stamp = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false}) : '尚未成功读取';
export const pct = n => Number.isFinite(n) ? (n >= 0 ? '+' : '') + n.toFixed(2) + '%' : '—';
const number = n => Number.isFinite(n) ? n.toFixed(3) : '—';
export function forecastMarkup(row, days) {
  const e = row.evaluations?.find(n => n.days === days), o = row.outlook;
  const state = e?.status === 'complete' ? e.direction === 0 ? '区间观察 · 不作方向检验' : e.directionMatched ? '方向一致' : '方向不一致' : e?.status === 'blocked' ? '验证暂停' : '等待验证';
  return `<article class="research-card forecast-card"><div class="research-meta"><b>${esc(row.name)}</b><time>${esc(row.signalDate)} 收盘</time><span class="research-chip">${state}</span></div>
    <h3>${esc(o.title)}</h3><p>${esc(o.summary)}</p>
    ${o.actions?.length ? `<div class="action-plan"><div><b>当时建议</b><p>${esc([...new Set(o.actions.map(a => a.text).filter(Boolean))].join(''))}</p></div></div>` : ''}
    <div class="forecast-prices"><span>留档收盘价 <b>${number(row.baselinePrice)}</b></span><span>转强观察 ${number(o.pressure)}</span><span>失效观察 ${number(o.support)}</span></div>
    ${e?.status === 'complete' ? `<div class="forecast-result"><b>${days}个交易日后 ${esc(e.targetDate)}</b><span>价格变化 <strong class="${e.change > 0 ? 'up' : e.change < 0 ? 'down' : ''}">${pct(e.change)}</strong></span><span>参照 ${pct(e.benchmarkChange)} · 超额 ${Number.isFinite(e.excess) ? e.excess.toFixed(2) : '—'} 个百分点</span><small>期间高点 ${pct(e.highChange)} / 低点 ${pct(e.lowChange)}；${esc(e.levelsNote)}</small></div>` : `<p class="muted">${esc(e?.reason || '等待后续交易日收盘')}</p>`}
    <details class="research-evidence" data-forecast-detail="${esc(row.id)}"><summary>当时的依据与观察条件</summary>
      <p>${esc(o.evidence?.join('；') || '依据见市场覆盖记录')}</p>${(o.conditions || []).map(c => `<p><b>${esc(c.label)}：</b>${esc(c.text)}</p>`).join('')}
      ${o.missing?.length ? `<p class="muted">当时缺少：${esc(o.missing.join('；'))}</p>` : ''}
      <small>实际留档 ${esc(stamp(row.observedAt))} · 规则 ${esc(row.ruleVersion)} · 参照 ${esc(row.benchmark.symbol)}<br>观察价触及仅核对价格，不代表成交或完整条件确认。</small>
    </details></article>`;
}

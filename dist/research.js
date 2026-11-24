import {esc, stamp, forecastMarkup} from './research-markup.js';

const $ = id => document.getElementById(id);
let archive, active = false, loading = false, archiveLimit = 20;
let archiveSequence = 0;
async function request(path, method = 'GET', data) {
  const response = await fetch(path, {method, headers: data ? {'Content-Type': 'application/json'} : {},
    body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(15000)});
  const result = await response.json(); if (!response.ok) throw Error(result.error || '请求失败'); return result;
}
function message(text, error = false) { $('researchMessage').textContent = text; $('researchMessage').classList.toggle('research-warning', error); }
function options(el, values, first) {
  const selected = el.value;
  const markup = first + values.map(v => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('');
  if (el.innerHTML !== markup) { el.innerHTML = markup; if ([...el.options].some(o => o.value === selected)) el.value = selected; }
}
function renderArchive() {
  if (!archive) return;
  options($('archiveSymbol'), archive.definitions.map(d => ({id: d.symbol, name: d.name})), '<option value="">全部标的</option>');
  const days = Number($('archiveDays').value), s = archive.summary;
  $('archiveSummary').innerHTML = `<div><strong>${s.total}</strong><span>已留档</span></div><div><strong>${s.completed}</strong><span>${days}日结果已齐</span></div><div><strong>${s.directional ? s.matched + ' / ' + s.directional : '—'}</strong><span>有方向推演一致数</span></div><div><strong>${s.pending} / ${s.blocked}</strong><span>等待 / 数据待补</span></div>`;
  const open = new Set([...document.querySelectorAll('[data-forecast-detail][open]')].map(e => e.dataset.forecastDetail));
  $('archiveList').innerHTML = archive.records.length ? archive.records.map(r => forecastMarkup(r, days)).join('') : '<div class="research-empty">尚无推演存档。服务运行期间，会在15:10后保存当天有效的收盘推演；历史日期不补造判断。</div>';
  document.querySelectorAll('[data-forecast-detail]').forEach(el => { el.open = open.has(el.dataset.forecastDetail); });
  $('archiveMore').hidden = archive.records.length >= archive.total || archiveLimit >= 200;
  $('archiveStatus').textContent = archive.collector.error || (archive.collector.running ? '正在检查收盘数据与后续验证…' : archive.lastRunAt ? '最近检查 ' + stamp(archive.lastRunAt) : '等待首次收盘数据检查');
  $('archiveStatus').classList.toggle('research-warning', !!archive.collector.error);
  const symbol = $('archiveSymbol').value;
  $('archiveExport').href = '/api/forecast-archive/export' + (symbol ? '?symbol=' + encodeURIComponent(symbol) : '');
  const errors = (archive.errors || []).filter(e => !symbol || e.symbol === symbol);
  $('archiveErrors').textContent = errors.length ? errors.map(e => (archive.definitions.find(d => d.symbol === e.symbol)?.name || e.symbol) + '：' + e.reason).join('；') + '。后台会重试。' : '';
}
async function loadArchive() {
  const sequence = ++archiveSequence;
  const query = new URLSearchParams({symbol: $('archiveSymbol').value, days: $('archiveDays').value, limit: archiveLimit});
  const result = await request('/api/forecast-archive?' + query);
  if (sequence === archiveSequence) { archive = result; renderArchive(); }
}
async function load() {
  if (loading) return; loading = true;
  try { await loadArchive(); }
  catch (error) { message(error.message, true); }
  finally { loading = false; }
}
document.addEventListener('click', async e => {
  const button = e.target.closest('button'); if (!button) return;
  if (button.dataset.view) {
    const view=button.dataset.view; active = view === 'research'; $('marketView').hidden = active; $('researchView').hidden = !active; $('morningView').hidden=active;
    $('pageTitle').textContent = active ? '推演留档与验证' : '今日计划与行情';
    document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b === button));
    if (active) void load();
  }
  try {
    if (button.id === 'archiveRun') { const r = await request('/api/forecast-archive/run', 'POST'); message(r.message); await loadArchive(); }
    if (button.id === 'archiveMore') { archiveLimit += 20; await loadArchive(); }
  } catch (error) { message(error.message, true); }
});
for (const id of ['archiveSymbol', 'archiveDays']) $(id).addEventListener('change', () => { archiveLimit = 20; void loadArchive().catch(e => message(e.message, true)); });
setInterval(() => { if (active) void load(); }, 15000);

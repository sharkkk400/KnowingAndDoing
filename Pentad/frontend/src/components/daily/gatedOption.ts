import type { EChartsOption } from 'echarts';
import type { DailyWindow } from './window';
import { drawdowns } from './window';

const GATED_LABEL = '核心8·仅年线上持有';
const CORE_ALL_LABEL = '核心8·每日持有';
const GATED_COLOR = '#cf1322';
const CORE_ALL_COLOR = '#8c8c8c';
const HS300_COLOR = '#722ed1';
const GATE_OFF_FILL = 'rgba(207, 19, 34, 0.06)';
const TOOLTIP_MAX_WIDTH = 480;

interface TooltipParam {
  marker: string;
  seriesName: string;
  seriesIndex: number;
  value: unknown;
  dataIndex: number;
  axisValue: string;
}

type AreaPair = [{ xAxis: string; itemStyle: { color: string } }, { xAxis: string }];

function pctText(value: unknown): string {
  return typeof value === 'number' ? `${value.toFixed(2)}%` : '—';
}

function signedPct(value: number | null): string {
  if (value == null) return '—';
  const pct = value * 100;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

function wrap(axisValue: string, body: string): string {
  return `<div style="max-width:${TOOLTIP_MAX_WIDTH}px;white-space:normal"><b>${axisValue}</b><br/>${body}</div>`;
}

function toPct(value: number | null): number | null {
  return value == null ? null : Number((value * 100).toFixed(2));
}

/** 开关下方的连续日区间, 用于上下两格同步铺淡红底色。 */
function gateOffRanges(window: DailyWindow): AreaPair[] {
  const points = window.points;
  const ranges: AreaPair[] = [];
  let i = 0;
  while (i < points.length) {
    if (points[i].gate !== 'below') {
      i += 1;
      continue;
    }
    let end = i;
    while (end + 1 < points.length && points[end + 1].gate === 'below') end += 1;
    const next = points[Math.min(end + 1, points.length - 1)];
    ranges.push([
      { xAxis: points[i].signal_date, itemStyle: { color: GATE_OFF_FILL } },
      { xAxis: next.signal_date },
    ]);
    i = end + 1;
  }
  return ranges;
}

function gateText(gate: 'above' | 'below' | null): string {
  if (gate == null) return '年线未热身（空仓）';
  return gate === 'above' ? '年线上方（开仓）' : '年线下方（空仓）';
}

/** 开关视图 tooltip: 上格累计与当日执行/空仓, 下格回撤, 两格一起给出便于对照。 */
function gatedTooltip(window: DailyWindow) {
  return (raw: unknown): string => {
    const params = raw as TooltipParam[];
    const first = params[0];
    if (!first) return '';
    const point = window.points[first.dataIndex];
    if (!point) return '';
    const fmtRows = (rows: TooltipParam[], label: string): string =>
      rows
        .filter((p) => p.value != null)
        .map((p) => `${p.marker}${p.seriesName}&nbsp;&nbsp;${label} <b>${pctText(p.value)}</b>`)
        .join('<br/>');
    const netRows = fmtRows(
      params.filter((p) => p.seriesIndex < 3),
      '累计',
    );
    const ddRows = fmtRows(
      params.filter((p) => p.seriesIndex >= 3),
      '回撤',
    );
    const applied = window.daily.gated[first.dataIndex] ?? null;
    const coreDay = window.daily.core[first.dataIndex] ?? null;
    const head =
      `${gateText(point.gate)} · 当日执行 ${signedPct(applied)}` +
      `（${CORE_ALL_LABEL} ${signedPct(coreDay)}）`;
    const body = [netRows, ddRows].filter(Boolean).join('<div style="height:6px"></div>');
    return wrap(first.axisValue, `${head}<br/>${body}`);
  };
}

/** 年线开关净值: 上格 core8 持仓的累计收益(仅年线上持有/每日持有/沪深300), 下格各自回撤, 淡红区=年线下方空仓。 */
export function buildGatedOption(window: DailyWindow): EChartsOption {
  const dates = window.points.map((p) => p.signal_date);
  const gated = window.points.map((p) => p.gated);
  const core = window.points.map((p) => p.core);
  const hs300 = window.points.map((p) => p.hs300);
  const areas = gateOffRanges(window);
  const line = (
    name: string,
    color: string,
    gridIndex: 0 | 1,
    data: Array<number | null>,
    width: number,
    dashed = false,
    filled = false,
  ): Record<string, unknown> => ({
    name,
    type: 'line',
    xAxisIndex: gridIndex,
    yAxisIndex: gridIndex,
    showSymbol: false,
    lineStyle: { width, color, type: dashed ? 'dashed' : 'solid' },
    itemStyle: { color },
    ...(filled ? { areaStyle: { color, opacity: 0.12 } } : {}),
    data: data.map(toPct),
  });
  const shaded = (series: Record<string, unknown>): Record<string, unknown> => ({
    ...series,
    markArea: { silent: true, itemStyle: { color: GATE_OFF_FILL }, data: areas },
  });
  return {
    animation: false,
    legend: { top: 0, data: [GATED_LABEL, CORE_ALL_LABEL, '沪深300'] },
    tooltip: { trigger: 'axis', confine: true, formatter: gatedTooltip(window) },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [
      { left: 56, right: 24, top: 36, height: '48%' },
      { left: 56, right: 24, top: '64%', height: '22%' },
    ],
    xAxis: [
      { type: 'category', gridIndex: 0, data: dates, axisLabel: { show: false }, axisTick: { show: false } },
      { type: 'category', gridIndex: 1, data: dates, axisLabel: { color: '#8c8c8c' } },
    ],
    yAxis: [
      {
        type: 'value',
        gridIndex: 0,
        name: '累计收益',
        scale: true,
        nameTextStyle: { color: '#8c8c8c' },
        axisLabel: { formatter: '{value}%', color: '#8c8c8c' },
        splitLine: { lineStyle: { color: '#f0f0f0' } },
      },
      {
        type: 'value',
        gridIndex: 1,
        name: '回撤',
        max: 0,
        nameTextStyle: { color: '#8c8c8c' },
        axisLabel: { formatter: '{value}%', color: '#8c8c8c' },
        splitLine: { lineStyle: { color: '#f0f0f0' } },
      },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1] },
      { type: 'slider', xAxisIndex: [0, 1], height: 16, bottom: 2 },
    ],
    series: [
      shaded(line(GATED_LABEL, GATED_COLOR, 0, gated, 2)),
      line(CORE_ALL_LABEL, CORE_ALL_COLOR, 0, core, 1.5, true),
      line('沪深300', HS300_COLOR, 0, hs300, 1.5),
      shaded(line(GATED_LABEL, GATED_COLOR, 1, drawdowns(gated), 1.5, false, true)),
      line(CORE_ALL_LABEL, CORE_ALL_COLOR, 1, drawdowns(core), 1.2, true),
      line('沪深300', HS300_COLOR, 1, drawdowns(hs300), 1.2),
    ],
  };
}

import type { EChartsOption } from 'echarts';
import type { DailySeriesKey, DailyWindow } from './window';

const SERIES: ReadonlyArray<{ key: DailySeriesKey; name: string; color: string }> = [
  { key: 'core', name: '策略持仓', color: '#cf1322' },
  { key: 'baseline', name: '基线前10', color: '#1677ff' },
  { key: 'universe', name: '股票池等权', color: '#8c8c8c' },
  { key: 'hs300', name: '沪深300', color: '#722ed1' },
];

const KEY_BY_NAME = new Map(SERIES.map((s) => [s.name, s.key]));

const UP_COLOR = '#cf1322';
const DOWN_COLOR = '#3f8600';

interface TooltipParam {
  marker: string;
  seriesName: string;
  value: unknown;
  dataIndex: number;
  axisValue: string;
}

function fmtPct(value: unknown): string {
  return typeof value === 'number' ? `${value.toFixed(2)}%` : '—';
}

function fmtSignedPct(value: number | null): string {
  if (value == null) return '—';
  const pct = value * 100;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

/** 累计视图 tooltip: 每条曲线同时给出窗口内累计值与当日涨跌。 */
function cumulativeTooltip(window: DailyWindow) {
  return (raw: unknown): string => {
    const params = raw as TooltipParam[];
    const first = params[0];
    if (!first) return '';
    const rows = params
      .map((p) => {
        const key = KEY_BY_NAME.get(p.seriesName);
        const daily = key ? window.daily[key][p.dataIndex] : null;
        return `${p.marker}${p.seriesName}&nbsp;&nbsp;累计 <b>${fmtPct(p.value)}</b> · 当日 ${fmtSignedPct(daily)}`;
      })
      .join('<br/>');
    return `<b>${first.axisValue}</b><br/>${rows}`;
  };
}

/** 每日涨跌视图 tooltip。 */
function dailyTooltip() {
  return (raw: unknown): string => {
    const params = raw as TooltipParam[];
    const first = params[0];
    if (!first) return '';
    const rows = params.map((p) => `${p.marker}${p.seriesName}&nbsp;&nbsp;<b>${fmtPct(p.value)}</b>`).join('<br/>');
    return `<b>${first.axisValue}</b><br/>${rows}`;
  };
}

function baseOption(window: DailyWindow): EChartsOption {
  return {
    animation: false,
    legend: { top: 0 },
    grid: { left: 56, right: 24, top: 40, bottom: 48 },
    xAxis: {
      type: 'category',
      data: window.points.map((p) => p.signal_date),
      axisLabel: { color: '#8c8c8c' },
    },
    yAxis: {
      type: 'value',
      axisLabel: { formatter: '{value}%', color: '#8c8c8c' },
      splitLine: { lineStyle: { color: '#f0f0f0' } },
    },
    dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 8 }],
  };
}

function toPct(value: number | null): number | null {
  return value == null ? null : Number((value * 100).toFixed(2));
}

/** 累计净值曲线(窗口内归零) + 沪深300 同口径基准。 */
export function buildDailyCumulativeOption(window: DailyWindow): EChartsOption {
  return {
    ...baseOption(window),
    tooltip: { trigger: 'axis', formatter: cumulativeTooltip(window) },
    series: SERIES.map((s) => ({
      name: s.name,
      type: 'line' as const,
      showSymbol: false,
      lineStyle: { width: s.key === 'hs300' ? 1.5 : 2, color: s.color },
      itemStyle: { color: s.color },
      data: window.points.map((p) => toPct(p[s.key])),
    })),
  };
}

/** 每日涨跌: 策略持仓柱状(红涨绿跌) + 基线/沪深300 折线, 便于逐日判断幅度。 */
export function buildDailyBarsOption(window: DailyWindow): EChartsOption {
  const line = (name: string, color: string, data: Array<number | null>, dashed = false): Record<string, unknown> => ({
    name,
    type: 'line',
    showSymbol: false,
    lineStyle: { width: 1.5, color, type: dashed ? 'dashed' : 'solid' },
    itemStyle: { color },
    data,
  });
  return {
    ...baseOption(window),
    tooltip: { trigger: 'axis', formatter: dailyTooltip() },
    series: [
      {
        name: '策略持仓',
        type: 'bar',
        barMaxWidth: 10,
        color: UP_COLOR,
        data: window.daily.core.map((v) => ({
          value: toPct(v),
          itemStyle: { color: v != null && v < 0 ? DOWN_COLOR : UP_COLOR },
        })),
      },
      line('基线前10', '#1677ff', window.daily.baseline.map(toPct)),
      line('沪深300', '#722ed1', window.daily.hs300.map(toPct), true),
    ],
  };
}

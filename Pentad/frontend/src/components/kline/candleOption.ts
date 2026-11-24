import type { EChartsOption } from 'echarts';
import type { KlineBar } from '../../api/types';

const UP_COLOR = '#f5222d';
const DOWN_COLOR = '#52c41a';
const DIF_COLOR = '#1677ff';
const DEA_COLOR = '#fa8c16';
const MUTED_COLOR = '#8c8c8c';

function fmtPrice(value: number | null | undefined): string {
  return value == null ? '—' : value.toFixed(3);
}

function fmtValue(value: number | null | undefined, digits: number): string {
  return value == null ? '—' : value.toFixed(digits);
}

function tooltipRow(label: string, value: string, color = '#262626'): string {
  return (
    `<div style="display:flex;justify-content:space-between;gap:20px;line-height:20px">` +
    `<span style="color:${MUTED_COLOR}">${label}</span><span style="color:${color}">${value}</span></div>`
  );
}

/** 蜡烛图 + 成交量 + MACD 三联图; 不足 2 根返回 null 由组件降级展示。 */
export function buildCandleOption(bars: KlineBar[], nodeDate?: string | null): EChartsOption | null {
  const valid = bars.filter((b) => b.open != null && b.close != null && b.high != null && b.low != null);
  if (valid.length < 2) return null;

  const dates = valid.map((b) => b.date);
  const candles = valid.map((b) => [b.open, b.close, b.low, b.high]);
  const volumes = valid.map((b) => b.volume ?? 0);
  const dif = valid.map((b) => b.dif);
  const dea = valid.map((b) => b.dea);
  const hist = valid.map((b) => b.hist);
  const pct = valid.map((bar, i) => {
    const prev = i > 0 ? valid[i - 1].close : null;
    return prev != null && prev !== 0 && bar.close != null ? bar.close / prev - 1 : null;
  });

  return {
    animation: false,
    // confine: 嵌套在表格滚动容器里时, 溢出容器的 tooltip 会被裁剪。
    tooltip: {
      trigger: 'axis',
      confine: true,
      axisPointer: { type: 'cross' },
      formatter: (params: unknown) => {
        const idx = (params as Array<{ dataIndex: number }>)[0]?.dataIndex;
        const bar = idx == null ? undefined : valid[idx];
        if (!bar || idx == null) return '';
        const chg = pct[idx];
        const chgColor = chg == null ? MUTED_COLOR : chg >= 0 ? UP_COLOR : DOWN_COLOR;
        return [
          `<div style="font-weight:600;margin-bottom:4px">${bar.date}</div>`,
          tooltipRow('涨跌幅', chg == null ? '—' : `${chg >= 0 ? '+' : ''}${(chg * 100).toFixed(2)}%`, chgColor),
          tooltipRow('开盘', fmtPrice(bar.open)),
          tooltipRow('收盘', fmtPrice(bar.close)),
          tooltipRow('最高', fmtPrice(bar.high)),
          tooltipRow('最低', fmtPrice(bar.low)),
          tooltipRow('成交量', bar.volume == null ? '—' : bar.volume.toLocaleString()),
          tooltipRow('DIF', fmtValue(bar.dif, 4)),
          tooltipRow('DEA', fmtValue(bar.dea, 4)),
          tooltipRow('MACD', fmtValue(bar.hist, 4)),
        ].join('');
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    legend: {
      top: 0,
      left: 64,
      itemWidth: 12,
      itemHeight: 8,
      textStyle: { fontSize: 11, color: '#8c8c8c' },
      data: ['DIF', 'DEA', 'MACD'],
    },
    grid: [
      { left: 64, right: 24, top: 28, height: '42%' },
      { left: 64, right: 24, top: '55%', height: '9%' },
      { left: 64, right: 24, top: '68%', height: '18%' },
    ],
    xAxis: [
      {
        type: 'category',
        data: dates,
        gridIndex: 0,
        boundaryGap: false,
        axisLabel: { show: false },
        axisLine: { lineStyle: { color: '#d9d9d9' } },
      },
      {
        type: 'category',
        data: dates,
        gridIndex: 1,
        boundaryGap: false,
        axisLabel: { show: false },
        axisLine: { lineStyle: { color: '#d9d9d9' } },
      },
      {
        type: 'category',
        data: dates,
        gridIndex: 2,
        boundaryGap: false,
        axisLabel: { color: '#8c8c8c', fontSize: 10 },
        axisLine: { lineStyle: { color: '#d9d9d9' } },
      },
    ],
    yAxis: [
      { scale: true, gridIndex: 0, splitLine: { lineStyle: { color: '#f0f0f0' } } },
      { gridIndex: 1, axisLabel: { show: false }, splitLine: { show: false } },
      {
        gridIndex: 2,
        scale: true,
        axisLabel: { fontSize: 10, color: '#8c8c8c' },
        splitLine: { lineStyle: { color: '#f5f5f5' } },
      },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1, 2], start: 0, end: 100 },
      { type: 'slider', xAxisIndex: [0, 1, 2], bottom: 6, height: 18 },
    ],
    series: [
      {
        name: 'K线',
        type: 'candlestick',
        data: candles,
        itemStyle: {
          color: UP_COLOR,
          color0: DOWN_COLOR,
          borderColor: UP_COLOR,
          borderColor0: DOWN_COLOR,
        },
        // 换仓节点竖线: 始终定义为对象, 无节点时空数组即清除(merge 模式防残留)。
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { color: MUTED_COLOR, type: 'dashed', width: 1 },
          label: {
            formatter: nodeDate ? `节点 ${nodeDate.slice(5)}` : '',
            position: 'insideEndTop',
            color: MUTED_COLOR,
            fontSize: 10,
          },
          data: nodeDate ? [{ xAxis: nodeDate }] : [],
        },
      },
      {
        name: '成交量',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: volumes,
        itemStyle: {
          color: (params) => {
            const bar = valid[params.dataIndex];
            return (bar.close ?? 0) >= (bar.open ?? 0) ? UP_COLOR : DOWN_COLOR;
          },
        },
      },
      {
        name: 'MACD',
        type: 'bar',
        xAxisIndex: 2,
        yAxisIndex: 2,
        data: hist,
        itemStyle: {
          color: (params) => ((params.value as number | null) ?? 0) >= 0 ? UP_COLOR : DOWN_COLOR,
        },
        markLine: {
          silent: true,
          symbol: 'none',
          label: { show: false },
          lineStyle: { color: '#bfbfbf', type: 'dashed', width: 1 },
          data: [{ yAxis: 0 }],
        },
      },
      {
        name: 'DIF',
        type: 'line',
        xAxisIndex: 2,
        yAxisIndex: 2,
        data: dif,
        symbol: 'none',
        lineStyle: { width: 1.2, color: DIF_COLOR },
      },
      {
        name: 'DEA',
        type: 'line',
        xAxisIndex: 2,
        yAxisIndex: 2,
        data: dea,
        symbol: 'none',
        lineStyle: { width: 1.2, color: DEA_COLOR },
      },
    ],
  };
}

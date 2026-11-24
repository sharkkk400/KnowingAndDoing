import type { EChartsOption } from 'echarts';
import type { SharesPoint } from '../../api/types';

const LINE_COLOR = '#1677ff';

export function buildSharesOption(points: SharesPoint[]): EChartsOption | null {
  if (points.length < 2) return null;

  return {
    animation: false,
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v) => `${Number(v).toFixed(2)} 亿份`,
    },
    grid: { left: 64, right: 24, top: 24, bottom: 48 },
    xAxis: {
      type: 'category',
      data: points.map((p) => p.date),
      boundaryGap: false,
      axisLabel: { color: '#8c8c8c' },
    },
    yAxis: {
      scale: true,
      axisLabel: { formatter: '{value} 亿' },
      splitLine: { lineStyle: { color: '#f0f0f0' } },
    },
    dataZoom: [{ type: 'inside' }, { type: 'slider', bottom: 8, height: 18 }],
    series: [
      {
        name: '份额',
        type: 'line',
        data: points.map((p) => p.shares_yi),
        showSymbol: false,
        lineStyle: { width: 1.5, color: LINE_COLOR },
        areaStyle: { color: 'rgba(22,119,255,0.08)' },
      },
    ],
  };
}

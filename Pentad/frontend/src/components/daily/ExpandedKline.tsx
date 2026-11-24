import { Typography } from 'antd';
import ReactECharts from 'echarts-for-react';
import { useMemo } from 'react';
import { useKline } from '../../hooks/useEtfs';
import { buildCandleOption } from '../kline/candleOption';

const WINDOW_BARS = 120;
/** 节点后多看约 4 周, 让节点竖线落在窗口右侧而不是贴边。 */
const TAIL_DAYS = 30;
const DAY_MS = 86_400_000;

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 老节点已超出最近 120 根时, 把窗口截止到节点后 30 个自然日; 新节点仍看实时窗口。 */
function windowEnd(nodeDate?: string | null): string | null {
  if (!nodeDate) return null;
  const endMs = new Date(`${nodeDate}T00:00:00`).getTime() + TAIL_DAYS * DAY_MS;
  return endMs >= new Date(`${fmtDate(Date.now())}T00:00:00`).getTime() ? null : fmtDate(endMs);
}

interface Props {
  code: string;
  /** 换仓节点日: 图上画竖线, 并且窗口围绕该日截取。 */
  nodeDate?: string | null;
}

/** 表格展开行的迷你K线: 近120根日K(+当日实时bar); 展开时才挂载, 不展开不请求。 */
export default function ExpandedKline({ code, nodeDate }: Props) {
  const end = useMemo(() => windowEnd(nodeDate), [nodeDate]);
  const kline = useKline(code, 'day', WINDOW_BARS, end == null, end);
  const option = useMemo(() => buildCandleOption(kline.data?.bars ?? [], nodeDate), [kline.data, nodeDate]);

  if (kline.isLoading) return <Typography.Text type="secondary">K 线加载中…</Typography.Text>;
  if (!option) return <Typography.Text type="secondary">K 线数据不足</Typography.Text>;
  return <ReactECharts option={option} style={{ height: 360 }} notMerge />;
}

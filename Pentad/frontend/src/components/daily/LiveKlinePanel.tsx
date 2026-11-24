import { Card, Space, Typography } from 'antd';
import ReactECharts from 'echarts-for-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useKline } from '../../hooks/useEtfs';
import { buildCandleOption } from '../kline/candleOption';

/** 行情时间与服务端相差超过 10 分钟视为失鲜(暂停刷新/休市), 标黄提醒。 */
const STALE_GAP_SEC = 600;
const TICK_MS = 5000;

function gapLabel(asOf: string | null, nowMs: number): { text: string; stale: boolean } {
  if (!asOf) return { text: '行情时间未知', stale: true };
  const asMs = new Date(asOf.replace(' ', 'T')).getTime();
  const gap = Math.max(0, Math.round((nowMs - asMs) / 1000));
  const text = gap >= 120 ? `行情截至 ${asOf.slice(11, 19)} · 距今 ${Math.round(gap / 60)} 分钟` : `行情截至 ${asOf.slice(11, 19)} · 距今 ${gap} 秒`;
  return { text, stale: gap > STALE_GAP_SEC };
}

/** 双卡共用的 K 线面板: 历史日K + 当日实时 bar(后端 live=1 追加), 30 秒随行情刷新。 */
export default function LiveKlinePanel({
  code,
  asOf,
  nodeDate,
  live = true,
}: {
  code: string;
  asOf: string | null;
  /** 换仓节点日: 图上画竖线, 便于对照持仓起点。 */
  nodeDate?: string | null;
  /** false=收盘后快照口径: 没有实时 bar, 不显示行情新鲜度与刷新提示。 */
  live?: boolean;
}) {
  const kline = useKline(code, 'day', 250, true);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const option = useMemo(() => buildCandleOption(kline.data?.bars ?? [], nodeDate), [kline.data, nodeDate]);
  const gap = gapLabel(asOf, nowMs);

  return (
    <Card
      size="small"
      title={
        <Space size={8}>
          K 线
          <Link to={`/etf/${code}`}>{code}</Link>
        </Space>
      }
      extra={
        <Space size={12} wrap>
          <Typography.Text type={live && gap.stale ? 'warning' : 'secondary'}>
            {live ? gap.text : '收盘数据'}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {live ? '日K + 当日实时 · 30 秒刷新' : '日K（含当日收盘）'}
          </Typography.Text>
        </Space>
      }
    >
      {option ? (
        <ReactECharts option={option} style={{ height: 360 }} notMerge />
      ) : (
        <Typography.Text type="secondary">{kline.isLoading ? 'K 线加载中…' : 'K 线数据不足'}</Typography.Text>
      )}
    </Card>
  );
}

import { useMemo, useState } from 'react';
import { Alert, Card, Col, Descriptions, Empty, Row, Segmented, Space, Spin, Statistic, Tag, Typography } from 'antd';
import ReactECharts from 'echarts-for-react';
import { Link, useParams } from 'react-router-dom';
import MacdStatePanel from '../components/kline/MacdStatePanel';
import { buildCandleOption } from '../components/kline/candleOption';
import { buildSharesOption } from '../components/kline/sharesOption';
import { useEtfs, useKline, useMacdStates, useShares } from '../hooks/useEtfs';
import type { DailyBar, KlinePeriod, SharesPoint } from '../api/types';

const PERIOD_OPTIONS: Array<{ label: string; value: KlinePeriod }> = [
  { label: '日K', value: 'day' },
  { label: '周K', value: 'week' },
  { label: '月K', value: 'month' },
];

const PERIOD_LABEL: Record<KlinePeriod, string> = { day: '日', week: '周', month: '月' };

const RANGE_OPTIONS = [
  { label: '1年', value: 0 },
  { label: '3年', value: 1 },
  { label: '6年', value: 2 },
  { label: '全部', value: 3 },
];

// 同一个"年限"在日/周/月K下对应的根数不同。
const RANGE_LIMITS: Record<KlinePeriod, number[]> = {
  day: [250, 750, 1500, 6000],
  week: [52, 156, 312, 1200],
  month: [12, 36, 72, 300],
};

const DAILY_STAT_BARS = 250;

const pct = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;

function closes(bars: DailyBar[]): number[] {
  return bars.map((b) => b.close).filter((v): v is number => v != null);
}

function periodReturn(values: number[], back: number): number | null {
  if (values.length < 2) return null;
  const last = values[values.length - 1];
  const first = values[Math.max(0, values.length - 1 - back)];
  return first ? last / first - 1 : null;
}

function shareChange(points: SharesPoint[]): number | null {
  if (points.length < 2) return null;
  return points[points.length - 1].shares_yi - points[0].shares_yi;
}

export default function EtfDetail() {
  const { code = '' } = useParams();
  const [period, setPeriod] = useState<KlinePeriod>('day');
  const [rangeIndex, setRangeIndex] = useState(1);
  const { data: etfs } = useEtfs();
  const limit = RANGE_LIMITS[period][rangeIndex];
  const kline = useKline(code, period, limit);
  const daily = useKline(code, 'day', DAILY_STAT_BARS);
  const macdStates = useMacdStates(code);
  const shares = useShares(code, 2000);

  const meta = useMemo(() => (etfs ?? []).find((x) => x.code === code), [etfs, code]);
  const bars = useMemo(() => kline.data?.bars ?? [], [kline.data]);
  const dailyBars = useMemo(() => daily.data?.bars ?? [], [daily.data]);
  const sharePoints = useMemo(() => shares.data?.rows ?? [], [shares.data]);

  const candleOption = useMemo(() => buildCandleOption(bars), [bars]);
  const sharesOption = useMemo(() => buildSharesOption(sharePoints), [sharePoints]);

  const dailyCloses = useMemo(() => closes(dailyBars), [dailyBars]);
  const latestClose = dailyCloses.length ? dailyCloses[dailyCloses.length - 1] : null;
  const ret60 = periodReturn(dailyCloses, 60);
  const chartCloses = useMemo(() => closes(bars), [bars]);
  const retWindow = periodReturn(chartCloses, chartCloses.length - 1);
  const latestShares = sharePoints.length ? sharePoints[sharePoints.length - 1].shares_yi : null;
  const sharesDiff = shareChange(sharePoints);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small">
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space align="baseline" wrap>
            <Typography.Title level={4} style={{ margin: 0 }}>
              {meta?.name ?? code}
            </Typography.Title>
            <Tag>{code}</Tag>
            {meta?.fund_type && <Tag color="blue">{meta.fund_type}</Tag>}
            <Link to="/">← 返回清单</Link>
          </Space>
          <Descriptions size="small" column={4}>
            <Descriptions.Item label="K线区间">
              {meta?.daily_first ? `${meta.daily_first} ~ ${meta.daily_last}` : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="K线行数">{meta?.daily_rows.toLocaleString() ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="份额行数">{meta?.shares_rows.toLocaleString() ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="份额截至">{meta?.shares_last ?? '—'}</Descriptions.Item>
          </Descriptions>
        </Space>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={12} md={5}>
          <Card size="small">
            <Statistic title="最新收盘" value={latestClose ?? undefined} precision={3} />
          </Card>
        </Col>
        <Col xs={12} md={5}>
          <Card size="small">
            <Statistic
              title="近60日涨跌"
              value={ret60 == null ? '—' : pct(ret60)}
              valueStyle={{ color: (ret60 ?? 0) >= 0 ? '#f5222d' : '#52c41a' }}
            />
          </Card>
        </Col>
        <Col xs={12} md={5}>
          <Card size="small">
            <Statistic
              title="图表区间涨跌"
              value={retWindow == null ? '—' : pct(retWindow)}
              valueStyle={{ color: (retWindow ?? 0) >= 0 ? '#f5222d' : '#52c41a' }}
            />
          </Card>
        </Col>
        <Col xs={12} md={5}>
          <Card size="small">
            <Statistic title="最新份额(亿份)" value={latestShares ?? undefined} precision={2} />
          </Card>
        </Col>
        <Col xs={12} md={4}>
          <Card size="small">
            <Statistic
              title="区间份额变化(亿)"
              value={sharesDiff == null ? '—' : `${sharesDiff >= 0 ? '+' : ''}${sharesDiff.toFixed(2)}`}
              valueStyle={{ color: (sharesDiff ?? 0) >= 0 ? '#f5222d' : '#52c41a' }}
            />
          </Card>
        </Col>
      </Row>

      <MacdStatePanel states={macdStates.data?.states} loading={macdStates.isLoading} />

      <Card
        size="small"
        title={`${PERIOD_LABEL[period]}K线 · 成交量 · MACD`}
        extra={
          <Space wrap size={8}>
            <Segmented
              options={PERIOD_OPTIONS}
              value={period}
              onChange={(v) => setPeriod(v as KlinePeriod)}
            />
            <Segmented
              options={RANGE_OPTIONS}
              value={rangeIndex}
              onChange={(v) => setRangeIndex(v as number)}
            />
          </Space>
        }
      >
        <Spin spinning={kline.isLoading}>
          {kline.error ? (
            <Alert type="warning" showIcon message="该标的暂无K线数据" description={String(kline.error.message)} />
          ) : candleOption ? (
            <ReactECharts option={candleOption} style={{ height: 560 }} notMerge />
          ) : (
            <Empty description="K线数据不足" />
          )}
        </Spin>
      </Card>

      <Card size="small" title="份额变化（亿份）">
        <Spin spinning={shares.isLoading}>
          {shares.error ? (
            <Alert type="warning" showIcon message="该标的暂无份额数据" description={String(shares.error.message)} />
          ) : sharesOption ? (
            <ReactECharts option={sharesOption} style={{ height: 260 }} notMerge />
          ) : (
            <Empty description="份额数据不足" />
          )}
        </Spin>
      </Card>
    </Space>
  );
}

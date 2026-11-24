import { Card, Col, DatePicker, Row, Segmented, Space, Statistic, Typography } from 'antd';
import dayjs from 'dayjs';
import ReactECharts from 'echarts-for-react';
import { useMemo, useState } from 'react';
import type { DailyAttribution } from '../../api/types';
import { buildDailyBarsOption, buildDailyCumulativeOption } from './attributionOption';
import { buildDailyWindow, summarizeDaily, summarizeGated } from './window';
import { buildGatedOption } from './gatedOption';
import { fmtPct, fmtSignedPct, returnColor } from '../common/format';

interface Props {
  data: DailyAttribution | undefined;
}

type Range = 'all' | 'ytd' | 'since';
type View = 'cumulative' | 'daily' | 'gated';

const RANGE_OPTIONS = [
  { label: '全历史', value: 'all' },
  { label: '今年以来', value: 'ytd' },
  { label: '自选起点', value: 'since' },
];

const VIEW_OPTIONS = [
  { label: '累计走势', value: 'cumulative' },
  { label: '每日涨跌', value: 'daily' },
  { label: '年线开关', value: 'gated' },
];

const VIEW_LABELS: Record<View, string> = {
  cumulative: '日度等权复利',
  daily: '每日涨跌',
  gated: '年线开关净值',
};

function statColor(value: number | null | undefined): string | undefined {
  return value == null ? undefined : returnColor(value);
}

export default function AttributionPanel({ data }: Props) {
  const [range, setRange] = useState<Range>('ytd');
  const [since, setSince] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [view, setView] = useState<View>('cumulative');
  const cumulative = useMemo(() => data?.cumulative ?? [], [data]);
  const year = useMemo(() => {
    const last = cumulative[cumulative.length - 1];
    return last ? Number(last.signal_date.slice(0, 4)) : undefined;
  }, [cumulative]);
  const settledLast = useMemo(() => {
    for (let i = cumulative.length - 1; i >= 0; i -= 1) {
      if (cumulative[i].core != null) return cumulative[i].signal_date;
    }
    return undefined;
  }, [cumulative]);
  const ytdYear = !since && range === 'ytd' ? year : undefined;
  const window = useMemo(() => buildDailyWindow(cumulative, { year: ytdYear, since }), [cumulative, ytdYear, since]);
  const summary = useMemo(() => summarizeDaily(data?.days ?? [], { year: ytdYear, since }), [data, ytdYear, since]);
  const gated = useMemo(() => summarizeGated(window), [window]);
  // 所选日期可能落在非交易日, 展示吸附后的信号日, 保证标题与曲线起点一致。
  const startDate = since ? (window.points[0]?.signal_date ?? since) : null;
  const option = useMemo(() => {
    if (view === 'daily') return buildDailyBarsOption(window);
    if (view === 'gated') return buildGatedOption(window);
    return buildDailyCumulativeOption(window);
  }, [window, view]);

  if (!data || data.days.length === 0) {
    return <Card size="small" title="频率对照归因">暂无带事后收益的日度记录</Card>;
  }

  const rangeLabel = startDate ? `自 ${startDate} 起` : range === 'ytd' ? `${year ?? '-'} 年以来` : '全历史';
  const title = `频率对照归因（${rangeLabel}，${VIEW_LABELS[view]}）`;
  const hs300Cumulative = [...window.points].reverse().find((p) => p.hs300 != null)?.hs300 ?? null;
  const stats =
    view === 'gated'
      ? [
          { title: '评估天数', value: summary.days, color: undefined },
          { title: '开仓 / 空仓', value: `${gated.gateOnDays} / ${gated.gateOffDays}`, color: undefined },
          {
            title: '仅年线上累计',
            value: fmtSignedPct(gated.gatedCumulative),
            color: statColor(gated.gatedCumulative),
          },
          {
            title: '仅年线上回撤',
            value: fmtSignedPct(gated.gatedMaxDrawdown),
            color: statColor(gated.gatedMaxDrawdown),
          },
          {
            title: '每日持有累计',
            value: fmtSignedPct(summary.coreCumulative),
            color: statColor(summary.coreCumulative),
          },
          {
            title: '每日持有回撤',
            value: fmtSignedPct(gated.coreMaxDrawdown),
            color: statColor(gated.coreMaxDrawdown),
          },
        ]
      : [
          { title: '评估天数', value: summary.days, color: undefined },
          { title: '策略累计', value: fmtSignedPct(summary.coreCumulative), color: statColor(summary.coreCumulative) },
          { title: '基线累计', value: fmtSignedPct(summary.baselineCumulative), color: statColor(summary.baselineCumulative) },
          {
            title: '股票池累计',
            value: fmtSignedPct(summary.universeCumulative),
            color: statColor(summary.universeCumulative),
          },
          { title: '沪深300累计', value: fmtSignedPct(hs300Cumulative), color: statColor(hs300Cumulative) },
          { title: 'IC 均值', value: summary.rankIcMean?.toFixed(3) ?? '—', color: statColor(summary.rankIcMean) },
          { title: '策略胜率', value: fmtPct(summary.corePositive, 1), color: undefined },
          { title: '日均换手', value: data.overall.turnover_avg == null ? '—' : fmtPct(data.overall.turnover_avg, 0), color: undefined },
        ];
  const anchorNote = startDate
    ? `，以 ${startDate} 为起点归零`
    : range === 'ytd'
      ? '，年初起点归零（含收益落在本年的跨年结算日）'
      : '';
  const note =
    view === 'daily'
      ? `每日涨跌 = 信号日收盘 → 下一交易日收盘的等权组合收益；策略持仓为柱体，红涨绿跌。${startDate ? ` 仅显示 ${startDate} 起的交易日。` : ''}`
      : view === 'gated'
        ? `仅年线上执行 = 信号日沪深300 收盘 > MA250（严格大于，年线未热身按空仓）的交易日才承受策略持仓当日收益，其余交易日空仓记 0 收益；每日持有 = 不看年线、每个交易日都按当前节点持仓承受当日收益。淡红区为年线下方，回撤为窗口内最大回撤，不扣费用。注意：日频每日判定开关意味着每日申赎，实际执行会有申赎摩擦，本视图只展示门控的归因效果，不是可执行收益。${startDate ? ` 累计与回撤均以 ${startDate} 为起点。` : ''}`
        : `策略持仓 vs 基线 vs 股票池：按每日等权组合收益复利累乘${anchorNote}，不扣手续费与申赎摩擦；日均换手 = 策略持仓相邻交易日被换掉的占比，换仓节点才跳升。`;

  return (
    <Card
      size="small"
      title={title}
      extra={
        <Space size={8} wrap>
          <Space size={4}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              自
            </Typography.Text>
            <DatePicker
              size="small"
              allowClear
              placeholder="选一日"
              style={{ width: 124 }}
              value={startDate ? dayjs(startDate) : null}
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              disabledDate={(d) => {
                const day = d.format('YYYY-MM-DD');
                const first = cumulative[0]?.signal_date;
                return (first != null && day < first) || (settledLast != null && day > settledLast);
              }}
              onChange={(d) => {
                setSince(d ? d.format('YYYY-MM-DD') : null);
                setRange(d ? 'since' : 'all');
              }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              起
            </Typography.Text>
          </Space>
          <Segmented
            size="small"
            options={RANGE_OPTIONS}
            value={range}
            onChange={(v) => {
              const next = v as Range;
              setRange(next);
              if (next === 'since') {
                setPickerOpen(true);
                return;
              }
              setSince(null);
              setPickerOpen(false);
            }}
          />
          <Segmented size="small" options={VIEW_OPTIONS} value={view} onChange={(v) => setView(v as View)} />
        </Space>
      }
    >
      <Row gutter={16}>
        {stats.map((s) => (
          <Col xs={12} sm={8} md={3} key={s.title}>
            <Statistic title={s.title} value={s.value} valueStyle={{ color: s.color, fontSize: 20 }} />
          </Col>
        ))}
      </Row>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {note}
      </Typography.Text>
      {window.points.length === 0 ? (
        <Typography.Paragraph type="secondary" style={{ marginTop: 24 }}>
          该区间还没有已结算的日度记录
        </Typography.Paragraph>
      ) : (
        <ReactECharts option={option} style={{ height: view === 'gated' ? 460 : 360 }} notMerge />
      )}
    </Card>
  );
}

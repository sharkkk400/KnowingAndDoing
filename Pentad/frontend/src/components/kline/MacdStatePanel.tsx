import { Card, Col, Row, Space, Tag, Tooltip, Typography } from 'antd';
import type { KlinePeriod, MacdState, MacdTrend, MacdZone } from '../../api/types';

interface Props {
  states?: Record<KlinePeriod, MacdState | null>;
  loading?: boolean;
}

const PERIODS: Array<{ key: KlinePeriod; label: string }> = [
  { key: 'day', label: '日线' },
  { key: 'week', label: '周线' },
  { key: 'month', label: '月线' },
];

const TREND: Record<MacdTrend, { text: string; color: string; hint: string }> = {
  rising: { text: '走强', color: 'volcano', hint: 'MACD 柱体较上一周期上行，动能增强' },
  falling: { text: '走弱', color: 'cyan', hint: 'MACD 柱体较上一周期下行，动能衰减（含柱体由正翻负的转空）' },
  flat: { text: '走平', color: 'default', hint: 'MACD 柱体与上一周期基本持平' },
};

const FLIP: Record<string, { text: string; color: string }> = {
  golden: { text: '金叉', color: 'red' },
  dead: { text: '死叉', color: 'green' },
};

const ZONE: Record<MacdZone, { text: string; color: string; hint: string }> = {
  above: { text: '水上', color: 'red', hint: '柱体在零轴上方（红柱），多头区域' },
  below: { text: '水下', color: 'green', hint: '柱体在零轴下方（绿柱），空头区域；绿柱缩短只代表本轮下跌动能暂停，常见于阴跌中继' },
  zero: { text: '零轴', color: 'default', hint: '柱体恰在零轴，多空临界' },
};

function signed(value: number, digits = 3): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function PeriodCard({ label, state }: { label: string; state: MacdState | null | undefined }) {
  if (!state) {
    return (
      <Card size="small" title={`${label} MACD`}>
        <Typography.Text type="secondary">预热不足，暂无法判定</Typography.Text>
      </Card>
    );
  }
  const trend = TREND[state.trend];
  const zone = ZONE[state.zone];
  const flip = state.flip ? FLIP[state.flip] : null;
  return (
    <Card size="small" title={`${label} MACD`}>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space size={4} wrap>
          <Tooltip title={trend.hint}>
            <Tag color={trend.color} style={{ marginInlineEnd: 0 }}>
              {trend.text}
            </Tag>
          </Tooltip>
          {flip ? (
            <Tag color={flip.color} style={{ marginInlineEnd: 0 }}>
              {flip.text}
            </Tag>
          ) : null}
          <Tooltip title={zone.hint}>
            <Tag color={zone.color} style={{ marginInlineEnd: 0 }}>
              {zone.text}
            </Tag>
          </Tooltip>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {state.date}
          </Typography.Text>
        </Space>
        <Typography.Text style={{ fontSize: 13 }}>
          DIF {signed(state.dif)} · DEA {signed(state.dea)} · 柱 {signed(state.hist)}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          上一周期柱 {signed(state.hist_prev)}
        </Typography.Text>
      </Space>
    </Card>
  );
}

export default function MacdStatePanel({ states, loading }: Props) {
  return (
    <Card
      size="small"
      title="MACD 周期状态"
      loading={loading}
      extra={
        <Tooltip title="柱体较上一周期上行=走强，下行=走弱；柱体由正翻负属于转空，不能按绝对值判成放大；柱体穿越零轴=金叉/死叉；周线固定比较已收盘的上周与上上周（当周K与当周收盘同日，容易与日线同源）；水上/水下按当根柱体符号判定——红柱=水上、绿柱=水下">
          <Typography.Text type="secondary" style={{ cursor: 'help' }}>
            判定口径
          </Typography.Text>
        </Tooltip>
      }
    >
      <Row gutter={[12, 12]}>
        {PERIODS.map(({ key, label }) => (
          <Col xs={24} md={8} key={key}>
            <PeriodCard label={label} state={states?.[key]} />
          </Col>
        ))}
      </Row>
    </Card>
  );
}

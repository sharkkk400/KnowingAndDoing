import { Card, Col, Row, Statistic, Tag, Typography } from 'antd';
import type { DailyDetail } from '../../api/types';
import { fmtPct, fmtSignedPct, returnColor } from '../common/format';
import { ruleVersionLabel } from './ruleLabel';

interface Props {
  day: DailyDetail;
}

const MIN_SAMPLE = 30;

export default function SummaryCards({ day }: Props) {
  const evalSkipped = Boolean(day.evaluation.skipped);
  const cards = [
    {
      title: '股票池次日均值',
      value: fmtSignedPct(day.universe_mean),
      color: returnColor(day.universe_mean),
      hit: day.universe_hit,
      n: day.evaluation.universe?.n,
    },
    {
      title: '策略持仓 次日均值',
      value: fmtSignedPct(day.core_mean),
      color: returnColor(day.core_mean),
      hit: day.core_hit,
      n: day.evaluation.core_holdings?.n,
    },
    {
      title: '基线前10 次日均值',
      value: fmtSignedPct(day.baseline_mean),
      color: returnColor(day.baseline_mean),
      hit: day.baseline_hit,
      n: day.evaluation.baseline_top10?.n,
    },
    {
      title: 'Rank IC',
      value: day.rank_ic == null ? '—' : day.rank_ic.toFixed(2),
      color: day.rank_ic == null ? undefined : returnColor(day.rank_ic),
      hit: null,
      n: null,
    },
  ];

  return (
    <Row gutter={16}>
      {cards.map((card) => (
        <Col xs={12} md={6} key={card.title}>
          <Card size="small">
            <Statistic title={card.title} value={card.value} valueStyle={{ color: card.color, fontSize: 24 }} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {card.hit == null ? '截面排序方向' : `命中率 ${fmtPct(card.hit, 1)} · 样本 ${card.n ?? '—'}`}
            </Typography.Text>
            {card.n != null && card.n < MIN_SAMPLE ? (
              <Tag color="warning" style={{ marginInlineStart: 6 }}>
                样本不足
              </Tag>
            ) : null}
          </Card>
        </Col>
      ))}
      <Col span={24} style={{ marginTop: 4 }}>
        <Typography.Text type="secondary">
          信号 {day.signal_date} → 次日 {day.next_signal ?? '未收盘'} 结算 · 当日有K线 {day.codes_with_bar} 只 · 可评分{' '}
          {day.scored} 只 · 有份额 {day.shares_available} 只 · 规则版本 {ruleVersionLabel(day.rule_version)}
          {evalSkipped ? ` · ${day.evaluation.skipped}` : ''}
        </Typography.Text>
      </Col>
    </Row>
  );
}

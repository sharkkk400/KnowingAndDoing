import { Alert, Card, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { DailyNodeDetail, DailyNodePick } from '../../api/types';
import { fmtNum, fmtSignedPct, returnColor } from '../common/format';
import { ActionTag } from './actionTag';
import ExpandedKline from './ExpandedKline';
import FactorBreakdown from './FactorBreakdown';
import { codeColumn, nameColumn } from './linkColumns';
import { ruleVersionLabel } from './ruleLabel';

interface Props {
  detail: DailyNodeDetail | undefined;
  loading: boolean;
  error: unknown;
}

const holdingColumns: ColumnsType<DailyNodePick> = [
  codeColumn<DailyNodePick>(86),
  nameColumn<DailyNodePick>(),
  { title: '主题', dataIndex: 'theme', width: 96, render: (v: string | null) => v ?? '—' },
  {
    title: '排名',
    width: 76,
    render: (_, row) => <Tag color={row.core_rank <= 5 ? 'gold' : 'blue'}>{row.core_rank}</Tag>,
  },
  { title: '策略分', width: 90, align: 'right', render: (_, row) => fmtNum(row.core_score) },
  {
    title: '成交价',
    width: 96,
    align: 'right',
    render: (_, row) => fmtNum(row.entry_price ?? row.price, 3),
  },
  { title: '结算价', width: 96, align: 'right', render: (_, row) => fmtNum(row.next_price, 3) },
  {
    title: '区间收益',
    width: 96,
    align: 'right',
    render: (_, row) => <span style={{ color: returnColor(row.return) }}>{fmtSignedPct(row.return)}</span>,
  },
  { title: '动作', width: 104, render: (_, row) => <ActionTag action={row.action} /> },
];

const rankedColumns: ColumnsType<DailyNodePick> = [
  {
    title: '排名',
    width: 70,
    render: (_, row) => <Tag color={row.core_rank <= 5 ? 'gold' : 'default'}>{row.core_rank}</Tag>,
  },
  codeColumn<DailyNodePick>(90),
  nameColumn<DailyNodePick>(),
  { title: '主题', dataIndex: 'theme', width: 100, render: (v: string | null) => v ?? '—' },
  { title: '策略分', width: 92, align: 'right', render: (_, row) => fmtNum(row.core_score) },
  { title: '动作', width: 104, render: (_, row) => (row.action === 'rank' ? '—' : <ActionTag action={row.action} />) },
];

export default function NodeDetailCard({ detail, loading, error }: Props) {
  if (error) {
    return <Alert type="error" showIcon message="节点明细加载失败" description={String(error)} />;
  }
  if (loading) return <Card size="small" loading />;
  if (!detail) return null;

  const held = new Set(detail.holdings.map((p) => p.code));

  return (
    <Card
      size="small"
      title={`换仓节点 ${detail.signal_date}`}
      extra={
        <Space size={8} wrap>
          <Tag color="blue">{ruleVersionLabel(detail.rule_version)}</Tag>
          <Tag>{detail.next_rebalance ? `下次换仓 ${detail.next_rebalance}` : '已到日历尾部'}</Tag>
          <Typography.Text type="secondary">
            评分池 {detail.scored} · 节点等权收益{' '}
            <span style={{ color: returnColor(detail.return) }}>{fmtSignedPct(detail.return)}</span>
          </Typography.Text>
        </Space>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          每 5 个交易日换仓一次：周四收盘先卖出预备排名掉出前 15 的持仓（当天份额只到 T-1），周四份额落地后按完整排名重算，
          周五开盘买足前 5 名、并卖出仍被挤出缓冲带的持仓。买入与顺延卖按次日开盘成交，其余按节点收盘计价；
          收盘卖出当日收益记 0，等权、不扣费用，与日度归因同口径。点行首箭头看该标的 K 线（虚线标节点日）与策略分构成。
        </Typography.Text>

        <Table<DailyNodePick>
          size="small"
          rowKey="code"
          columns={holdingColumns}
          dataSource={detail.holdings}
          pagination={false}
          scroll={{ x: 980 }}
          expandable={{
            expandedRowRender: (row) => (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <ExpandedKline code={row.code} nodeDate={detail.signal_date} />
                <FactorBreakdown
                  factors={row.factors}
                  total={row.core_score}
                  date={detail.signal_date}
                  scored={detail.scored}
                />
              </Space>
            ),
          }}
        />

        {detail.sells.length > 0 && (
          <Space size={6} wrap>
            <Typography.Text type="secondary">本次卖出：</Typography.Text>
            {detail.sells.map((p) => (
              <Tag key={p.code} color={p.sell_at === 'open' ? 'orange' : undefined}>
                {p.code} {p.name ?? ''} · 排名 {p.core_rank} · {p.sell_at === 'open' ? '周五开盘卖' : '周四收盘卖'} ·{' '}
                {fmtSignedPct(p.return)}
              </Tag>
            ))}
          </Space>
        )}

        <Typography.Text type="secondary">策略评分前 20</Typography.Text>
        <Table<DailyNodePick>
          size="small"
          rowKey="code"
          columns={rankedColumns}
          dataSource={detail.ranked}
          pagination={false}
          scroll={{ x: 720 }}
          onRow={(row) => ({ style: { background: held.has(row.code) ? '#f0f7ff' : undefined } })}
        />
      </Space>
    </Card>
  );
}

import { Card, Input, Segmented, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState } from 'react';
import type { DailyHoldingSpell } from '../../api/types';
import { fmtNum, fmtSignedPct, returnColor } from '../common/format';
import { codeColumn, nameColumn } from './linkColumns';

interface Props {
  spells: DailyHoldingSpell[];
  loading?: boolean;
}

type Scope = 'all' | 'holding';

const columns: ColumnsType<DailyHoldingSpell> = [
  codeColumn<DailyHoldingSpell>(86, 'left'),
  nameColumn<DailyHoldingSpell>(130),
  { title: '主题', dataIndex: 'theme', width: 100, render: (v: string | null) => v ?? '—' },
  { title: '买入节点', dataIndex: 'entry', width: 110 },
  {
    title: '卖出节点',
    dataIndex: 'exit',
    width: 110,
    render: (exit: string | null) => (exit ? exit : <Tag color="green">持有中</Tag>),
  },
  { title: '持有节点', dataIndex: 'nodes', width: 90, align: 'right' },
  {
    title: '排名(进→出)',
    width: 128,
    align: 'right',
    render: (_, row) => (
      <span>
        {row.entry_rank} → {row.holding ? '—' : row.last_rank}
      </span>
    ),
  },
  {
    title: '买入价',
    dataIndex: 'entry_price',
    width: 88,
    align: 'right',
    render: (v: number | null) => fmtNum(v, 3),
  },
  {
    title: '卖出价',
    dataIndex: 'exit_price',
    width: 88,
    align: 'right',
    render: (v: number | null) => fmtNum(v, 3),
  },
  {
    title: '区间收益',
    dataIndex: 'return',
    width: 100,
    align: 'right',
    render: (v: number | null) => <span style={{ color: returnColor(v) }}>{fmtSignedPct(v)}</span>,
  },
];

/** 每只 ETF 的持有区间: 连续持有的节点合并成一段, 卖出节点即区间终点。 */
export default function TimelineTable({ spells, loading }: Props) {
  const [keyword, setKeyword] = useState('');
  const [scope, setScope] = useState<Scope>('all');

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return spells
      .filter((s) => {
        if (scope === 'holding' && !s.holding) return false;
        if (!kw) return true;
        return (
          s.code.includes(kw) ||
          (s.name ?? '').toLowerCase().includes(kw) ||
          (s.theme ?? '').toLowerCase().includes(kw)
        );
      })
      .sort((a, b) => b.entry.localeCompare(a.entry) || a.code.localeCompare(b.code));
  }, [spells, keyword, scope]);

  const holding = spells.filter((s) => s.holding).length;

  return (
    <Card
      size="small"
      title="持仓时间线"
      extra={
        <Typography.Text type="secondary">
          共 {spells.length} 段 · 持有中 {holding} · 一个节点 = 5 个交易日
        </Typography.Text>
      }
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space wrap>
          <Input
            allowClear
            placeholder="搜索代码 / 名称 / 主题"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            style={{ width: 240 }}
          />
          <Segmented<Scope>
            value={scope}
            onChange={setScope}
            options={[
              { label: '全部', value: 'all' },
              { label: `持有中（${holding}）`, value: 'holding' },
            ]}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            买入按节点次日开盘、顺延卖按次日开盘、其余按节点收盘计价，等权、不扣费用；持有中的段暂无卖出价。
          </Typography.Text>
        </Space>
        <Table<DailyHoldingSpell>
          size="small"
          rowKey={(row) => `${row.code}-${row.entry}`}
          columns={columns}
          dataSource={filtered}
          loading={loading}
          scroll={{ x: 1060 }}
          pagination={{ defaultPageSize: 20, showSizeChanger: true, pageSizeOptions: [20, 50, 100] }}
        />
      </Space>
    </Card>
  );
}

import { Card, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo } from 'react';
import type { DailyRow } from '../../api/types';
import { fmtSignedPct, returnColor, todayStr } from '../common/format';

interface Props {
  rows: DailyRow[];
}

const columns: ColumnsType<DailyRow> = [
  { title: '信号日', dataIndex: 'signal_date', width: 110, fixed: 'left' },
  { title: '次日', dataIndex: 'next_signal', width: 110 },
  {
    title: '股票池',
    dataIndex: 'universe_mean',
    align: 'right',
    render: (v: number | null) => <span style={{ color: returnColor(v) }}>{fmtSignedPct(v)}</span>,
  },
  {
    title: '策略持仓',
    dataIndex: 'core_mean',
    align: 'right',
    render: (v: number | null) => <span style={{ color: returnColor(v) }}>{fmtSignedPct(v)}</span>,
  },
  {
    title: '基线前10',
    dataIndex: 'baseline_mean',
    align: 'right',
    render: (v: number | null) => <span style={{ color: returnColor(v) }}>{fmtSignedPct(v)}</span>,
  },
  {
    title: 'Rank IC',
    dataIndex: 'rank_ic',
    align: 'right',
    render: (v: number | null) => <span style={{ color: returnColor(v) }}>{v == null ? '—' : v.toFixed(2)}</span>,
  },
  { title: '可评分', dataIndex: 'scored', align: 'right', width: 80 },
];

/** 逐日复盘记录: 只做滚动观察, 日度操作计划看「节点」tab。 */
export default function HistoryTable({ rows }: Props) {
  // 交易日历预铺到年末, 未来日期的行全是空值, 只展示已到达的信号日。
  const reached = useMemo(() => {
    const today = todayStr();
    return rows.filter((d) => d.signal_date <= today).reverse();
  }, [rows]);

  return (
    <Card
      size="small"
      title="逐日记录"
      extra={<Typography.Text type="secondary">信号日收盘 → 次日收盘的等权收益</Typography.Text>}
    >
      <Table<DailyRow>
        size="small"
        rowKey="signal_date"
        columns={columns}
        dataSource={reached}
        pagination={{ defaultPageSize: 20, showSizeChanger: true, pageSizeOptions: [20, 50, 100] }}
        scroll={{ x: 720 }}
      />
    </Card>
  );
}

import { Card, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo } from 'react';
import type { LiveHeldPick, RealtimeQuote } from '../../api/types';
import { fmtNum, fmtSignedPct, returnColor } from '../common/format';
import { codeColumn, nameColumn } from './linkColumns';
import { quoteColumns } from './quoteColumns';

interface Props {
  /** 上一节点(或收盘正式节点)的持仓名单。 */
  held: LiveHeldPick[];
  /** 策略实时目标名单: 在册=「拿着」, 不在=「卖出」。收盘后目标=持仓, 全部为拿着。 */
  targetCodes: ReadonlySet<string>;
  /** 持仓所属节点日, 标注在卡片标题。 */
  nodeLabel?: string | null;
  quotes: Record<string, RealtimeQuote> | undefined;
  /** 排名列展示「节点时 → 今日」: 盘中为实时排名, 收盘后为当日收盘快照的策略排名。 */
  rankBounds?: { holdTop: number; bufferRank: number };
  onSelect: (code: string) => void;
}

/** 右卡: 当前持仓 + 节点→今日排名 + 本轮周期涨跌; 只有换仓节点日出现「需卖出」提示。 */
export default function HoldingCard({ held, targetCodes, nodeLabel, quotes, rankBounds, onSelect }: Props) {
  const sold = held.filter((h) => !targetCodes.has(h.code)).length;

  /** 组合本轮收益 = 各持仓「节点收盘 → 现价」的等权平均(缺价的持仓剔除)。 */
  const period = useMemo(() => {
    const rets = held.flatMap((h) => {
      const price = quotes?.[h.code]?.price;
      return h.node_close != null && price != null ? [price / h.node_close - 1] : [];
    });
    return { ret: rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null, count: rets.length };
  }, [held, quotes]);

  const columns: ColumnsType<LiveHeldPick> = [
    codeColumn<LiveHeldPick>(),
    nameColumn<LiveHeldPick>(),
    {
      title: rankBounds ? (
        <Tooltip title="节点时排名 → 今日排名（盘中为实时, 收盘后为收盘快照）。跌出缓冲带下次节点会被换出; 今日走弱时重点看这一列">
          排名 节点→今日
        </Tooltip>
      ) : (
        '节点时排名'
      ),
      width: rankBounds ? 150 : 100,
      render: (_, row) => {
        const nodeTag = (
          <Tag color={row.core_rank <= (rankBounds?.holdTop ?? 5) ? 'gold' : 'blue'} style={{ marginInlineEnd: 0 }}>
            {row.core_rank}
          </Tag>
        );
        if (!rankBounds) return nodeTag;
        const today = row.today_rank;
        const color = today == null || today > rankBounds.bufferRank ? 'red' : today <= rankBounds.holdTop ? 'gold' : 'blue';
        return (
          <Space size={4}>
            {nodeTag}
            <Typography.Text type="secondary">→</Typography.Text>
            <Tag color={color} style={{ marginInlineEnd: 0 }}>
              {today ?? '—'}
            </Tag>
          </Space>
        );
      },
    },
    { title: '节点时分', width: 92, align: 'right', render: (_, row) => fmtNum(row.core_score) },
    ...quoteColumns<LiveHeldPick>(quotes),
    {
      title: <Tooltip title="现价相对换仓节点日收盘的涨跌幅 = 持仓期收益">节点涨跌</Tooltip>,
      width: 96,
      align: 'right',
      render: (_, row) => {
        const price = quotes?.[row.code]?.price;
        if (row.node_close == null || price == null) return <Typography.Text type="secondary">—</Typography.Text>;
        const pct = price / row.node_close - 1;
        return <span style={{ color: returnColor(pct) }}>{fmtSignedPct(pct)}</span>;
      },
    },
  ];

  return (
    <Card
      size="small"
      title={
        <Space size={8}>
          当前持仓
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal' }}>
            截至节点 {nodeLabel ?? '—'}
          </Typography.Text>
        </Space>
      }
      extra={
        <Space size={12}>
          {period.ret != null && (
            <Tooltip
              title={`${period.count}/${held.length} 只有节点收盘与现价; 等权平均 = 节点日等额买入各持仓至今的组合收益`}
            >
              <span style={{ fontSize: 12, color: 'rgba(0, 0, 0, 0.45)' }}>
                本轮等权{' '}
                <span style={{ fontSize: 15, fontWeight: 600, color: returnColor(period.ret) }}>
                  {fmtSignedPct(period.ret)}
                </span>
              </span>
            </Tooltip>
          )}
          {sold > 0 && (
            <Tag color="red" style={{ marginInlineEnd: 0 }}>
              节点日需卖出 {sold}
            </Tag>
          )}
        </Space>
      }
    >
      <Table<LiveHeldPick>
        size="small"
        rowKey="code"
        columns={columns}
        dataSource={held}
        pagination={false}
        scroll={{ x: 682 }}
        onRow={(row) => ({ onClick: () => onSelect(row.code), style: { cursor: 'pointer' } })}
      />
    </Card>
  );
}

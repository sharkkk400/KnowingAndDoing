import { Card, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo } from 'react';
import type { LiveHeldPick, RealtimeQuote, TodayTopPick } from '../../api/types';
import { fmtSignedPct, returnColor } from '../common/format';
import { codeColumn, nameColumn } from './linkColumns';
import { quoteColumns } from './quoteColumns';
import { HOLD_BUFFER_RANK, HOLD_TOP, TODAY_TOP_N } from './rankBounds';

interface Props {
  /** live=盘中实时预演, close=当日收盘快照; 只影响标题与时间标签。 */
  mode: 'live' | 'close';
  /** 榜单名单: 盘中为实时排名前 N, 收盘为快照日的策略排名前 N。 */
  top: TodayTopPick[];
  /** 当前节点持仓, 用于「状态」列与节点涨跌基准。 */
  held: LiveHeldPick[];
  quotes: Record<string, RealtimeQuote> | undefined;
  holdTop?: number;
  bufferRank?: number;
  /** 盘中行情时间戳(YYYY-MM-DD HH:MM:SS)。 */
  asOf?: string | null;
  /** 收盘快照的交易日。 */
  snapshotDate?: string | null;
  /** 换仓节点日: 节点涨跌的基准日。 */
  nodeDate?: string | null;
  rebalance?: boolean;
  nextRebalance?: string | null;
  /** 收盘快照尚未返回: 先占位显示加载态, 避免右卡先满宽再被挤成两列。 */
  loading?: boolean;
  /** 点行切换下方 K 线面板。 */
  onSelect: (code: string) => void;
}

/**
 * 左卡: TOP N 名单, 与右卡的节点持仓并排对照。
 * 盘中看实时排名; 收盘后实时排名消失, 改用当日收盘快照的策略排名, 同样能看出
 * "若今天是节点会买谁"与现持仓的差异。收盘后没有实时行情基准的名单仍用节点收盘价。
 */
export default function TopRankCard({
  mode,
  top,
  held,
  quotes,
  holdTop = HOLD_TOP,
  bufferRank = HOLD_BUFFER_RANK,
  asOf,
  snapshotDate,
  nodeDate,
  rebalance,
  nextRebalance,
  loading,
  onSelect,
}: Props) {
  const heldByCode = useMemo(() => new Map(held.map((h) => [h.code, h])), [held]);

  const topBuyHeld = top.slice(0, holdTop).filter((r) => heldByCode.has(r.code)).length;
  const inBuffer = held.filter((h) => h.today_rank != null && h.today_rank <= bufferRank).length;
  const outCount = held.length - inBuffer;

  const columns: ColumnsType<TodayTopPick> = [
    {
      title: mode === 'live' ? '今日排名' : '排名',
      width: 92,
      render: (_, row) => (
        <Tag color={row.rank <= holdTop ? 'gold' : 'blue'} style={{ marginInlineEnd: 0 }}>
          {row.rank}
        </Tag>
      ),
    },
    codeColumn<TodayTopPick>(),
    nameColumn<TodayTopPick>(),
    ...quoteColumns<TodayTopPick>(quotes),
    {
      title: (
        <Tooltip
          title={`节点日${nodeDate ? `（${nodeDate}）` : ''}收盘 → 现价的涨跌: 持有=本轮持有周期收益, 未持有=若节点买入至今`}
        >
          节点涨跌
        </Tooltip>
      ),
      width: 96,
      align: 'right',
      render: (_, row) => {
        const price = quotes?.[row.code]?.price;
        const base = row.node_close ?? heldByCode.get(row.code)?.node_close ?? null;
        if (base == null || price == null) return <Typography.Text type="secondary">—</Typography.Text>;
        const pct = price / base - 1;
        return <span style={{ color: returnColor(pct) }}>{fmtSignedPct(pct)}</span>;
      },
    },
    {
      title: '状态',
      width: 88,
      render: (_, row) =>
        heldByCode.has(row.code) ? (
          <Tag color="green" style={{ marginInlineEnd: 0 }}>持有</Tag>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>未持有</Typography.Text>
        ),
    },
  ];

  return (
    <Card
      size="small"
      title={
        <Space size={8}>
          {mode === 'live' ? '今日实时' : '收盘'} TOP{TODAY_TOP_N}
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal' }}>
            买入区 = 前 {holdTop}
          </Typography.Text>
        </Space>
      }
      extra={
        <Space size={8} wrap>
          {mode === 'live' ? (
            <>
              {rebalance ? <Tag color="gold">今日换仓节点</Tag> : <Tag>非换仓日</Tag>}
              {nextRebalance && <Tag>下次换仓 {nextRebalance}</Tag>}
              <Typography.Text type="secondary">行情 {asOf ? asOf.slice(11, 19) : '—'}</Typography.Text>
            </>
          ) : (
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              收盘快照 {snapshotDate ?? '—'}
            </Tag>
          )}
        </Space>
      }
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Table<TodayTopPick>
          size="small"
          rowKey="code"
          loading={loading}
          columns={columns}
          dataSource={top}
          pagination={false}
          scroll={{ x: 600 }}
          onRow={(row) => ({
            onClick: () => onSelect(row.code),
            style: {
              cursor: 'pointer',
              background: heldByCode.has(row.code) ? '#f6ffed' : undefined,
            },
          })}
        />
        {!loading && top.length > 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            TOP{holdTop} 已持有 {topBuyHeld}/{holdTop} · 节点持仓 {inBuffer}/{held.length} 只仍在缓冲带(≤{bufferRank})
            {outCount > 0 && `，${outCount} 只超出`}
          </Typography.Text>
        )}
      </Space>
    </Card>
  );
}

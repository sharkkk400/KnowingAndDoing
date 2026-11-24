import { Alert, Button, Card, Popconfirm, Progress, Space, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DailyNodeRow } from '../../api/types';
import { useDailyCoreStatus, useDailyNode, useDailyNodes, useRebuildDailyCore } from '../../hooks/useDailyPick';
import { fmtSignedPct, returnColor } from '../common/format';
import NodeDetailCard from './NodeDetailCard';

const REBALANCE_EVERY = 5;

/** 换仓节点: 每次换仓的完整交易计划(买/继续持有/卖), 默认展开最新节点。 */
export default function NodePanel() {
  const nodes = useDailyNodes();
  const [selected, setSelected] = useState<string>();
  const rows = useMemo(() => [...(nodes.data ?? [])].reverse(), [nodes.data]);
  const active = selected ?? rows[0]?.signal_date;
  const detail = useDailyNode(active);
  const detailRef = useRef<HTMLDivElement>(null);

  // 明细在节点表下方, 点日期后滚过去, 否则看不到选中结果
  const pick = (date: string) => {
    setSelected(date);
    detailRef.current?.scrollIntoView({ block: 'start' });
  };

  const status = useDailyCoreStatus();
  const rebuild = useRebuildDailyCore();
  const queryClient = useQueryClient();
  const running = status.data?.state === 'running';
  const wasRunning = useRef(false);

  useEffect(() => {
    if (wasRunning.current && !running && status.data?.state === 'done') {
      queryClient.invalidateQueries({ queryKey: ['daily', 'core'] });
      queryClient.invalidateQueries({ queryKey: ['daily', 'nodes'] });
      queryClient.invalidateQueries({ queryKey: ['daily', 'node'] });
    }
    wasRunning.current = running;
  }, [running, status.data?.state, queryClient]);

  const columns: ColumnsType<DailyNodeRow> = [
    {
      title: '换仓日',
      dataIndex: 'signal_date',
      width: 120,
      fixed: 'left',
      render: (date: string) => (
        <Button type="link" size="small" style={{ padding: 0 }} onClick={() => pick(date)}>
          {date}
        </Button>
      ),
    },
    { title: '下次换仓', dataIndex: 'next_rebalance', width: 110, render: (v: string | null) => v ?? '—' },
    {
      title: '持仓',
      dataIndex: 'holdings',
      render: (items: DailyNodeRow['holdings']) => (
        <Typography.Text style={{ fontSize: 12 }}>
          {items.map((p) => `${p.code}${p.name ? ` ${p.name}` : ''}`).join(' · ')}
        </Typography.Text>
      ),
    },
    {
      title: '动作',
      width: 200,
      render: (_, row) => (
        <Space size={4} wrap>
          <Tag color="red">买 {row.counts.buy}</Tag>
          <Tag color="blue">持 {row.counts.hold}</Tag>
          <Tag>卖 {row.counts.sell}</Tag>
        </Space>
      ),
    },
    {
      title: '节点收益',
      dataIndex: 'return',
      width: 100,
      align: 'right',
      render: (v: number | null) => <span style={{ color: returnColor(v) }}>{fmtSignedPct(v)}</span>,
    },
    {
      title: '前10等权',
      dataIndex: 'top10_return',
      width: 100,
      align: 'right',
      render: (v: number | null) => <span style={{ color: returnColor(v) }}>{fmtSignedPct(v)}</span>,
    },
    {
      title: '沪深300',
      dataIndex: 'hs300_return',
      width: 100,
      align: 'right',
      render: (v: number | null) => <span style={{ color: returnColor(v) }}>{fmtSignedPct(v)}</span>,
    },
    { title: '评分池', dataIndex: 'scored', width: 84, align: 'right' },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title={`换仓节点 · 每 ${REBALANCE_EVERY} 个交易日一次`}
        extra={
          <Space size={8} wrap>
            <Typography.Text type="secondary">共 {rows.length} 个节点</Typography.Text>
            <Popconfirm
              title="回填全部换仓节点？"
              description="从 2015-01-05 锚点起每 5 个交易日推演一次，历史越长耗时越久（约 5 分钟）。"
              onConfirm={() => rebuild.mutate()}
              disabled={running}
            >
              <Button size="small" loading={rebuild.isPending || running} disabled={running}>
                {running ? '回填中' : '回填节点'}
              </Button>
            </Popconfirm>
          </Space>
        }
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            每个节点就是一次完整交易计划：本次买入谁、谁继续持有、谁被卖出。节点之间持仓不变，
            所以「持有中」的日子没有新记录；节点收益按混合执行价结算：周四收盘卖、周五开盘买与顺延卖，
            其余按节点收盘，等权、不扣费用。「前10等权」是同一节点评分前 10 名持有到下一节点的收盘收益，
            「沪深300」是同区间指数涨跌，两者都不含成本，用来对照集中到 5 只划不划算、涨跌里有多少是市场给的。
          </Typography.Text>
          {running && (
            <Progress
              status="active"
              percent={status.data?.total ? Math.floor(((status.data.done ?? 0) / status.data.total) * 100) : 0}
              format={() => `${status.data?.done ?? 0}/${status.data?.total ?? 0}`}
            />
          )}
          {running && <Typography.Text type="secondary">{status.data?.msg}</Typography.Text>}
          {status.data?.state === 'failed' && <Alert type="error" showIcon message={status.data.error} />}
          {nodes.error ? (
            <Alert type="error" showIcon message="节点列表加载失败" description={String(nodes.error)} />
          ) : (
            <Table<DailyNodeRow>
              size="small"
              rowKey="signal_date"
              columns={columns}
              dataSource={rows}
              loading={nodes.isLoading}
              scroll={{ x: 1150 }}
              pagination={{ defaultPageSize: 20, showSizeChanger: true, pageSizeOptions: [20, 50, 100] }}
              rowClassName={(row) => (row.signal_date === active ? 'daily-row-active' : '')}
            />
          )}
        </Space>
      </Card>

      <div ref={detailRef}>
        <NodeDetailCard detail={detail.data} loading={detail.isLoading} error={detail.error} />
      </div>
    </Space>
  );
}

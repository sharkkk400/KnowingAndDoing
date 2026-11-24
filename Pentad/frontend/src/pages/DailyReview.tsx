import { Alert, Button, Card, Popconfirm, Progress, Space, Tabs, Typography } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import HistoryPanel from '../components/daily/HistoryPanel';
import NodePanel from '../components/daily/NodePanel';
import TodayPanel from '../components/daily/TodayPanel';
import { useDailyDays, useDailyStatus, useRebuildDaily } from '../hooks/useDailyPick';

type TabKey = 'today' | 'nodes' | 'history';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'today', label: '今日' },
  { key: 'nodes', label: '节点' },
  { key: 'history', label: '历史' },
];

export default function DailyReview() {
  const [tab, setTab] = useState<TabKey>('today');
  const days = useDailyDays();
  const status = useDailyStatus();
  const rebuild = useRebuildDaily();
  const queryClient = useQueryClient();
  const running = status.data?.state === 'running';

  useEffect(() => {
    if (status.data?.state !== 'done') return;
    queryClient.invalidateQueries({ queryKey: ['daily'] });
  }, [status.data?.state, queryClient]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small">
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space align="baseline" wrap>
            <Typography.Title level={4} style={{ margin: 0 }}>
              日度复盘
            </Typography.Title>
            <Typography.Text type="secondary">
              策略持仓每 5 个交易日调仓，节点之间持仓不变；「今日」看当下该拿什么，「节点」看每次买卖计划，「历史」看滚动收益
            </Typography.Text>
          </Space>
          <Space wrap>
            <Typography.Text type="secondary">共 {days.data?.length ?? 0} 个交易日已记录</Typography.Text>
            <Popconfirm
              title="重算全部日度记录？"
              description="覆盖 2015-01-05 至最新交易日，全量重算约 15 分钟；持仓读取「节点」tab 的换仓结果。"
              onConfirm={() => rebuild.mutate()}
              disabled={running}
            >
              <Button type="primary" loading={rebuild.isPending || running} disabled={running}>
                {running ? '重算中' : '重算全部'}
              </Button>
            </Popconfirm>
          </Space>
          {running && (
            <Progress
              status="active"
              percent={status.data?.total ? Math.floor(((status.data.done ?? 0) / status.data.total) * 100) : 0}
              format={() => `${status.data?.done ?? 0}/${status.data?.total ?? 0}`}
            />
          )}
          {running && <Typography.Text type="secondary">{status.data?.msg}</Typography.Text>}
          {status.data?.state === 'failed' && <Alert type="error" showIcon message={status.data.error} />}
        </Space>
      </Card>

      <Tabs
        activeKey={tab}
        onChange={(key) => setTab(key as TabKey)}
        items={TABS.map((item) => ({
          key: item.key,
          label: item.label,
          children:
            tab !== item.key ? null : item.key === 'today' ? (
              <TodayPanel />
            ) : item.key === 'nodes' ? (
              <NodePanel />
            ) : (
              <HistoryPanel />
            ),
        }))}
      />
    </Space>
  );
}

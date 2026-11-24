import { Alert, Card, Space, Typography } from 'antd';
import { useMemo } from 'react';
import AttributionPanel from './AttributionPanel';
import HistoryTable from './HistoryTable';
import SummaryCards from './SummaryCards';
import TimelineTable from './TimelineTable';
import { useDailyAttribution, useDailyDay, useDailyDays, useDailyTimeline } from '../../hooks/useDailyPick';

/** 滚动历史: 累计净值 + 逐日记录 + 每只 ETF 的持有区间。 */
export default function HistoryPanel() {
  const days = useDailyDays();
  const attribution = useDailyAttribution();
  const timeline = useDailyTimeline();
  const rows = useMemo(() => days.data ?? [], [days.data]);
  const latestSettled = useMemo(
    () => [...rows].reverse().find((d) => d.universe_mean != null || d.core_mean != null),
    [rows],
  );
  const detail = useDailyDay(latestSettled?.signal_date);

  if (days.error) {
    return <Alert type="error" showIcon message="日度记录加载失败" description={String(days.error)} />;
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {detail.data && (
        <Card
          size="small"
          title={`最近结算 · ${detail.data.signal_date}`}
          extra={<Typography.Text type="secondary">次日 {detail.data.next_signal ?? '未收盘'} 结算</Typography.Text>}
        >
          <SummaryCards day={detail.data} />
        </Card>
      )}
      <AttributionPanel data={attribution.data} />
      <TimelineTable spells={timeline.data ?? []} loading={timeline.isLoading} />
      <HistoryTable rows={rows} />
    </Space>
  );
}

import { Alert, Button, Card, Descriptions, Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { IndexCoverage } from '../../api/types';
import { useDatasetSummary, useIndices } from '../../hooks/useDataset';

const COLUMNS: ColumnsType<IndexCoverage> = [
  { title: '代码', dataIndex: 'code', width: 90 },
  { title: '指数', dataIndex: 'name', render: (v: string | null) => v ?? '-' },
  { title: '起始', dataIndex: 'first', width: 110, render: (v: string | null) => v ?? '-' },
  { title: '最新', dataIndex: 'last', width: 110, render: (v: string | null) => v ?? '-' },
  { title: '行数', dataIndex: 'rows', width: 90, render: (v: number) => v.toLocaleString() },
];

const num = (v: number) => v.toLocaleString();

export default function DatasetReadiness() {
  const summary = useDatasetSummary();
  const indices = useIndices();
  const data = summary.data;

  return (
    <Card
      size="small"
      title="回测数据就绪度"
      extra={
        <Button
          size="small"
          loading={summary.isFetching || indices.isFetching}
          onClick={() => {
            summary.refetch();
            indices.refetch();
          }}
        >
          刷新
        </Button>
      }
    >
      {summary.isError && <Alert type="error" showIcon message="就绪度读取失败" description={String(summary.error)} />}
      {data && (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Descriptions size="small" bordered column={3}>
            <Descriptions.Item label="交易日历">
              {data.calendar.days} 天（{data.calendar.first} ~ {data.calendar.last}）
            </Descriptions.Item>
            <Descriptions.Item label="日K">
              {num(data.daily.rows)} 行 / {data.daily.codes} 只
            </Descriptions.Item>
            <Descriptions.Item label="份额">
              {num(data.shares.rows)} 行 / {data.shares.codes} 只（{data.shares.first} 起）
            </Descriptions.Item>
            <Descriptions.Item label="指数">
              {data.index.codes}/{data.index.configured} 只 · {num(data.index.rows)} 行
            </Descriptions.Item>
            <Descriptions.Item label="份额跳变">
              {num(data.share_scale.jumps)} 笔（折算 {data.share_scale.split} / 申赎 {data.share_scale.flow} / 待甄别{' '}
              {num(data.share_scale.unverified)}）
            </Descriptions.Item>
            <Descriptions.Item label="上市日缺失">{data.list_date_missing}</Descriptions.Item>
          </Descriptions>

          <Alert
            type={data.gaps.codes > 0 ? 'warning' : 'success'}
            showIcon
            message={`区间缺口 ${data.gaps.codes} 只 / ${num(data.gaps.days)} 个交易日（含停牌，需逐只解释）`}
            description={
              data.gaps.top.length
                ? `缺口最大：${data.gaps.top.map((x) => `${x.code}(${x.missing})`).join('、')}`
                : undefined
            }
          />
          <Alert
            type={data.anomalies.jump_gt_30pct > 0 || data.anomalies.bad_close > 0 ? 'warning' : 'success'}
            showIcon
            message={`异常行（${data.anomalies.since} 起）：非正价格 ${num(data.anomalies.bad_close)} · 零成交量 ${num(data.anomalies.zero_volume)} · 单日±30% ${num(data.anomalies.jump_gt_30pct)}`}
            description={`全历史另有非正价格 ${num(data.anomalies.bad_close_all)} · 单日±30% ${num(data.anomalies.jump_gt_30pct_all)}，集中在 510050/510880 的 2015 前区段，是腾讯前复权因子失效的假价格；回测从份额起点开始即可规避`}
          />
          <Alert
            type={data.share_scale.unverified > 0 ? 'warning' : 'success'}
            showIcon
            message={`份额跳变甄别（≥${data.share_scale.threshold} 倍）：折算 ${data.share_scale.split} · 真实申赎 ${data.share_scale.flow} · 待甄别 ${num(data.share_scale.unverified)}（含上市首日无前史、无法判定的跳变）`}
            description={
              data.share_scale.recent_split.length
                ? `最近折算：${data.share_scale.recent_split.map((x) => `${x.code}（${x.date}，×${x.ratio}）`).join('、')}；折算在前复权价上不可见，只能靠未复权/前复权台阶识别，待甄别的跳变不参与资金因子`
                : '尚未记录折算事件，待甄别的跳变不参与资金因子'
            }
          />

          <Table
            size="small"
            rowKey="code"
            pagination={false}
            columns={COLUMNS}
            dataSource={indices.data ?? []}
            loading={indices.isLoading}
          />

          <Typography.Text type="secondary">
            时点口径：信号日只用当日收盘及以前的数据；标的池按上市日截断；已退市标的整体缺失（幸存者偏差），历史截面收益需标注该偏差。
          </Typography.Text>
        </Space>
      )}
    </Card>
  );
}

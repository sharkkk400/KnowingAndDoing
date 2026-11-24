import { useMemo, useState } from 'react';
import { Alert, Card, Col, Empty, Input, Row, Segmented, Space, Statistic, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useNavigate } from 'react-router-dom';
import type { EtfCoverage } from '../api/types';
import { useEtfs } from '../hooks/useEtfs';

type StatusFilter = 'all' | 'daily' | 'noDaily' | 'noShares';

const STATUS_OPTIONS = [
  { label: '全部', value: 'all' },
  { label: '有K线', value: 'daily' },
  { label: '缺K线', value: 'noDaily' },
  { label: '缺份额', value: 'noShares' },
];

function matchStatus(item: EtfCoverage, status: StatusFilter): boolean {
  if (status === 'daily') return item.daily_rows > 0;
  if (status === 'noDaily') return item.daily_rows === 0;
  if (status === 'noShares') return item.shares_rows === 0;
  return true;
}

const columns: ColumnsType<EtfCoverage> = [
  { title: '代码', dataIndex: 'code', width: 100, fixed: 'left' },
  {
    title: '名称',
    dataIndex: 'name',
    width: 200,
    ellipsis: true,
    render: (name: string) => <Typography.Text strong>{name}</Typography.Text>,
  },
  {
    title: '类型',
    dataIndex: 'fund_type',
    width: 130,
    render: (type: string | null) => (type ? <Tag>{type}</Tag> : <Tag color="default">未知</Tag>),
  },
  {
    title: 'K线区间',
    key: 'range',
    width: 200,
    sorter: (a, b) => (a.daily_last ?? '').localeCompare(b.daily_last ?? ''),
    render: (_, r) =>
      r.daily_first ? `${r.daily_first} ~ ${r.daily_last}` : <Typography.Text type="secondary">无数据</Typography.Text>,
  },
  {
    title: 'K线行数',
    dataIndex: 'daily_rows',
    width: 110,
    align: 'right',
    sorter: (a, b) => a.daily_rows - b.daily_rows,
    render: (n: number) => n.toLocaleString(),
  },
  {
    title: '份额截至',
    dataIndex: 'shares_last',
    width: 120,
    render: (d: string | null) => d ?? <Typography.Text type="secondary">无数据</Typography.Text>,
  },
  {
    title: '份额行数',
    dataIndex: 'shares_rows',
    width: 110,
    align: 'right',
    sorter: (a, b) => a.shares_rows - b.shares_rows,
    render: (n: number) => n.toLocaleString(),
  },
];

export default function EtfList() {
  const { data, isLoading, error } = useEtfs();
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  // 分页必须受控: 只给 pageSize 初始值会导致每次重渲染回落 50, 用户选 100 看起来"不生效"
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const navigate = useNavigate();

  const stats = useMemo(() => {
    const list = data ?? [];
    return {
      total: list.length,
      withDaily: list.filter((x) => x.daily_rows > 0).length,
      withShares: list.filter((x) => x.shares_rows > 0).length,
      dailyRows: list.reduce((sum, x) => sum + x.daily_rows, 0),
      sharesRows: list.reduce((sum, x) => sum + x.shares_rows, 0),
    };
  }, [data]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return (data ?? []).filter(
      (item) =>
        matchStatus(item, status) &&
        (!kw || item.code.includes(kw) || item.name.toLowerCase().includes(kw)),
    );
  }, [data, keyword, status]);

  if (error) {
    return <Alert type="error" showIcon message="清单加载失败" description={String(error)} />;
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={16}>
        <Col span={6}>
          <Card size="small">
            <Statistic title="在册标的" value={stats.total} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="已有K线" value={stats.withDaily} suffix={`/ ${stats.total}`} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="已有份额" value={stats.withShares} suffix={`/ ${stats.total}`} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="K线 / 份额 行数(万)"
              value={`${(stats.dailyRows / 10000).toFixed(1)} / ${(stats.sharesRows / 10000).toFixed(1)}`}
              valueStyle={{ fontSize: 16, whiteSpace: 'nowrap' }}
            />
          </Card>
        </Col>
      </Row>

      <Card size="small">
        <Space wrap>
          <Input.Search
            allowClear
            placeholder="搜索代码或名称"
            style={{ width: 280 }}
            onSearch={setKeyword}
            onChange={(e) => {
              setKeyword(e.target.value);
              setPage(1);
            }}
          />
          <Segmented
            options={STATUS_OPTIONS}
            value={status}
            onChange={(v) => {
              setStatus(v as StatusFilter);
              setPage(1);
            }}
          />
          <Typography.Text type="secondary">共 {filtered.length} 只</Typography.Text>
        </Space>
      </Card>

      <Table<EtfCoverage>
        size="small"
        rowKey="code"
        loading={isLoading}
        columns={columns}
        dataSource={filtered}
        pagination={{
          current: page,
          pageSize,
          showSizeChanger: true,
          pageSizeOptions: ['20', '50', '100', '200'],
          showTotal: (t) => `共 ${t} 只`,
          onChange: (nextPage, nextSize) => {
            setPage(nextSize === pageSize ? nextPage : 1);
            setPageSize(nextSize);
          },
        }}
        scroll={{ x: 1000 }}
        onRow={(record) => ({ onClick: () => navigate(`/etf/${record.code}`), style: { cursor: 'pointer' } })}
        locale={{ emptyText: <Empty description="无匹配标的" /> }}
      />
    </Space>
  );
}

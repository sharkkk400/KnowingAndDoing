import { useMemo } from 'react';
import { Alert, Button, Card, Col, Progress, Row, Space, Statistic, Tag, Typography } from 'antd';
import type { JobStatus } from '../api/types';
import BootstrapCard from '../components/data/BootstrapCard';
import DatasetReadiness from '../components/dataset/DatasetReadiness';
import { useEtfs } from '../hooks/useEtfs';
import { useJobs, useSchedulerStatus, useStartJob } from '../hooks/useJobs';

interface JobMeta {
  key: string;
  title: string;
  desc: string;
}

const JOBS: JobMeta[] = [
  {
    key: 'backfill_daily',
    title: '日K线',
    desc: '全部在册标的日K并发回填；被 2015 旧下限截断的老 ETF 自动向前补深至 2004，新标的取到上市首日即停，其余从最新日次日增量',
  },
  { key: 'backfill_shares', title: '份额', desc: '逐交易日回填全市场 ETF 份额，已覆盖日期跳过' },
  {
    key: 'detect_share_conversions',
    title: '份额折算甄别',
    desc: '比对未复权与前复权收盘台阶，把份额折算从真实申赎里分离并写入 etf_share_scale；已甄别的跳变跳过',
  },
  {
    key: 'backfill_index',
    title: '指数日线',
    desc: '中证官方全历史（含市盈率/成分数，腾讯/新浪只有最近 650~1023 根且不支持中证自编指数），按最新日次日增量',
  },
  { key: 'refresh_etf_list', title: 'ETF 清单', desc: '刷新全市场 ETF 清单快照，新标的自动并入待回填' },
  { key: 'refresh_calendar', title: '交易日历', desc: '刷新交易日历，作为回填进度的事实基准' },
];

const STATE_TAG: Record<string, { color: string; text: string }> = {
  running: { color: 'processing', text: '运行中' },
  done: { color: 'success', text: '已完成' },
  failed: { color: 'error', text: '失败' },
};

const SCHEDULER_TAG: Record<string, { color: string; text: string }> = {
  idle: { color: 'default', text: '待机' },
  running: { color: 'processing', text: '运行中' },
  done: { color: 'success', text: '已完成' },
  skipped: { color: 'warning', text: '已跳过' },
  failed: { color: 'error', text: '失败' },
};

const STAGE_TEXT: Record<string, string> = {
  starting: '准备中',
  calendar: '交易日历',
  daily: '日K',
  index: '指数日线',
  shares: '份额',
  core: '换仓节点',
  records: '日度记录',
};

function progressOf(status?: JobStatus): number {
  if (!status) return 0;
  if (status.state === 'done') return 100;
  if (status.state === 'failed' || !status.total) return 0;
  return Math.min(100, Math.floor(((status.done ?? 0) / status.total) * 100));
}

function resultText(status: JobStatus): string {
  if (!status.result) return '';
  return Object.entries(status.result)
    .map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toLocaleString() : String(v)}`)
    .join(' · ');
}

function JobCard({
  meta,
  status,
  onStart,
  starting,
}: {
  meta: JobMeta;
  status?: JobStatus;
  onStart: () => void;
  starting: boolean;
}) {
  const running = status?.state === 'running';
  const tag = status ? STATE_TAG[status.state] : undefined;

  return (
    <Card
      size="small"
      title={meta.title}
      extra={
        <Space>
          {tag && <Tag color={tag.color}>{tag.text}</Tag>}
          <Button size="small" type="primary" disabled={running || starting} loading={starting} onClick={onStart}>
            启动
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Typography.Text type="secondary">{meta.desc}</Typography.Text>
        <Progress
          percent={progressOf(status)}
          status={running ? 'active' : status?.state === 'failed' ? 'exception' : undefined}
        />
        {running && (
          <Typography.Text>
            {status.done ?? 0} / {status.total ?? 0} · {status.msg ?? '启动中'}
          </Typography.Text>
        )}
        {status?.state === 'done' && <Typography.Text type="success">{resultText(status)}</Typography.Text>}
        {status?.state === 'failed' && <Alert type="error" showIcon message={status.error ?? '任务失败'} />}
      </Space>
    </Card>
  );
}

function fiveYearsAgo(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 5);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function SchedulerCard() {
  const { data } = useSchedulerStatus();
  const tag = data ? SCHEDULER_TAG[data.state] : undefined;
  return (
    <Card size="small" title="收盘自动刷新" extra={tag && <Tag color={tag.color}>{tag.text}</Tag>}>
      <Space direction="vertical" size={4}>
        <Typography.Text type="secondary">
          交易日 18:30 补日K/指数/份额并重算节点与日度记录；22:30 再补一次，等中证指数当晚发布；次日 00:20 重拉最近 4 个交易日份额并再结算一次。
        </Typography.Text>
        {data?.stage && <Typography.Text>当前阶段：{STAGE_TEXT[data.stage] ?? data.stage}</Typography.Text>}
        {data?.signal_date && <Typography.Text>最新信号日：{data.signal_date}</Typography.Text>}
        {data?.finished_at && data.detail && (
          <Typography.Text type="secondary">
            上次结果 {data.finished_at} · {data.detail}
          </Typography.Text>
        )}
        {data?.next_run && <Typography.Text type="secondary">下次执行 {data.next_run}</Typography.Text>}
      </Space>
    </Card>
  );
}

export default function Jobs() {
  const jobs = useJobs();
  const start = useStartJob();
  const etfs = useEtfs(5000);

  const stats = useMemo(() => {
    const list = etfs.data ?? [];
    const cutoff = fiveYearsAgo();
    return {
      total: list.length,
      withDaily: list.filter((x) => x.daily_rows > 0).length,
      withShares: list.filter((x) => x.shares_rows > 0).length,
      dailyRows: list.reduce((sum, x) => sum + x.daily_rows, 0),
      fiveYears: list.filter((x) => x.daily_first != null && x.daily_first <= cutoff).length,
      noDaily: list.filter((x) => x.daily_rows === 0).length,
    };
  }, [etfs.data]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <BootstrapCard />
      <SchedulerCard />
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
            <Statistic title="K线总行数" value={stats.dailyRows.toLocaleString()} />
          </Card>
        </Col>
      </Row>

      {start.isError && <Alert type="error" showIcon message="任务启动失败" description={String(start.error)} />}

      <Typography.Text type="secondary">
        满 5 年历史 {stats.fiveYears} 只 · 上市不足 5 年 {stats.withDaily - stats.fiveYears} 只 · 无K线{' '}
        {stats.noDaily} 只（含尚未上市）
      </Typography.Text>

      <Row gutter={[16, 16]}>
        {JOBS.map((meta) => (
          <Col span={12} key={meta.key}>
            <JobCard
              meta={meta}
              status={jobs.data?.[meta.key]}
              starting={start.isPending && start.variables === meta.key}
              onStart={() => start.mutate(meta.key)}
            />
          </Col>
        ))}
      </Row>

      <Typography.Text type="secondary">
        状态每秒自动刷新
        {jobs.dataUpdatedAt ? `，上次更新 ${new Date(jobs.dataUpdatedAt).toLocaleTimeString()}` : ''}
      </Typography.Text>

      <DatasetReadiness />
    </Space>
  );
}

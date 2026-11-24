import { Space, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { SortOrder } from 'antd/es/table/interface';
import { Link } from 'react-router-dom';
import type { DailyScreenRow } from '../../api/types';
import { fmtNum, fmtSignedPct, returnColor } from '../common/format';
import { fmtContrib, fmtValue, fmtWeight, type FactorSpec } from './factorFormat';
import { codeColumn } from './linkColumns';

const STAGE_COLOR: Record<string, string> = {
  non_equity: 'default',
  hk: 'default',
  no_bar: 'warning',
  short_history: 'warning',
  bad_data: 'error',
  no_shares: 'warning',
  small_aum: 'orange',
  core_pool: 'cyan',
  core_hold: 'green',
};

// 数值列默认先看最强/最大: 未进入评分池的行(无因子)按 -∞ 排在降序末尾。
const DESC_FIRST: SortOrder[] = ['descend', 'ascend'];
// 名次列反过来: 1 名在前。
const ASC_FIRST: SortOrder[] = ['ascend', 'descend'];

type NumericKey = 'core8_score' | 'core8_rank' | 'r20' | 'flow_5d' | 'aum_yi';

function numOf(row: DailyScreenRow, key: NumericKey): number | null {
  const value = key === 'core8_score' || key === 'core8_rank' ? row[key] : row.reason?.[key];
  return typeof value === 'number' ? value : null;
}

/** 空值(未进评分池/无当日评分)始终排在末尾, 不因升降序跑到最前。 */
function compareNullable(x: number | null, y: number | null, order?: SortOrder): number {
  if (x == null && y == null) return 0;
  if (x == null) return order === 'ascend' ? 1 : -1;
  if (y == null) return order === 'ascend' ? -1 : 1;
  return x - y;
}

function sorter(key: NumericKey) {
  return (a: DailyScreenRow, b: DailyScreenRow, order?: SortOrder) =>
    compareNullable(numOf(a, key), numOf(b, key), order);
}

function Pct({ value, digits = 2 }: { value: number | null | undefined; digits?: number }) {
  return <span style={{ color: returnColor(value) }}>{fmtSignedPct(value, digits)}</span>;
}

function factorColumns(specs: FactorSpec[]): ColumnsType<DailyScreenRow> {
  return specs.map((spec) => ({
    title: spec.label,
    key: `factor-${spec.key}`,
    width: 104,
    align: 'right',
    render: (_, row) => {
      const factor = row.core_factors?.find((f) => f.key === spec.key);
      if (!factor) return <Typography.Text type="secondary">—</Typography.Text>;
      return (
        <div title={`权重 ${fmtWeight(spec.weight)} · 上=原始值, 下=加权贡献`}>
          <div>{fmtValue(factor)}</div>
          <div style={{ fontSize: 12, color: returnColor(factor.contrib) }}>{fmtContrib(factor.contrib)}</div>
        </div>
      );
    },
  }));
}

/** 行底色优先级: core8 持仓 > 基线前10。 */
export function rowBackground(row: DailyScreenRow, heldCodes?: ReadonlySet<string>): string | undefined {
  if (heldCodes?.has(row.code)) return '#f6ffed';
  if (row.rank != null && row.rank <= 10) return '#f0f7ff';
  return undefined;
}

export function buildScreenColumns(
  heldCodes?: ReadonlySet<string>,
  factorSpecs: FactorSpec[] = [],
  live = false,
): ColumnsType<DailyScreenRow> {
  return [
    {
      title: '策略排名',
      width: 100,
      sorter: sorter('core8_rank'),
      sortDirections: ASC_FIRST,
      render: (_, row) => (row.core8_rank == null ? '—' : row.core8_rank),
    },
    ...(live
      ? [
          {
            title: '现价',
            width: 84,
            align: 'right' as const,
            render: (_: unknown, row: DailyScreenRow) =>
              row.quote?.price != null ? row.quote.price.toFixed(3) : '—',
          },
          {
            title: '涨跌幅',
            width: 90,
            align: 'right' as const,
            render: (_: unknown, row: DailyScreenRow) => <Pct value={row.quote?.pct} />,
          },
        ]
      : []),
    codeColumn<DailyScreenRow>(),
    {
      title: '名称 / 筛选状态',
      dataIndex: 'name',
      width: 320,
      render: (_: string | null, row) => (
        <Space size={6} wrap>
          <Typography.Text strong>
            <Link to={`/etf/${row.code}`}>{row.name ?? row.code}</Link>
          </Typography.Text>
          <Tag style={{ marginInlineEnd: 0 }}>{row.theme ?? '其他'}</Tag>
          <Tag color={STAGE_COLOR[row.stage] ?? 'default'} style={{ marginInlineEnd: 0 }}>
            {row.stage_text}
          </Tag>
          {heldCodes?.has(row.code) && row.stage !== 'core_hold' && (
            <Tag color="green" style={{ marginInlineEnd: 0 }}>
              策略持有
            </Tag>
          )}
          {row.rank != null && row.rank <= 10 && (
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>
              基线前10
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: '策略分',
      width: 92,
      sorter: sorter('core8_score'),
      sortDirections: DESC_FIRST,
      defaultSortOrder: 'descend',
      render: (_, row) => <Typography.Text strong>{fmtNum(row.core8_score)}</Typography.Text>,
    },
    ...factorColumns(factorSpecs),
    {
      title: '20日',
      width: 84,
      sorter: sorter('r20'),
      sortDirections: DESC_FIRST,
      render: (_, row) => <Pct value={row.reason?.r20} />,
    },
    {
      title: '5日份额',
      width: 96,
      sorter: sorter('flow_5d'),
      sortDirections: DESC_FIRST,
      render: (_, row) => <Pct value={row.reason?.flow_5d} />,
    },
    {
      title: '规模(亿)',
      width: 92,
      sorter: sorter('aum_yi'),
      sortDirections: DESC_FIRST,
      render: (_, row) => fmtNum(row.reason?.aum_yi, 1),
    },
  ];
}

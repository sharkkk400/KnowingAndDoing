import { Input, Select, Space, Table, Typography } from 'antd';
import { useMemo, useState } from 'react';
import type { CoreFactor, DailyScreenRow } from '../../api/types';
import { factorFormula } from './factorFormat';
import ExpandedKline from './ExpandedKline';
import ScreenRowDetail from './ScreenRowDetail';
import { buildScreenColumns, rowBackground } from './screenColumns';
import type { FactorSpec } from './factorFormat';

/** 状态筛选按漏斗深度排序: 缓冲带持仓 → 评分池 → 各级剔除。 */
const STAGE_ORDER = [
  'core_hold',
  'core_pool',
  'small_aum',
  'no_shares',
  'no_bar',
  'short_history',
  'bad_data',
  'hk',
  'non_equity',
];

interface Props {
  rows: DailyScreenRow[];
  loading?: boolean;
  /** core8 缓冲带当前持仓: 行底色 + 名称列标签。 */
  heldCodes?: ReadonlySet<string>;
  /** 这批排名的信号日: 展开后的因子拆解按该日截面计算。 */
  signalDate?: string | null;
  /** 盘中实时排名: 追加现价/涨跌幅列（数据内嵌在行 quote 字段）。 */
  live?: boolean;
}

export default function ScreenRanking({ rows, loading, heldCodes, signalDate, live }: Props) {
  const [keyword, setKeyword] = useState('');
  const [stage, setStage] = useState<string>();
  const [expanded, setExpanded] = useState<string[]>([]);

  const toggle = (code: string) =>
    setExpanded((keys) => (keys.includes(code) ? keys.filter((k) => k !== code) : [...keys, code]));

  // 因子列与公式都取自记录自带的元数据: 后端改权重/改名, 这里自动跟着变。
  // 高位高波扣分不是截面加权项, 只出现在命中标的的拆解里, 不单独占列。
  const template = useMemo<CoreFactor[] | null>(() => {
    for (const row of rows) {
      const factors = row.core_factors?.filter((f) => f.key !== 'high_vol_penalty');
      if (factors?.length) return factors;
    }
    return null;
  }, [rows]);
  const factorSpecs = useMemo<FactorSpec[]>(
    () => (template ?? []).map(({ key, label, weight }) => ({ key, label, weight })),
    [template],
  );

  const columns = useMemo(() => buildScreenColumns(heldCodes, factorSpecs, live), [heldCodes, factorSpecs, live]);

  const stageOptions = useMemo(() => {
    const map = new Map<string, { text: string; count: number }>();
    for (const row of rows) {
      const cur = map.get(row.stage);
      map.set(row.stage, { text: row.stage_text, count: (cur?.count ?? 0) + 1 });
    }
    return STAGE_ORDER.flatMap((key) => {
      const entry = map.get(key);
      return entry ? [{ value: key, label: `${entry.text}（${entry.count}）` }] : [];
    });
  }, [rows]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return rows.filter((row) => {
      if (stage && row.stage !== stage) return false;
      if (!kw) return true;
      return (
        row.code.includes(kw) ||
        (row.name ?? '').toLowerCase().includes(kw) ||
        (row.theme ?? '').toLowerCase().includes(kw)
      );
    });
  }, [rows, keyword, stage]);

  const scoredCount = rows.filter((row) => row.rank != null).length;
  const baselineCount = rows.filter((row) => row.rank != null && row.rank <= 10).length;
  const heldCount = rows.filter((row) => heldCodes?.has(row.code)).length;

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space wrap>
        <Input
          allowClear
          placeholder="搜索代码 / 名称 / 主题"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          style={{ width: 240 }}
        />
        <Select
          allowClear
          placeholder="按筛选状态过滤"
          value={stage}
          onChange={setStage}
          options={stageOptions}
          style={{ width: 260 }}
        />
        <Typography.Text type="secondary">
          全部 {rows.length} 只 · 评分池 {scoredCount} · 策略持仓 {heldCount} · 基线前10 {baselineCount}
        </Typography.Text>
      </Space>
      {template && (
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          <Typography.Text strong>策略分 = </Typography.Text>
          <Typography.Text code>{factorFormula(template)}</Typography.Text>
        </Typography.Paragraph>
      )}
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        分位 = 当日评分池内截面排名映射到 −1 ~ +1（缺失记 0），权重固定。默认按策略分降序；表格里每个因子显示
        「原始值 / 加权贡献」，点行或行首箭头可展开完整拆解与门槛数据。综合分只用于生成「基线前10」对照，不参与策略选股。
      </Typography.Text>
      <Table<DailyScreenRow>
        size="small"
        rowKey="code"
        columns={columns}
        dataSource={filtered}
        loading={loading}
        scroll={{ x: 1700 }}
        pagination={{
          defaultPageSize: 50,
          showSizeChanger: true,
          pageSizeOptions: [20, 50, 100, 200],
          showTotal: (total) => `共 ${total} 只`,
        }}
        expandable={{
          expandedRowKeys: expanded,
          onExpandedRowsChange: (keys) => setExpanded(keys.map(String)),
          expandedRowRender: (row) => (
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {live && <ExpandedKline code={row.code} />}
              <ScreenRowDetail row={row} signalDate={signalDate} />
            </Space>
          ),
        }}
        onRow={(row) => ({
          onClick: () => toggle(row.code),
          style: {
            background: rowBackground(row, heldCodes),
            cursor: 'pointer',
          },
        })}
      />
    </Space>
  );
}

import { Space, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { CoreFactor } from '../../api/types';
import { returnColor } from '../common/format';
import { factorFormula, fmtContrib, fmtValue, fmtWeight } from './factorFormat';

const columns: ColumnsType<CoreFactor> = [
  { title: '因子', dataIndex: 'label', width: 128 },
  { title: '原始值', width: 96, align: 'right', render: (_, f) => fmtValue(f) },
  {
    title: '截面分位',
    width: 96,
    align: 'right',
    render: (_, f) => (
      <span title="当日全市场截面排名映射到 -1 ~ +1; 缺失记 0(中性), 扣分行无分位">{fmtContrib(f.z)}</span>
    ),
  },
  { title: '权重', width: 76, align: 'right', render: (_, f) => fmtWeight(f.weight) },
  {
    title: '贡献',
    width: 92,
    align: 'right',
    render: (_, f) => <span style={{ color: returnColor(f.contrib) }}>{fmtContrib(f.contrib)}</span>,
  },
];

interface Props {
  factors?: CoreFactor[] | null;
  /** 策略分本身(贡献之和, 保留 6 位小数)。 */
  total?: number | null;
  /** 截面日期: 节点持仓的因子是换仓日截面, 不是当天。 */
  date?: string | null;
  /** 评分池只数, 说明分位是在多大截面上算的。 */
  scored?: number | null;
}

/** 策略分构成: 8 因子原始值 → 截面分位 → 权重 → 贡献, 命中高位高波时另附扣分行。 */
export default function FactorBreakdown({ factors, total, date, scored }: Props) {
  if (!factors || factors.length === 0) {
    return <Typography.Text type="secondary">该记录没有因子拆解(旧节点需重新回填)。</Typography.Text>;
  }
  const sum = factors.reduce((acc, f) => acc + f.contrib, 0);
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        策略分 = {factorFormula(factors)}
        {date ? ` · ${date} 截面` : ''}
        {scored ? ` · 评分池 ${scored} 只` : ''}
      </Typography.Text>
      <Table<CoreFactor>
        size="small"
        rowKey="key"
        columns={columns}
        dataSource={factors}
        pagination={false}
        summary={() => (
          <Table.Summary.Row>
            <Table.Summary.Cell index={0}>
              <Typography.Text strong>合计</Typography.Text>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={1} />
            <Table.Summary.Cell index={2} />
            <Table.Summary.Cell index={3} />
            <Table.Summary.Cell index={4} align="right">
              <Typography.Text strong>{fmtContrib(total ?? sum)}</Typography.Text>
            </Table.Summary.Cell>
          </Table.Summary.Row>
        )}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        分位为当日全市场截面百分位(-1 最弱 / +1 最强), 缺失值记 0 不参与排序; 权重固定, 不随年份调整。
        波动≥45% 且收盘距 250 日高点 3% 以内的名字另扣 0.10, 只减不加。
      </Typography.Text>
    </Space>
  );
}

import { Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { RealtimeQuote } from '../../api/types';
import { fmtSignedPct, returnColor } from '../common/format';

/** 现价/涨跌幅两列: 数据来自 15 秒轮询的行情接口; 未就绪的行显示 —。 */
export function quoteColumns<T extends { code: string }>(
  quotes: Record<string, RealtimeQuote> | undefined,
): ColumnsType<T> {
  return [
    {
      title: '现价',
      width: 84,
      align: 'right',
      render: (_, row) =>
        quotes?.[row.code]?.price != null ? (
          <Typography.Text>{quotes[row.code].price!.toFixed(3)}</Typography.Text>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: '涨跌幅',
      width: 90,
      align: 'right',
      render: (_, row) => {
        const pct = quotes?.[row.code]?.pct;
        return <span style={{ color: returnColor(pct) }}>{fmtSignedPct(pct, 2)}</span>;
      },
    },
  ];
}

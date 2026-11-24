import { Alert, Descriptions, Space, Tag, Typography } from 'antd';
import type { ReactNode } from 'react';
import type { DailyScreenReason, DailyScreenRow, KlinePeriod } from '../../api/types';
import { fmtNum, fmtSignedPct } from '../common/format';
import FactorBreakdown from './FactorBreakdown';

const SIGNAL_TEXT: Record<string, string> = {
  rs_strong: '相对强势',
  rs_weak: '相对弱势',
  theme_leader: '主题领涨',
  near_high_52w: '贴近52周高',
  ma_bull: '多头排列',
  ma_bear: '空头排列',
  flow_suspect: '份额待甄别',
  share_split_5d: '含份额折算',
};

const FLAG_TEXT: Record<string, string> = {
  core8_hold: '策略持有',
  shrink_pullback: '缩量回撤',
};

const STAGE_HINT: Record<string, string> = {
  non_equity: '基金类型不是「指数型-股票」（QDII/债券/货币等），不参与 A 股 ETF 日度筛选。',
  hk: '名称含港股/恒生/沪港深等，底层不是 A 股，已整体排除。',
  no_bar: '信号日没有收盘 K 线：停牌、尚未上市或当日未回填。',
  short_history: '有效历史不足 62 根日 K，无法计算 60 日动量与波动。',
  bad_data: '数据异常（零价/零量/关键字段缺失），特征不可用。',
  no_shares: '库内没有 ≤ 信号日的份额，无法估算规模。',
  small_aum: '规模低于 2 亿门槛，未进入评分池；下列指标仅作强弱参考。',
};

const MACD_PERIODS: { key: KlinePeriod; label: string }[] = [
  { key: 'day', label: '日' },
  { key: 'week', label: '周' },
  { key: 'month', label: '月' },
];
const ZONE_TEXT: Record<string, string> = { above: '水上', below: '水下', zero: '零轴' };
const TREND_TEXT: Record<string, string> = { rising: '走强', falling: '走弱', flat: '走平' };
const FLIP_TEXT: Record<string, string> = { golden: '金叉', dead: '死叉' };
const ZONE_COLOR: Record<string, string> = { above: 'red', below: 'green', zero: 'default' };

function items(entries: [string, string][], heading: string): ReactNode {
  return (
    <Descriptions size="small" column={{ xs: 2, md: 3 }} bordered title={heading}>
      {entries.map(([label, value]) => (
        <Descriptions.Item key={label} label={label}>
          {value}
        </Descriptions.Item>
      ))}
    </Descriptions>
  );
}

/** 策略分之外的口径说明数据: 均额/份额/规模是筛选门槛输入, 综合分仅作基线对照。 */
function supporting(r: DailyScreenReason): ReactNode {
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      {items(
        [
          ['5日均额(亿)', fmtNum(r.amount_yi_5d)],
          ['20日均额(亿)', fmtNum(r.amount_yi_20d)],
          ['5日份额(归一)', fmtSignedPct(r.flow_5d)],
          ['5日折算次数', fmtNum(r.share_split_5d, 0)],
          ['份额(亿)', fmtNum(r.shares_yi, 1)],
          ['规模(亿)', fmtNum(r.aum_yi, 1)],
          ['20日收益', fmtSignedPct(r.r20)],
        ],
        '门槛与量能',
      )}
      {items([['综合分', fmtNum(r.baseline_score)]], '基线对照（不参与策略选股）')}
    </Space>
  );
}

export default function ScreenRowDetail({ row, signalDate }: { row: DailyScreenRow; signalDate?: string | null }) {
  const r = row.reason;
  const hint = STAGE_HINT[row.stage];
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      {hint && <Alert type="info" showIcon message={hint} />}
      {row.reason_text && (
        <Typography.Text style={{ display: 'block', whiteSpace: 'normal' }}>{row.reason_text}</Typography.Text>
      )}
      {r && (
        <Space size={6} wrap>
          {(r.signals ?? []).map((signal) => (
            <Tag color="blue" key={signal}>
              {SIGNAL_TEXT[signal] ?? signal}
            </Tag>
          ))}
          {(r.flags ?? []).map((flag) => (
            <Tag color="geekblue" key={flag}>
              {FLAG_TEXT[flag] ?? flag}
            </Tag>
          ))}
          {MACD_PERIODS.map(({ key, label }) => {
            const state = r.macd_states?.[key];
            if (!state) return null;
            return (
              <Tag key={key} color={ZONE_COLOR[state.zone]} title={`判定截至 ${state.date}`}>
                {label}线 {ZONE_TEXT[state.zone]}
                {state.flip ? FLIP_TEXT[state.flip] : TREND_TEXT[state.trend]}
              </Tag>
            );
          })}
        </Space>
      )}
      {row.core_factors ? (
        <FactorBreakdown factors={row.core_factors} total={row.core8_score} date={signalDate} />
      ) : row.core8_rank != null ? (
        <Alert type="info" showIcon message="该行来自旧版快照，重算节点/日度记录后可展开策略分构成。" />
      ) : null}
      {r ? (
        supporting(r)
      ) : (
        <Descriptions size="small" column={3} bordered>
          <Descriptions.Item label="最后K线">{row.last_bar ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="K线根数">{row.bars}</Descriptions.Item>
          <Descriptions.Item label="筛选状态">{row.stage_text}</Descriptions.Item>
        </Descriptions>
      )}
    </Space>
  );
}

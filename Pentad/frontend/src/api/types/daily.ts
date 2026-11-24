import type { KlinePeriod, MacdState } from './etf';

/** 策略分单个因子: 原始值 → 当日全市场截面分位([-1,1]) → 权重 → 贡献。 */
export interface CoreFactor {
  key: string;
  label: string;
  /** pct=百分比 / num=纯数值 / days=天数 */
  kind: 'pct' | 'num' | 'days';
  value: number | null;
  /** 惩罚行没有截面分位与权重(不是加权项), 命中才出现。 */
  z: number | null;
  weight: number | null;
  contrib: number;
}

export interface PickReason {
  flags: string[];
  signals: string[];
  r5: number | null;
  r20: number | null;
  r60: number | null;
  r120: number | null;
  r250: number | null;
  vol20: number | null;
  vol60: number | null;
  dd60: number | null;
  dd20: number | null;
  mdd60: number | null;
  dist_52w_high: number | null;
  dist_52w_low: number | null;
  vol_ratio_5_20: number | null;
  amount_yi_5d: number | null;
  amount_yi_20d: number | null;
  turnover_5d: number | null;
  turnover_20d: number | null;
  shrink_pullback: boolean;
  ma20_dev: number | null;
  ma60_dev: number | null;
  ma120_dev: number | null;
  ma20_slope_5: number | null;
  ma60_slope_20: number | null;
  up_ratio_20: number | null;
  up_ratio_60: number | null;
  downside_vol20: number | null;
  sharpe_20: number | null;
  sharpe_60: number | null;
  /** core8 持仓会带: 节点上的 core8 截面名次与分数。 */
  core8_rank?: number | null;
  core8_score?: number | null;
  /** 策略分 8 因子拆解; 仅日度策略记录带。 */
  core_factors?: CoreFactor[] | null;
  rank_r5: number | null;
  rank_r20: number | null;
  rank_r60: number | null;
  rank_r250: number | null;
  rank_vol20: number | null;
  rank_flow_5d: number | null;
  rank_dist_52w_high: number | null;
  excess_r5: number | null;
  excess_r20: number | null;
  excess_r60: number | null;
  beta60: number | null;
  corr60: number | null;
  alpha60: number | null;
  theme_count: number | null;
  theme_median_r20: number | null;
  theme_rank_r20: number | null;
  theme_excess_r20: number | null;
  shares_yi: number | null;
  shares_raw: number | null;
  flow_5d: number | null;
  flow_5d_raw: number | null;
  flow_suspect: boolean;
  share_split_5d: number;
  aum_yi: number | null;
  core_score: number | null;
  trend_score: number | null;
  macd_states: Record<KlinePeriod, MacdState | null> | null;
  baseline_score: number;
}

export interface DailyPick {
  signal_date: string;
  /** core=信号日有效的 core8 持仓 / baseline=综合分前10。 */
  bucket: 'baseline' | 'core';
  pick_rank: number;
  code: string;
  name: string | null;
  theme: string | null;
  fund_type: string | null;
  baseline_score: number;
  reason_text: string;
  reason: PickReason;
  next_return: number | null;
}

export interface EvalBlock {
  n?: number;
  mean?: number;
  median?: number;
  hit_rate?: number;
}

export interface PickEvaluation {
  skipped?: string;
  warning?: string;
  next_signal?: string;
  universe?: EvalBlock;
  baseline_top10?: EvalBlock;
  core_holdings?: EvalBlock;
  rank_ic_baseline?: number;
}

/** 日度复盘: core8 缓冲带持仓逐日跟踪(节点间延续), 次日收盘结算; 基线前10 作对照锚。 */
export interface DailyRow {
  signal_date: string;
  next_signal: string | null;
  scored: number | null;
  universe_mean: number | null;
  universe_hit: number | null;
  baseline_mean: number | null;
  baseline_hit: number | null;
  core_mean: number | null;
  core_hit: number | null;
  rank_ic: number | null;
}

export interface DailyDetail {
  signal_date: string;
  next_signal: string | null;
  generated_at: string;
  rule_version: string;
  codes_with_bar: number;
  codes_with_enough_history: number;
  scored: number;
  min_aum_yi: number;
  shares_available: number;
  universe_mean: number | null;
  universe_median: number | null;
  universe_hit: number | null;
  baseline_mean: number | null;
  baseline_hit: number | null;
  core_mean: number | null;
  core_hit: number | null;
  rank_ic: number | null;
  evaluation: PickEvaluation;
  index_returns: Record<string, number>;
  picks: { core: DailyPick[]; baseline: DailyPick[] };
}

export interface DailyCumulative {
  signal_date: string;
  next_signal: string | null;
  core: number | null;
  baseline: number | null;
  universe: number | null;
  hs300: number | null;
  /** 年线开关: 信号日沪深300 收盘 > MA250 为 above, 未热身为 null(按空仓)。 */
  gate: 'above' | 'below' | null;
  /** 仅年线上承受当日 core8 收益后的累计净值(空仓段沿用最后净值画平线)。 */
  gated: number | null;
}

export interface DailyOverallBlock {
  mean: number | null;
  cumulative: number | null;
  positive: number | null;
}

export interface DailyOverall {
  days: number;
  core: DailyOverallBlock;
  baseline: DailyOverallBlock;
  universe: DailyOverallBlock;
  hs300: DailyOverallBlock;
  rank_ic_mean: number | null;
  rank_ic_positive_days: number | null;
  /** core8 持仓相邻交易日平均换手(1 - 交集/较大桶长), 只在换仓节点跳升。 */
  turnover_avg: number | null;
  /** 年线开关: 窗口内站上/跌破 MA250 的交易日数(未热身不计入)。 */
  gate_on_days: number | null;
  gate_off_days: number | null;
  /** 仅年线上承受当日 core8 收益的复利累计。 */
  gated_cumulative: number | null;
}

export interface DailyAttribution {
  days: DailyRow[];
  cumulative: DailyCumulative[];
  overall: DailyOverall;
}

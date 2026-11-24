import type { CoreFactor, PickReason } from './daily';

/** 漏斗一级: count 为该级剩余标的数, 相邻两级之差即被剔除数。 */
export interface DailyScreenStage {
  key: string;
  label: string;
  criteria: string;
  count: number;
}

/** 评分明细: 未进入评分池的行没有分数与截面字段。 */
export type DailyScreenReason = Omit<PickReason, 'baseline_score' | 'trend_score' | 'core_score'> & {
  baseline_score?: number | null;
  trend_score?: number | null;
  core_score?: number | null;
};

/** 行内携带的实时行情快照(现价/涨跌幅/行情时间)。 */
export interface LiveQuote {
  price: number | null;
  pct: number | null;
  time: string | null;
}

export interface DailyScreenRow {
  code: string;
  name: string | null;
  fund_type: string | null;
  theme: string | null;
  /** 该标的最深到达的一级: non_equity/hk/no_bar/short_history/bad_data/no_shares/small_aum/core_pool/core_hold */
  stage: string;
  stage_text: string;
  last_bar: string | null;
  bars: number;
  /** 综合分排名(仅在评分池内), null 表示未到评分级。 */
  rank: number | null;
  /** core8 固定符号公式的截面名次与分数(与「多因子分」不是同一个公式)。 */
  core8_rank: number | null;
  core8_score: number | null;
  /** 所属换仓节点日收盘价: 「节点涨跌」的统一基准(信号日当天即节点日时等于当日收盘)。 */
  node_close?: number | null;
  /** 策略分 8 因子拆解(仅在评分池内)。 */
  core_factors: CoreFactor[] | null;
  reason: DailyScreenReason | null;
  reason_text: string | null;
  /** 实时行情(仅实时排名): 时间戳非当日则为 null, 避免把昨日收盘当现价。 */
  quote?: LiveQuote | null;
}

export interface DailyScreen {
  signal_date: string;
  available: boolean;
  reason: string | null;
  min_aum_yi: number;
  funnel: DailyScreenStage[];
  baseline_note: string;
  core_codes: string[];
  baseline_codes: string[];
  scored: number;
  rows: DailyScreenRow[];
}

/** core8 缓冲带: 一个换仓节点上的持仓/卖出/评分榜。 */
export interface DailyCorePick {
  code: string;
  name: string | null;
  core_rank: number;
  core_score: number;
  held: boolean;
  /** hold=继续持有 / buy=本次买入 / sell=本次卖出 / rank=前20但未持有 */
  action: 'hold' | 'buy' | 'sell' | 'rank';
  /** 换仓节点日收盘价: 持仓期涨跌幅基准。 */
  node_close?: number | null;
  /** 换仓当日的 8 因子拆解; 旧节点重算前为 null。 */
  factors: CoreFactor[] | null;
}

export interface DailyCoreNode {
  signal_date: string;
  /** 下一次换仓日; null 表示已到日历尾部。 */
  next_rebalance: string | null;
  generated_at: string | null;
  rule_version: string;
  scored: number;
  min_aum_yi: number;
  /** 请求的那一天: 间隔期内节点会早于它, 持仓按上一节点延续。 */
  requested_date: string;
  holdings: DailyCorePick[];
  sells: DailyCorePick[];
  ranked: DailyCorePick[];
  counts: { hold: number; buy: number; sell: number };
  held_codes: string[];
}

/** 换仓节点列表行: 一次换仓的持仓、动作计数与持有到下一节点的等权收益。 */
export interface DailyNodeRow {
  signal_date: string;
  next_rebalance: string | null;
  generated_at: string | null;
  rule_version: string;
  scored: number;
  holdings: { code: string; name: string | null; core_rank: number }[];
  counts: { hold: number; buy: number; sell: number };
  /** 信号日收盘 → 下一节点收盘的等权收益; 尚未结算为 null。 */
  return: number | null;
  /** 同一节点评分前 10 名等权、收盘→收盘的区间收益, 不含成本; 缺价或未结算为 null。 */
  top10_return: number | null;
  /** 沪深300 同区间的指数涨跌; 指数尚未发布或未结算为 null。 */
  hs300_return: number | null;
}

/** 节点明细里的标的: 只多了成交价与区间收益, 其余字段与节点持仓同源。 */
export interface DailyNodePick extends DailyCorePick {
  theme: string | null;
  /** 节点日收盘价(信号日收盘, 所有标的都有)。 */
  price: number | null;
  /** 实际入场价: 买入按次日开盘, 继续持有按节点收盘; 非持仓为 null。 */
  entry_price: number | null;
  /** 持仓的出场价: 下一节点收盘。 */
  next_price: number | null;
  /** 卖出时点: close=周四收盘卖, open=周五开盘顺延卖; 非卖出席位为 null。 */
  sell_at: 'close' | 'open' | null;
  return: number | null;
}

export interface DailyNodeDetail {
  signal_date: string;
  next_rebalance: string | null;
  generated_at: string | null;
  rule_version: string;
  scored: number;
  min_aum_yi: number;
  holdings: DailyNodePick[];
  sells: DailyNodePick[];
  ranked: DailyNodePick[];
  counts: { hold: number; buy: number; sell: number };
  return: number | null;
}

/** 持仓区间: 连续持有的节点合并为一段, exit 为首次缺席的节点日。 */
export interface DailyHoldingSpell {
  code: string;
  name: string | null;
  theme: string | null;
  entry: string;
  exit: string | null;
  nodes: number;
  entry_rank: number;
  last_rank: number;
  holding: boolean;
  return: number | null;
  entry_price: number | null;
  exit_price: number | null;
}

import type { DailyPick } from './daily';
import type { DailyScreenRow } from './dailyScreen';

/** 当前持仓行: 来自上一换仓节点的持仓名单, 不含因子拆解(细节在底部全量表)。 */
export interface LiveHeldPick {
  code: string;
  name: string | null;
  core_rank: number;
  core_score: number;
  /** hold=节点继续持有 / buy=节点新买入(卖出名单在下一节点的 action=sell)。 */
  action: 'hold' | 'buy';
  /** 换仓节点日收盘价: 持仓期涨跌幅基准。 */
  node_close?: number | null;
  /** 今日实时排名; null=未进候选池(如规模/类型被筛掉), 等价于跌出缓冲带。 */
  today_rank?: number | null;
}

/** 今日实时 TOP N 行: 只用于对照卡片, 不含因子拆解(细节在底部全量表)。 */
export interface TodayTopPick {
  rank: number;
  code: string;
  name: string | null;
  score: number;
  /** 换仓节点日收盘价: 与持仓共用同一基准, 看本轮周期内 TOP 名的涨跌。 */
  node_close?: number | null;
}

/** 今日盘中预选: 实时现价合成今日K线算出, 不落库; live=false 时只有原因。 */
export interface DailyLive {
  live: boolean;
  reason?: string;
  signal_date: string;
  rule_version?: string;
  generated_at?: string;
  codes_with_bar?: number;
  codes_with_enough_history?: number;
  scored?: number;
  min_aum_yi?: number;
  shares_available?: number;
  /** 行情时间戳(YYYY-MM-DD HH:MM:SS), 说明预选基于哪个时点的价格。 */
  as_of?: string | null;
  is_trading?: boolean;
  last_day?: string;
  /** 今日是否换仓; 非换仓日目标=沿用上一节点持仓(策略忠实语义, 不虚拟调仓)。 */
  rebalance?: boolean;
  next_rebalance?: string | null;
  last_node?: string | null;
  picks?: { core: DailyPick[]; baseline_codes: string[] };
  /** 今日实时排名前 N(默认 10): 左卡「今日 TOP」对照, 与节点持仓并排看。 */
  today_top?: TodayTopPick[];
  /** 买入区边界(前 N 名)与缓冲带边界(已持有排名 ≤ N 继续持有)。 */
  hold_top?: number;
  buffer_rank?: number;
  /** 上一节点持仓(当前持仓卡的右卡数据源); 收盘后由正式节点快照补位。 */
  held?: LiveHeldPick[];
  /** 服务端响应时的 unix 秒, 前端与 as_of 一起算行情新鲜度。 */
  server_now?: number;
  /** 实测耗时(秒): 全量行情冷拉 + 评分重算, 「手动全量拉取」按钮的结果展示。 */
  timing?: { quotes_sec: number; scoring_sec: number };
}

/** 今日全量实时排名: 与收盘筛选同构(行形状同 DailyScreenRow), 交易时段 10 分钟一批。 */
export interface DailyLiveRanking {
  live: boolean;
  reason?: string;
  signal_date: string;
  as_of?: string | null;
  scored?: number;
  server_now?: number;
  rows: DailyScreenRow[];
}

/** 手动全量拉取的结果: picks 是重建后的轻量预演, timing 在 picks 里。 */
export interface DailyLiveRefresh {
  refreshed_at: string;
  picks: DailyLive;
  ranking_rows: number;
}

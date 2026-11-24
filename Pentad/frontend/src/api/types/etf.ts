export interface EtfCoverage {
  code: string;
  name: string;
  fund_type: string | null;
  daily_first: string | null;
  daily_last: string | null;
  daily_rows: number;
  shares_last: string | null;
  shares_rows: number;
}

export interface DailyBar {
  date: string;
  open: number | null;
  close: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
}

export interface SharesPoint {
  date: string;
  shares_yi: number;
}

export interface SharesResponse {
  code: string;
  rows: SharesPoint[];
}

/** 腾讯实时行情: 二级市场现价, 不是 IOPV 参考净值。pct 为小数(0.0123 = +1.23%)。 */
export interface RealtimeQuote {
  name: string | null;
  price: number | null;
  prev_close: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  change: number | null;
  pct: number | null;
  volume: number | null;
  amount_wan: number | null;
  time: string | null;
}

export interface RealtimeQuotesResponse {
  as_of: string;
  is_trading: boolean;
  quotes: Record<string, RealtimeQuote>;
}

export type KlinePeriod = 'day' | 'week' | 'month';

export interface KlineBar extends DailyBar {
  dif: number | null;
  dea: number | null;
  hist: number | null;
}

export type MacdTrend = 'rising' | 'falling' | 'flat';
export type MacdFlip = 'golden' | 'dead';
export type MacdZone = 'above' | 'below' | 'zero';

export interface MacdState {
  period: KlinePeriod;
  date: string;
  dif: number;
  dea: number;
  hist: number;
  hist_prev: number;
  trend: MacdTrend;
  flip: MacdFlip | null;
  zone: MacdZone;
}

export interface KlineResponse {
  code: string;
  period: KlinePeriod;
  bars: KlineBar[];
  state: MacdState | null;
}

export interface MacdStatesResponse {
  code: string;
  states: Record<KlinePeriod, MacdState | null>;
}

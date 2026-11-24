import type { DailyCumulative } from '../../api/types';

export type DailySeriesKey = 'core' | 'baseline' | 'universe' | 'hs300' | 'gated';

export const DAILY_SERIES_KEYS: DailySeriesKey[] = ['core', 'baseline', 'universe', 'hs300', 'gated'];

export interface DailyWindow {
  points: DailyCumulative[];
  /** 由全历史累计值反推的当日收益, 与累计视图共用同一窗口切片。 */
  daily: Record<DailySeriesKey, Array<number | null>>;
}

export interface DailyWindowSummary {
  days: number;
  coreCumulative: number | null;
  baselineCumulative: number | null;
  universeCumulative: number | null;
  corePositive: number | null;
  rankIcMean: number | null;
}

function emptyDaily(): Record<DailySeriesKey, Array<number | null>> {
  return { core: [], baseline: [], universe: [], hs300: [], gated: [] };
}

function compound(values: number[]): number | null {
  return values.length ? values.reduce((acc, v) => acc * (1 + v), 1) - 1 : null;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((acc, v) => acc + v, 0) / values.length : null;
}

function dailyReturns(points: DailyCumulative[]): Record<DailySeriesKey, Array<number | null>> {
  const daily = emptyDaily();
  points.forEach((point, i) => {
    for (const key of DAILY_SERIES_KEYS) {
      const cur = point[key];
      const prev = i > 0 ? points[i - 1][key] : null;
      daily[key].push(cur == null || prev == null ? null : (1 + cur) / (1 + prev) - 1);
    }
  });
  return daily;
}

/** 累计值按锚点归一: (1+v)/(1+base)-1, 让窗口起点回到 0。 */
function rebase(value: number | null, base: number | null): number | null {
  if (value == null) return null;
  return base == null ? value : (1 + value) / (1 + base) - 1;
}

export interface DailyWindowOptions {
  year?: number;
  since?: string | null;
}

/** 收益按结算日归属年份: 上年末信号、本年初结算的那一天算本年第一天。 */
function settledYear(point: { signal_date: string; next_signal: string | null }): number {
  return Number((point.next_signal ?? point.signal_date).slice(0, 4));
}

function startIndex(points: DailyCumulative[], opts: DailyWindowOptions): number {
  const { year, since } = opts;
  if (since) return points.findIndex((p) => p.signal_date >= since);
  if (year != null) return points.findIndex((p) => settledYear(p) >= year);
  return 0;
}

/** gated 空仓段会沿用最后净值画平线, 判定"已结算"只看四条真实收益。 */
const SETTLED_KEYS: DailySeriesKey[] = ['core', 'baseline', 'universe', 'hs300'];

/** 末尾未结算的信号日(下一交易日尚未收盘)收益全为空, 不进曲线与统计。 */
function trimUnsettled(points: DailyCumulative[]): DailyCumulative[] {
  let end = points.length;
  while (end > 0 && SETTLED_KEYS.every((key) => points[end - 1][key] == null)) end -= 1;
  return end === points.length ? points : points.slice(0, end);
}

/** 缺省返回全历史; year/since 以起点前一日为零点, 让选中日当天计入窗口。 */
export function buildDailyWindow(points: DailyCumulative[], opts: DailyWindowOptions = {}): DailyWindow {
  const start = startIndex(points, opts);
  if (start < 0) return { points: [], daily: emptyDaily() };
  const daily = dailyReturns(points);
  const anchor = start > 0 ? points[start - 1] : null;
  const windowPoints = trimUnsettled(points.slice(start)).map((point) => ({
    ...point,
    core: rebase(point.core, anchor?.core ?? null),
    baseline: rebase(point.baseline, anchor?.baseline ?? null),
    universe: rebase(point.universe, anchor?.universe ?? null),
    hs300: rebase(point.hs300, anchor?.hs300 ?? null),
    gated: rebase(point.gated, anchor?.gated ?? null),
  }));
  const sliced = emptyDaily();
  for (const key of DAILY_SERIES_KEYS) sliced[key] = daily[key].slice(start, start + windowPoints.length);
  return { points: windowPoints, daily: sliced };
}

/** 统计口径与后端 overall 一致: 每日等权收益复利、胜率按日计, 只算已结算日。 */
export function summarizeDaily(days: DailyRowLike[], opts: DailyWindowOptions = {}): DailyWindowSummary {
  const { year, since } = opts;
  const inRange = since
    ? days.filter((d) => d.signal_date >= since)
    : year == null
      ? days
      : days.filter((d) => settledYear(d) >= year);
  const rows = inRange.filter((d) => d.core_mean != null);
  const values = (key: 'core_mean' | 'baseline_mean' | 'universe_mean'): number[] =>
    rows.map((d) => d[key]).filter((v): v is number => v != null);
  const core = values('core_mean');
  const ic = rows.map((d) => d.rank_ic).filter((v): v is number => v != null);
  return {
    days: rows.length,
    coreCumulative: compound(core),
    baselineCumulative: compound(values('baseline_mean')),
    universeCumulative: compound(values('universe_mean')),
    corePositive: core.length ? core.filter((v) => v > 0).length / core.length : null,
    rankIcMean: mean(ic),
  };
}

interface DailyRowLike {
  signal_date: string;
  next_signal: string | null;
  core_mean: number | null;
  baseline_mean: number | null;
  universe_mean: number | null;
  rank_ic: number | null;
}

/** 由累计收益序列算每日相对历史高点的回撤(小数), 空值不参与但保留位置。 */
export function drawdowns(values: Array<number | null>): Array<number | null> {
  let peak: number | null = null;
  return values.map((v) => {
    if (v == null) return null;
    const equity = 1 + v;
    peak = peak == null ? equity : Math.max(peak, equity);
    return equity / peak - 1;
  });
}

export interface GatedSummary {
  gateOnDays: number;
  gateOffDays: number;
  gatedCumulative: number | null;
  gatedMaxDrawdown: number | null;
  coreMaxDrawdown: number | null;
  hs300MaxDrawdown: number | null;
}

/** 开关视图统计: 窗口内开仓/空仓日数、仅年线上执行累计与三条曲线的最大回撤。 */
export function summarizeGated(window: DailyWindow): GatedSummary {
  const points = window.points;
  return {
    gateOnDays: points.filter((p) => p.gate === 'above').length,
    gateOffDays: points.filter((p) => p.gate === 'below').length,
    gatedCumulative: points[points.length - 1]?.gated ?? null,
    gatedMaxDrawdown: maxDrawdown(points.map((p) => p.gated)),
    coreMaxDrawdown: maxDrawdown(points.map((p) => p.core)),
    hs300MaxDrawdown: maxDrawdown(points.map((p) => p.hs300)),
  };
}

function maxDrawdown(values: Array<number | null>): number | null {
  const valid = drawdowns(values).filter((v): v is number => v != null);
  return valid.length ? Math.min(...valid) : null;
}

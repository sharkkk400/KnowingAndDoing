import type {
  BootstrapStatus,
  DailyAttribution,
  DailyCoreNode,
  DailyDetail,
  DailyHoldingSpell,
  DailyLive,
  DailyLiveRanking,
  DailyLiveRefresh,
  DailyNodeDetail,
  DailyNodeRow,
  DailyRow,
  DailyScreen,
  DatasetSummary,
  EtfCoverage,
  IndexCoverage,
  JobsResponse,
  KlinePeriod,
  KlineResponse,
  MacdStatesResponse,
  RealtimeQuotesResponse,
  RebuildStatus,
  SchedulerStatus,
  SharesResponse,
} from './types';

const API_BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const TIMEOUT_MS = 20000;
/** 全市场筛选/评分首次计算约 10 秒, 与普通查询分档, 避免日期切换被误判为失败。 */
const HEAVY_TIMEOUT_MS = 60000;

function withBase(path: string): string {
  return path.startsWith('/api') ? `${API_BASE}${path}` : path;
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(withBase(path), { ...init, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${res.status} ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } finally {
    window.clearTimeout(timer);
  }
}

function getJson<T>(path: string, timeoutMs?: number): Promise<T> {
  return request<T>(path, undefined, timeoutMs);
}

export const fetchEtfs = () => getJson<EtfCoverage[]>('/api/etfs');

export const fetchShares = (code: string, limit: number) =>
  getJson<SharesResponse>(`/api/etfs/${code}/shares?limit=${limit}`);

export const fetchKline = (code: string, period: KlinePeriod, limit: number, live = false, end?: string | null) =>
  getJson<KlineResponse>(
    `/api/etfs/${code}/kline?period=${period}&limit=${limit}${live ? '&live=1' : ''}${end ? `&end=${end}` : ''}`,
  );

export const fetchMacdStates = (code: string) =>
  getJson<MacdStatesResponse>(`/api/etfs/${code}/macd-states`);

export const fetchQuotes = (codes: string[]) =>
  getJson<RealtimeQuotesResponse>(`/api/etfs/quotes?codes=${encodeURIComponent(codes.join(','))}`);

export const fetchJobs = () => getJson<JobsResponse>('/api/data/jobs');

export const fetchScheduler = () => getJson<SchedulerStatus>('/api/data/scheduler');

export const fetchDatasetSummary = () => getJson<DatasetSummary>('/api/dataset/summary', HEAVY_TIMEOUT_MS);

export const fetchIndices = () => getJson<IndexCoverage[]>('/api/dataset/indices', HEAVY_TIMEOUT_MS);

export const startJob = (job: string) =>
  request<{ job: string; state: string }>('/api/data/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ job }),
  });

/** 一键准备: 空库按依赖顺序拉齐日度复盘所需的全部数据, 幂等可重跑。 */
export const startBootstrap = () =>
  request<BootstrapStatus>('/api/data/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });

export const fetchBootstrap = () => getJson<BootstrapStatus>('/api/data/bootstrap');

function rangeQuery(start?: string, end?: string): string {
  const params = new URLSearchParams();
  if (start) params.set('start', start);
  if (end) params.set('end', end);
  const query = params.toString();
  return query ? `?${query}` : '';
}

export const fetchDailyDays = (start?: string, end?: string) =>
  getJson<DailyRow[]>(`/api/dailypick/days${rangeQuery(start, end)}`);

export const fetchDailyDay = (signalDate: string) => getJson<DailyDetail>(`/api/dailypick/days/${signalDate}`);

export const fetchDailyLive = () => getJson<DailyLive>('/api/dailypick/live');

/** 全量实时排名(约 3MB): 10 分钟一批, 前端配大超时。 */
export const fetchDailyLiveRanking = () => getJson<DailyLiveRanking>('/api/dailypick/live/ranking', HEAVY_TIMEOUT_MS);

/** 手动全量拉取: 服务端清缓存立即重建, 返回实测耗时。 */
export const refreshDailyLive = () =>
  request<DailyLiveRefresh>('/api/dailypick/live/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });

export const fetchDailyScreen = (signalDate: string) =>
  getJson<DailyScreen>(`/api/dailypick/days/${signalDate}/screen`, HEAVY_TIMEOUT_MS);

export const fetchDailyNodes = (start?: string, end?: string) =>
  getJson<DailyNodeRow[]>(`/api/dailypick/nodes${rangeQuery(start, end)}`);

export const fetchDailyNode = (signalDate: string) =>
  getJson<DailyNodeDetail>(`/api/dailypick/nodes/${signalDate}`, HEAVY_TIMEOUT_MS);

export const fetchDailyTimeline = (start?: string, end?: string) =>
  getJson<DailyHoldingSpell[]>(`/api/dailypick/timeline${rangeQuery(start, end)}`);

export const fetchDailyAttribution = (start?: string, end?: string) =>
  getJson<DailyAttribution>(`/api/dailypick/attribution${rangeQuery(start, end)}`);

export const fetchDailyStatus = () => getJson<RebuildStatus>('/api/dailypick/status');

export const startDailyRebuild = (startDate?: string, endDate?: string) =>
  request<{ state: string }>('/api/dailypick/rebuild', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start_date: startDate, end_date: endDate }),
  });

export const fetchDailyCore = (date?: string) =>
  getJson<DailyCoreNode>(`/api/dailypick/core${date ? `?date=${encodeURIComponent(date)}` : ''}`);

export const fetchDailyCoreStatus = () => getJson<RebuildStatus>('/api/dailypick/core/status');

export const startDailyCoreRebuild = (startDate?: string, endDate?: string) =>
  request<{ state: string }>('/api/dailypick/core/rebuild', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start_date: startDate, end_date: endDate }),
  });

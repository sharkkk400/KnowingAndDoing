import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchDailyAttribution,
  fetchDailyCore,
  fetchDailyCoreStatus,
  fetchDailyDay,
  fetchDailyDays,
  fetchDailyLive,
  fetchDailyLiveRanking,
  fetchDailyNode,
  fetchDailyNodes,
  fetchDailyScreen,
  fetchDailyStatus,
  fetchDailyTimeline,
  refreshDailyLive,
  startDailyCoreRebuild,
  startDailyRebuild,
} from '../api/client';

export function useDailyDays() {
  return useQuery({ queryKey: ['daily', 'days'], queryFn: () => fetchDailyDays() });
}

export function useDailyDay(signalDate: string | undefined) {
  return useQuery({
    queryKey: ['daily', 'day', signalDate],
    queryFn: () => fetchDailyDay(signalDate as string),
    enabled: Boolean(signalDate),
  });
}

/** 筛选漏斗 + 全量排名: 首次计算约数秒(后端 120 秒缓存), 同一信号日切回不再重算。 */
export function useDailyScreen(signalDate: string | undefined) {
  return useQuery({
    queryKey: ['daily', 'screen', signalDate],
    queryFn: () => fetchDailyScreen(signalDate as string),
    enabled: Boolean(signalDate),
    staleTime: 120000,
  });
}

/** 今日盘中预选(轻量): 交易时段每分钟一次(与服务端缓存对齐), 现价列由行情接口 15 秒轮询。 */
export function useDailyLive() {
  return useQuery({
    queryKey: ['daily', 'live'],
    queryFn: fetchDailyLive,
    refetchInterval: (query) => (query.state.data?.is_trading ? 60000 : 300000),
    retry: 1,
  });
}

/** 全量实时排名(约 3MB): 交易时段 10 分钟一批(与服务端缓存对齐), 手动刷新后立即重取。 */
export function useDailyLiveRanking(enabled: boolean) {
  return useQuery({
    queryKey: ['daily', 'live-ranking'],
    queryFn: fetchDailyLiveRanking,
    enabled,
    refetchInterval: (query) => (query.state.data?.live ? 600000 : 60000),
    staleTime: 540000,
  });
}

/** 手动全量拉取: 服务端清缓存立即重建; 成功后让预演与排名两个查询失效重取。 */
export function useRefreshDailyLive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: refreshDailyLive,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['daily', 'live'] });
      queryClient.invalidateQueries({ queryKey: ['daily', 'live-ranking'] });
    },
  });
}

export function useDailyAttribution() {
  return useQuery({ queryKey: ['daily', 'attribution'], queryFn: () => fetchDailyAttribution() });
}

export function useDailyStatus() {
  return useQuery({
    queryKey: ['daily', 'status'],
    queryFn: fetchDailyStatus,
    refetchInterval: (query) => (query.state.data?.state === 'running' ? 1500 : false),
  });
}

export function useRebuildDaily() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => startDailyRebuild(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['daily', 'status'] }),
  });
}

/** 该日所属的 core8 换仓节点: 间隔期内返回上一节点, 不按当日排名重排。 */
export function useDailyCore(date: string | undefined) {
  return useQuery({
    queryKey: ['daily', 'core', date],
    queryFn: () => fetchDailyCore(date),
    enabled: Boolean(date),
    retry: false,
  });
}

export function useDailyCoreStatus() {
  return useQuery({
    queryKey: ['daily', 'core', 'status'],
    queryFn: fetchDailyCoreStatus,
    refetchInterval: (query) => (query.state.data?.state === 'running' ? 1500 : false),
  });
}

export function useRebuildDailyCore() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => startDailyCoreRebuild(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['daily', 'core', 'status'] }),
  });
}

/** 换仓节点列表: 节点的持仓/买卖计数在回填完成后才变, 沿用节点重算的失效范围。 */
export function useDailyNodes() {
  return useQuery({ queryKey: ['daily', 'nodes'], queryFn: () => fetchDailyNodes() });
}

/** 节点明细: 持仓/卖出/评分前 20 的价格与区间收益, 纯读节点表与日K。 */
export function useDailyNode(signalDate: string | undefined) {
  return useQuery({
    queryKey: ['daily', 'node', signalDate],
    queryFn: () => fetchDailyNode(signalDate as string),
    enabled: Boolean(signalDate),
    retry: false,
  });
}

export function useDailyTimeline() {
  return useQuery({ queryKey: ['daily', 'timeline'], queryFn: () => fetchDailyTimeline() });
}

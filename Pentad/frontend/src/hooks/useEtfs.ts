import { useQuery } from '@tanstack/react-query';
import type { KlinePeriod } from '../api/types';
import { fetchEtfs, fetchKline, fetchMacdStates, fetchShares } from '../api/client';

export function useEtfs(refetchInterval?: number) {
  return useQuery({
    queryKey: ['etfs'],
    queryFn: fetchEtfs,
    staleTime: 60_000,
    refetchInterval,
  });
}

export function useShares(code: string, limit: number) {
  return useQuery({
    queryKey: ['shares', code, limit],
    queryFn: () => fetchShares(code, limit),
    retry: false,
  });
}

/** live=true 时后端会追加当日未收盘K线, 并随行情轮询刷新; end 给定时窗口截止到该日(历史节点回看)。 */
export function useKline(
  code: string,
  period: KlinePeriod,
  limit: number,
  live = false,
  end?: string | null,
) {
  return useQuery({
    queryKey: ['kline', code, period, limit, live, end ?? null],
    queryFn: () => fetchKline(code, period, limit, live, end),
    retry: false,
    refetchInterval: live ? 30_000 : false,
  });
}

export function useMacdStates(code: string) {
  return useQuery({
    queryKey: ['macd-states', code],
    queryFn: () => fetchMacdStates(code),
    retry: false,
  });
}

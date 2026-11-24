import { useQuery } from '@tanstack/react-query';
import { fetchQuotes } from '../api/client';

const POLL_MS = 15000;
const IDLE_POLL_MS = 60000; // 非交易时段低频探测, 开盘后自动切回 15 秒

/**
 * 当周实时行情: 交易时段每 15 秒刷新, 非交易时段降频到 60 秒。
 * 交易时段由后端按交易日历判断, 前端不自行猜时段。
 */
export function useQuotes(codes: string[], enabled: boolean) {
  const unique = Array.from(new Set(codes)).sort();
  return useQuery({
    queryKey: ['quotes', unique.join(',')],
    queryFn: () => fetchQuotes(unique),
    enabled: enabled && unique.length > 0,
    refetchInterval: (query) => (query.state.data?.is_trading ? POLL_MS : IDLE_POLL_MS),
    refetchOnWindowFocus: false,
    staleTime: POLL_MS / 3,
  });
}

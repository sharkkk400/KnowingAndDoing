import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchBootstrap, fetchJobs, fetchScheduler, startBootstrap, startJob } from '../api/client';

export function useJobs() {
  return useQuery({
    queryKey: ['jobs'],
    queryFn: fetchJobs,
    refetchInterval: 1500,
  });
}

export function useSchedulerStatus() {
  return useQuery({
    queryKey: ['scheduler'],
    queryFn: fetchScheduler,
    refetchInterval: 5000,
  });
}

export function useStartJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: startJob,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobs'] }),
  });
}

/** 一键准备进度: 跑动时 1.5 秒一轮, 结束后停止轮询。 */
export function useBootstrap() {
  return useQuery({
    queryKey: ['bootstrap'],
    queryFn: fetchBootstrap,
    refetchInterval: (query) => (query.state.data?.state === 'running' ? 1500 : false),
  });
}

export function useStartBootstrap() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: startBootstrap,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['bootstrap'] }),
  });
}

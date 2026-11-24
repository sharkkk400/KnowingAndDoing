import { useQuery } from '@tanstack/react-query';
import { fetchDatasetSummary, fetchIndices } from '../api/client';

export function useDatasetSummary() {
  return useQuery({
    queryKey: ['dataset-summary'],
    queryFn: fetchDatasetSummary,
    staleTime: 60_000,
  });
}

export function useIndices() {
  return useQuery({
    queryKey: ['dataset-indices'],
    queryFn: fetchIndices,
    staleTime: 60_000,
  });
}

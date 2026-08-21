import { useQuery } from "@tanstack/react-query";

import {
  fetchOperationsDashboard,
  fetchOperationsDashboardDetails,
} from "./api";
import type { OperationsRange } from "./types";

export function useOperationsDashboard(range: OperationsRange) {
  return useQuery({
    queryKey: ["operations-dashboard", range],
    queryFn: () => fetchOperationsDashboard(range),
    staleTime: 30_000,
  });
}

export function useOperationsDashboardDetails(
  range: OperationsRange,
  enabled = true,
) {
  const tzOffsetMinutes = -new Date().getTimezoneOffset();
  return useQuery({
    queryKey: ["operations-dashboard-details", range, tzOffsetMinutes],
    queryFn: () => fetchOperationsDashboardDetails(range, tzOffsetMinutes),
    enabled,
    staleTime: 30_000,
  });
}

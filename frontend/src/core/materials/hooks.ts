import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  fetchMaterialCapabilities,
  fetchMaterials,
  setMaterialFavorite,
  uploadMaterialToKnowledge,
} from "./api";

export const MATERIALS_SEARCH_DEBOUNCE_MS = 300;

export function useMaterials(filters: {
  q: string;
  type: string;
  favoritesOnly: boolean;
}) {
  const [debouncedQuery, setDebouncedQuery] = useState(filters.q);

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedQuery(filters.q),
      MATERIALS_SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [filters.q]);

  const queryFilters = { ...filters, q: debouncedQuery };
  return useQuery({
    queryKey: ["materials", queryFilters],
    queryFn: () => fetchMaterials(queryFilters),
    staleTime: 15_000,
  });
}
export function useMaterialCapabilities() {
  return useQuery({
    queryKey: ["materials-capabilities"],
    queryFn: fetchMaterialCapabilities,
    staleTime: 30_000,
  });
}
export function useMaterialActions() {
  const queryClient = useQueryClient();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["materials"] });
  const favorite = useMutation({
    mutationFn: ({
      threadId,
      path,
      favorite,
    }: {
      threadId: string;
      path: string;
      favorite: boolean;
    }) => setMaterialFavorite(threadId, path, favorite),
    onSuccess: refresh,
  });
  const upload = useMutation({
    mutationFn: ({ threadId, path }: { threadId: string; path: string }) =>
      uploadMaterialToKnowledge(threadId, path),
    onSuccess: refresh,
  });
  return { favorite, upload };
}

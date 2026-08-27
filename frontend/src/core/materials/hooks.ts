import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchMaterialCapabilities,
  fetchMaterials,
  setMaterialFavorite,
  uploadMaterialToKnowledge,
} from "./api";
export function useMaterials(filters: {
  q: string;
  type: string;
  favoritesOnly: boolean;
}) {
  return useQuery({
    queryKey: ["materials", filters],
    queryFn: () => fetchMaterials(filters),
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

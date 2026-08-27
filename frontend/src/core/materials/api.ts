import { fetch } from "@/core/api/fetcher";
import { getBackendBaseURL } from "@/core/config";

import type { MaterialCapabilities, MaterialsResponse } from "./types";

const base = () => `${getBackendBaseURL()}/api/materials`;
export async function fetchMaterials(params: {
  q?: string;
  type?: string;
  favoritesOnly?: boolean;
}) {
  const query = new URLSearchParams({
    q: params.q ?? "",
    type: params.type ?? "all",
    favorites_only: String(params.favoritesOnly ?? false),
  });
  const response = await fetch(`${base()}?${query}`);
  if (!response.ok) throw new Error("资料加载失败");
  return response.json() as Promise<MaterialsResponse>;
}
export async function fetchMaterialCapabilities() {
  const response = await fetch(`${base()}/capabilities`);
  if (!response.ok) throw new Error("资料能力加载失败");
  return response.json() as Promise<MaterialCapabilities>;
}
export async function setMaterialFavorite(
  threadId: string,
  path: string,
  favorite: boolean,
) {
  const response = await fetch(
    `${base()}/${encodeURIComponent(threadId)}/favorite?path=${encodeURIComponent(path)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ favorite }),
    },
  );
  if (!response.ok) throw new Error("收藏操作失败");
}
export async function uploadMaterialToKnowledge(
  threadId: string,
  path: string,
) {
  const response = await fetch(
    `${base()}/${encodeURIComponent(threadId)}/upload-knowledge?path=${encodeURIComponent(path)}`,
    { method: "POST" },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail ?? "上传失败");
  return data;
}

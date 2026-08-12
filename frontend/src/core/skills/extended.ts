/**
 * Extended skill management API + hooks (skills gallery migration).
 *
 * All endpoints and hooks added for the skills gallery live here as new
 * code, so the original `./api`, `./hooks` and `./type` files stay
 * untouched. Backed by the extended skill endpoints in
 * `backend/app/gateway/routers/skills_ext.py`.
 *
 * The Skill interface extension below is a module augmentation of
 * `./type`: it adds the optional business-metadata fields returned by the
 * backend (Chinese display name/description, category, tags, scope, ...)
 * without modifying the original type file.
 */

// Augment the original Skill type with gallery fields — `./type` stays
// untouched; every consumer importing Skill from it picks these up.
declare module "./type" {
  export interface Skill {
    // Extended fields (skills gallery migration) — populated by the backend
    // business metadata store; absent on older backends.
    skill_category?: string;
    category_label?: string;
    tags?: string[];
    display_name?: string | null;
    description_zh?: string | null;
    safety_level?: string | null;
    capabilities?: string | null;
    recommended_scenarios?: string | null;
    scope?: "public" | "user" | "legacy" | string;
    can_manage?: boolean;
  }
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { fetch } from "@/core/api/fetcher";
import { getBackendBaseURL } from "@/core/config";

import { SkillRequestError, type InstallSkillResponse } from "./api";
import type { Skill } from "./type";

// ── Types ───────────────────────────────────────────────────────────────────

export interface BatchDeleteSkillsResponse {
  success: boolean;
  deleted: string[];
  failed: { skill_name: string; detail: string }[];
  message: string;
}

export interface CreateSkillRequest {
  name: string;
  display_name?: string;
  description?: string;
  category?: string;
  tags?: string[];
}

export interface CreateSkillResponse {
  name: string;
  scope: string;
  skill_dir: string;
}

export interface ExportSkillResponse {
  blob: Blob;
  filename: string;
}

export interface CustomSkillContent {
  name: string;
  description: string;
  license: string | null;
  category: string;
  enabled: boolean;
  editable: boolean;
  content: string;
}

// ── API helpers ─────────────────────────────────────────────────────────────

async function readErrorDetail(response: Response): Promise<string> {
  const data = (await response.json().catch(() => ({}))) as {
    detail?: unknown;
  };
  if (typeof data.detail === "string") return data.detail;
  return `HTTP ${response.status}: ${response.statusText}`;
}

function filenameFromContentDisposition(headerValue: string | null) {
  if (!headerValue) return null;
  const utf8Match = /filename*=UTF-8''([^;]+)/i.exec(headerValue);
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1]);
  }
  const basicMatch = /filename="?([^";]+)"?/i.exec(headerValue);
  return basicMatch?.[1] ?? null;
}

export async function updateSkillCategory(
  skillName: string,
  payload: { display_name?: string; category: string; tags: string[] },
): Promise<Skill> {
  const response = await fetch(
    `${getBackendBaseURL()}/api/skills/${encodeURIComponent(skillName)}/category`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    throw new SkillRequestError(response.status, await readErrorDetail(response));
  }
  return response.json();
}

export async function deleteSkill(skillName: string): Promise<void> {
  const response = await fetch(
    `${getBackendBaseURL()}/api/skills/${encodeURIComponent(skillName)}`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    throw new SkillRequestError(response.status, await readErrorDetail(response));
  }
}

export async function batchDeleteSkills(
  skillNames: string[],
): Promise<BatchDeleteSkillsResponse> {
  const response = await fetch(`${getBackendBaseURL()}/api/skills/batch-delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skill_names: skillNames }),
  });
  if (!response.ok) {
    throw new SkillRequestError(response.status, await readErrorDetail(response));
  }
  return response.json();
}

export async function importSkillPackage(file: File): Promise<InstallSkillResponse> {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(`${getBackendBaseURL()}/api/skills/import`, {
    method: "POST",
    body: formData,
  });
  if (!response.ok) {
    throw new SkillRequestError(response.status, await readErrorDetail(response));
  }
  return response.json();
}

export async function exportInstalledSkill(
  name: string,
  format: "zip" | "md" = "zip",
): Promise<ExportSkillResponse> {
  const params = new URLSearchParams({ format });
  const response = await fetch(
    `${getBackendBaseURL()}/api/skills/${encodeURIComponent(name)}/export?${params}`,
  );
  if (!response.ok) {
    throw new SkillRequestError(response.status, await readErrorDetail(response));
  }
  const blob = await response.blob();
  const filename =
    filenameFromContentDisposition(response.headers.get("Content-Disposition")) ??
    `${name}.skill.${format === "md" ? "md" : "zip"}`;
  return { blob, filename };
}

export async function exportSkillsBatch(names: string[]): Promise<ExportSkillResponse> {
  const response = await fetch(`${getBackendBaseURL()}/api/skills/batch/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skill_names: names }),
  });
  if (!response.ok) {
    throw new SkillRequestError(response.status, await readErrorDetail(response));
  }
  const blob = await response.blob();
  const filename =
    filenameFromContentDisposition(response.headers.get("Content-Disposition")) ??
    "skills-export.zip";
  return { blob, filename };
}

export async function createSkill(payload: CreateSkillRequest): Promise<CreateSkillResponse> {
  const response = await fetch(`${getBackendBaseURL()}/api/skills/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new SkillRequestError(response.status, await readErrorDetail(response));
  }
  return response.json();
}

/** Read a custom skill's raw SKILL.md content (admin-only endpoint). */
export async function loadCustomSkillContent(
  skillName: string,
): Promise<CustomSkillContent> {
  const response = await fetch(
    `${getBackendBaseURL()}/api/skills/custom/${encodeURIComponent(skillName)}`,
  );
  if (!response.ok) {
    throw new SkillRequestError(response.status, await readErrorDetail(response));
  }
  return response.json();
}

// ── Hooks ───────────────────────────────────────────────────────────────────

function invalidateSkills(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ["skills"] });
}

export function useUpdateSkillCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      skillName,
      displayName,
      category,
      tags,
    }: {
      skillName: string;
      displayName?: string;
      category: string;
      tags: string[];
    }) => updateSkillCategory(skillName, { display_name: displayName, category, tags }),
    onSuccess: () => invalidateSkills(queryClient),
  });
}

export function useDeleteSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (skillName: string) => deleteSkill(skillName),
    onSuccess: () => invalidateSkills(queryClient),
  });
}

export function useBatchDeleteSkills() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (skillNames: string[]) => batchDeleteSkills(skillNames),
    onSuccess: () => invalidateSkills(queryClient),
  });
}

export function useImportSkillPackage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => importSkillPackage(file),
    onSuccess: () => invalidateSkills(queryClient),
  });
}

export function useCreateSkill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createSkill,
    onSuccess: () => invalidateSkills(queryClient),
  });
}

/** Read a custom skill's raw SKILL.md content (detail dialog; disabled when name is null). */
export function useCustomSkillContent(skillName: string | null) {
  return useQuery({
    queryKey: ["skills", "custom-content", skillName],
    queryFn: () => loadCustomSkillContent(skillName!),
    enabled: Boolean(skillName),
    retry: false,
  });
}

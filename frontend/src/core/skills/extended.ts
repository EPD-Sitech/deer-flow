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

import { loadSkills, SkillRequestError, type InstallSkillResponse } from "./api";
import type { Skill } from "./type";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SkillMetadata {
  display_name?: string | null;
  description_zh?: string | null;
  safety_level?: string | null;
  capabilities?: string | null;
  recommended_scenarios?: string | null;
}

export interface BatchDeleteSkillsResponse {
  success: boolean;
  deleted: string[];
  failed: { skill_name: string; detail: string }[];
  message: string;
}

export interface GenerateSkillMetadataResponse {
  success: boolean;
  skill_name: string;
  skipped: boolean;
  attempts: number;
  metadata?: SkillMetadata | null;
  message: string;
}

export interface BatchGenerateSkillMetadataRequest {
  skill_names: string[];
  skip_existing?: boolean;
  retries?: number;
}

export interface BatchGenerateSkillMetadataItemResponse {
  skill_name: string;
  status: "generated" | "skipped" | "failed";
  attempts: number;
  metadata?: SkillMetadata | null;
  message: string;
}

export interface BatchGenerateSkillMetadataResponse {
  success: boolean;
  total: number;
  generated: number;
  skipped: number;
  failed: number;
  results: BatchGenerateSkillMetadataItemResponse[];
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

export type BatchProgressCallback = (progress: {
  completed: number;
  total: number;
  currentSkill: string;
  generated: number;
  skipped: number;
  failed: number;
}) => void;

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

export async function generateSkillMetadata(
  skillName: string,
  persist = true,
): Promise<GenerateSkillMetadataResponse> {
  let url = `${getBackendBaseURL()}/api/skills/${encodeURIComponent(skillName)}/metadata/generate`;
  if (!persist) {
    url += "?persist=false";
  }
  const response = await fetch(url, { method: "POST" });
  if (!response.ok) {
    throw new SkillRequestError(response.status, await readErrorDetail(response));
  }
  return response.json();
}

export async function batchSaveSkillMetadata(
  metadata: Record<string, Record<string, string>>,
): Promise<void> {
  const response = await fetch(`${getBackendBaseURL()}/api/skills/metadata/batch-save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ metadata }),
  });
  if (!response.ok) {
    throw new SkillRequestError(response.status, await readErrorDetail(response));
  }
}

const CONCURRENCY = 16;

/**
 * Generate Chinese metadata for many skills in parallel, collecting results
 * and persisting them in a single batch-save at the end (mirrors the harness
 * gallery behaviour).
 */
export async function batchGenerateSkillMetadata(
  request: BatchGenerateSkillMetadataRequest,
  onProgress?: BatchProgressCallback,
): Promise<BatchGenerateSkillMetadataResponse> {
  const { skill_names, skip_existing } = request;
  const allResults: BatchGenerateSkillMetadataItemResponse[] = new Array(
    skill_names.length,
  );
  let totalGenerated = 0;
  let totalSkipped = 0;
  let totalFailed = 0;
  let totalCompleted = 0;
  const activeSkills = new Set<string>();
  const pendingMetadata: Record<string, Record<string, string>> = {};

  let existingSet: Set<string> | null = null;
  if (skip_existing) {
    try {
      const currentSkills = await loadSkills();
      existingSet = new Set(
        currentSkills.filter((s) => s.display_name).map((s) => s.name),
      );
    } catch {
      existingSet = null;
    }
  }

  const emitProgress = () => {
    const active = [...activeSkills];
    const display =
      active.length <= 2
        ? active.join(", ")
        : `${active[0]}, ${active[1]} +${active.length - 2}`;
    onProgress?.({
      completed: totalCompleted,
      total: skill_names.length,
      currentSkill: display,
      generated: totalGenerated,
      skipped: totalSkipped,
      failed: totalFailed,
    });
  };

  const processSkill = async (index: number) => {
    const name = skill_names[index]!;

    if (existingSet?.has(name)) {
      totalSkipped++;
      totalCompleted++;
      allResults[index] = {
        skill_name: name,
        status: "skipped",
        attempts: 0,
        metadata: null,
        message: "Skipped because metadata already exists",
      };
      emitProgress();
      return;
    }

    activeSkills.add(name);
    emitProgress();

    try {
      const result = await generateSkillMetadata(name, false);
      if (result.skipped) {
        totalSkipped++;
        allResults[index] = {
          skill_name: name,
          status: "skipped",
          attempts: result.attempts,
          metadata: result.metadata,
          message: result.message,
        };
      } else {
        totalGenerated++;
        allResults[index] = {
          skill_name: name,
          status: "generated",
          attempts: result.attempts,
          metadata: result.metadata,
          message: result.message,
        };
        if (result.metadata) {
          pendingMetadata[name] = {
            display_name: result.metadata.display_name ?? "",
            description_zh: result.metadata.description_zh ?? "",
            safety_level: result.metadata.safety_level ?? "",
            capabilities: result.metadata.capabilities ?? "",
            recommended_scenarios: result.metadata.recommended_scenarios ?? "",
          };
        }
      }
    } catch {
      totalFailed++;
      allResults[index] = {
        skill_name: name,
        status: "failed",
        attempts: 0,
        metadata: null,
        message: "Failed to generate metadata",
      };
    }

    activeSkills.delete(name);
    totalCompleted++;
    emitProgress();
  };

  let nextIndex = 0;
  const runWorker = async () => {
    while (nextIndex < skill_names.length) {
      const idx = nextIndex++;
      await processSkill(idx);
    }
  };

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, skill_names.length) },
    () => runWorker(),
  );
  await Promise.all(workers);

  if (Object.keys(pendingMetadata).length > 0) {
    try {
      await batchSaveSkillMetadata(pendingMetadata);
    } catch (e) {
      console.error("Failed to batch save metadata:", e);
    }
  }

  return {
    success: totalFailed === 0,
    total: skill_names.length,
    generated: totalGenerated,
    skipped: totalSkipped,
    failed: totalFailed,
    results: allResults.filter(Boolean),
    message: `Metadata generation completed: generated ${totalGenerated}, skipped ${totalSkipped}, failed ${totalFailed}`,
  };
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

export function useGenerateSkillMetadata() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (skillName: string) => generateSkillMetadata(skillName),
    onSuccess: () => invalidateSkills(queryClient),
  });
}

export function useBatchGenerateSkillMetadata(
  onProgress?: BatchProgressCallback,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      skill_names,
      skip_existing,
      retries,
    }: {
      skill_names: string[];
      skip_existing?: boolean;
      retries?: number;
    }) =>
      batchGenerateSkillMetadata(
        { skill_names, skip_existing, retries },
        onProgress,
      ),
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

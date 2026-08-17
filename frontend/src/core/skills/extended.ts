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

// ── Skill file editor (files / versions) ────────────────────────────────────
// Ported from the harness skill detail dialog: browse, edit, rename and delete
// skill files with automatic versioned backups.

export interface SkillFileInfo {
  path: string;
  size: number;
  modified: string;
}

export interface SkillFilesResponse {
  skill_name: string;
  scope?: string | null;
  can_edit: boolean;
  files: SkillFileInfo[];
}

export interface SkillFileContentResponse {
  path: string;
  content: string;
  language: string;
  size: number;
}

export interface SkillFileSaveResponse {
  path: string;
  size: number;
  version_id: string;
}

export interface SkillFileRenameResponse {
  path: string;
  size: number;
  version_id: string;
}

export interface SkillVersionInfo {
  version_id: string;
  timestamp: string;
  files_changed: string[];
}

export interface SkillVersionsResponse {
  versions: SkillVersionInfo[];
}

export interface SkillRestoreResponse {
  restored_version: string;
  backup_version: string;
  files_restored: string[];
}

/** Encode a skill file path for use inside a URL path segment. */
export function encodeFilePath(filePath: string): string {
  return filePath.split("/").map(encodeURIComponent).join("%2F");
}

export async function listSkillFiles(
  skillName: string,
): Promise<SkillFilesResponse> {
  const response = await fetch(
    `${getBackendBaseURL()}/api/skills/${encodeURIComponent(skillName)}/files`,
  );
  if (!response.ok) {
    throw new SkillRequestError(response.status, await readErrorDetail(response));
  }
  return response.json();
}

export async function readSkillFileContent(
  skillName: string,
  filePath: string,
): Promise<SkillFileContentResponse> {
  const response = await fetch(
    `${getBackendBaseURL()}/api/skills/${encodeURIComponent(skillName)}/files/${encodeFilePath(filePath)}`,
  );
  if (!response.ok) {
    throw new SkillRequestError(response.status, await readErrorDetail(response));
  }
  return response.json();
}

export async function saveSkillFile(
  skillName: string,
  filePath: string,
  content: string,
): Promise<SkillFileSaveResponse> {
  const response = await fetch(
    `${getBackendBaseURL()}/api/skills/${encodeURIComponent(skillName)}/files/${encodeFilePath(filePath)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
  if (!response.ok) {
    throw new SkillRequestError(response.status, await readErrorDetail(response));
  }
  return response.json();
}

export async function deleteSkillFile(
  skillName: string,
  filePath: string,
): Promise<SkillFileSaveResponse> {
  const response = await fetch(
    `${getBackendBaseURL()}/api/skills/${encodeURIComponent(skillName)}/files/${encodeFilePath(filePath)}`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    if (response.status === 404) {
      return { path: filePath, size: 0, version_id: "" };
    }
    throw new SkillRequestError(response.status, await readErrorDetail(response));
  }
  return response.json();
}

export async function renameSkillFile(
  skillName: string,
  filePath: string,
  newPath: string,
): Promise<SkillFileRenameResponse> {
  const response = await fetch(
    `${getBackendBaseURL()}/api/skills/${encodeURIComponent(skillName)}/files/${encodeFilePath(filePath)}/rename`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_path: newPath }),
    },
  );
  if (!response.ok) {
    throw new SkillRequestError(response.status, await readErrorDetail(response));
  }
  return response.json();
}

export async function listSkillVersions(
  skillName: string,
): Promise<SkillVersionsResponse> {
  const response = await fetch(
    `${getBackendBaseURL()}/api/skills/${encodeURIComponent(skillName)}/versions`,
  );
  if (!response.ok) {
    throw new SkillRequestError(response.status, await readErrorDetail(response));
  }
  return response.json();
}

export async function restoreSkillVersion(
  skillName: string,
  versionId: string,
): Promise<SkillRestoreResponse> {
  const response = await fetch(
    `${getBackendBaseURL()}/api/skills/${encodeURIComponent(skillName)}/versions/${encodeURIComponent(versionId)}/restore`,
    { method: "POST" },
  );
  if (!response.ok) {
    throw new SkillRequestError(response.status, await readErrorDetail(response));
  }
  return response.json();
}

/** List the files of a skill directory (enabled when name is provided). */
export function useSkillFiles(skillName: string | null) {
  return useQuery({
    queryKey: ["skills", "files", skillName],
    queryFn: () => listSkillFiles(skillName!),
    enabled: Boolean(skillName),
    retry: false,
  });
}

/** Read one skill file's content (enabled when both name and path are set). */
export function useSkillFileContent(
  skillName: string | null,
  filePath: string | null,
) {
  return useQuery({
    queryKey: ["skills", "file-content", skillName, filePath],
    queryFn: () => readSkillFileContent(skillName!, filePath!),
    enabled: Boolean(skillName && filePath),
    retry: false,
  });
}

export function useSaveSkillFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      skillName: string;
      filePath: string;
      content: string;
    }) => saveSkillFile(payload.skillName, payload.filePath, payload.content),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ["skills", "file-content", variables.skillName],
      });
      void queryClient.invalidateQueries({
        queryKey: ["skills", "versions", variables.skillName],
      });
    },
  });
}

export function useDeleteSkillFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { skillName: string; filePath: string }) =>
      deleteSkillFile(payload.skillName, payload.filePath),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ["skills", "files", variables.skillName],
      });
      void queryClient.invalidateQueries({
        queryKey: ["skills", "versions", variables.skillName],
      });
    },
  });
}

export function useRenameSkillFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      skillName: string;
      filePath: string;
      newPath: string;
    }) => renameSkillFile(payload.skillName, payload.filePath, payload.newPath),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ["skills", "files", variables.skillName],
      });
      void queryClient.invalidateQueries({
        queryKey: ["skills", "versions", variables.skillName],
      });
    },
  });
}

/** List version history (enabled when name is set). */
export function useSkillVersions(skillName: string | null) {
  return useQuery({
    queryKey: ["skills", "versions", skillName],
    queryFn: () => listSkillVersions(skillName!),
    enabled: Boolean(skillName),
    retry: false,
  });
}

export function useRestoreSkillVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { skillName: string; versionId: string }) =>
      restoreSkillVersion(payload.skillName, payload.versionId),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ["skills", "file-content", variables.skillName],
      });
      void queryClient.invalidateQueries({
        queryKey: ["skills", "versions", variables.skillName],
      });
    },
  });
}

// ── Skill debug run ─────────────────────────────────────────────────────────

export interface SkillDebugMessage {
  role: string;
  content: string;
  tool_calls?: { name: string; args: Record<string, unknown> }[];
  name?: string | null;
  status?: string | null;
}

export interface SkillDebugRunResponse {
  success: boolean;
  messages: SkillDebugMessage[];
  duration_ms: number;
  error?: string | null;
}

export async function debugRunSkill(
  skillName: string,
  payload: {
    prompt: string;
    parameters?: Record<string, string>;
    model_name?: string;
    timeout?: number;
  },
): Promise<SkillDebugRunResponse> {
  const response = await fetch(
    `${getBackendBaseURL()}/api/skills/${encodeURIComponent(skillName)}/debug/run`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    throw new SkillRequestError(response.status, await readErrorDetail(response));
  }
  return response.json();
}

export function useDebugRunSkill() {
  return useMutation({
    mutationFn: (payload: {
      skillName: string;
      prompt: string;
      parameters?: Record<string, string>;
      model_name?: string;
      timeout?: number;
    }) =>
      debugRunSkill(payload.skillName, {
        prompt: payload.prompt,
        parameters: payload.parameters,
        model_name: payload.model_name,
        timeout: payload.timeout,
      }),
  });
}

// ── Skill evolution (AI-driven improvements) ────────────────────────────────

export interface SkillEvolutionRecord {
  id: string;
  feedback: string;
  summary: string;
  status: "pending" | "applied" | "rejected" | string;
  created_at: string;
  applied_at?: string | null;
}

export interface SkillEvolutionHistoryResponse {
  records: SkillEvolutionRecord[];
}

export interface SkillEvolutionSuggestionsResponse {
  suggestions: string[];
}

export async function proposeSkillEvolution(
  skillName: string,
  feedback: string,
): Promise<SkillEvolutionRecord> {
  const response = await fetch(
    `${getBackendBaseURL()}/api/skills/${encodeURIComponent(skillName)}/evolve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback }),
    },
  );
  if (!response.ok) {
    throw new SkillRequestError(response.status, await readErrorDetail(response));
  }
  return response.json();
}

export async function applySkillEvolution(
  skillName: string,
  recordId: string,
): Promise<SkillEvolutionRecord> {
  const response = await fetch(
    `${getBackendBaseURL()}/api/skills/${encodeURIComponent(skillName)}/evolve/${encodeURIComponent(recordId)}/apply`,
    { method: "POST" },
  );
  if (!response.ok) {
    throw new SkillRequestError(response.status, await readErrorDetail(response));
  }
  return response.json();
}

export async function rejectSkillEvolution(
  skillName: string,
  recordId: string,
): Promise<SkillEvolutionRecord> {
  const response = await fetch(
    `${getBackendBaseURL()}/api/skills/${encodeURIComponent(skillName)}/evolve/${encodeURIComponent(recordId)}/reject`,
    { method: "POST" },
  );
  if (!response.ok) {
    throw new SkillRequestError(response.status, await readErrorDetail(response));
  }
  return response.json();
}

export async function loadSkillEvolutionHistory(
  skillName: string,
): Promise<SkillEvolutionHistoryResponse> {
  const response = await fetch(
    `${getBackendBaseURL()}/api/skills/${encodeURIComponent(skillName)}/evolution-history`,
  );
  if (!response.ok) {
    throw new SkillRequestError(response.status, await readErrorDetail(response));
  }
  return response.json();
}

export async function loadSkillEvolutionSuggestions(
  skillName: string,
): Promise<SkillEvolutionSuggestionsResponse> {
  const response = await fetch(
    `${getBackendBaseURL()}/api/skills/${encodeURIComponent(skillName)}/evolution-suggestions`,
  );
  if (!response.ok) {
    throw new SkillRequestError(response.status, await readErrorDetail(response));
  }
  return response.json();
}

function invalidateEvolution(
  queryClient: ReturnType<typeof useQueryClient>,
  skillName: string,
) {
  void queryClient.invalidateQueries({
    queryKey: ["skills", "evolution", skillName],
  });
  void queryClient.invalidateQueries({
    queryKey: ["skills", "file-content", skillName],
  });
}

export function useProposeSkillEvolution() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { skillName: string; feedback: string }) =>
      proposeSkillEvolution(payload.skillName, payload.feedback),
    onSuccess: (_data, variables) =>
      invalidateEvolution(queryClient, variables.skillName),
  });
}

export function useApplySkillEvolution() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { skillName: string; recordId: string }) =>
      applySkillEvolution(payload.skillName, payload.recordId),
    onSuccess: (_data, variables) =>
      invalidateEvolution(queryClient, variables.skillName),
  });
}

export function useRejectSkillEvolution() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { skillName: string; recordId: string }) =>
      rejectSkillEvolution(payload.skillName, payload.recordId),
    onSuccess: (_data, variables) =>
      invalidateEvolution(queryClient, variables.skillName),
  });
}

/** Evolution history (enabled when name is set). */
export function useSkillEvolutionHistory(skillName: string | null) {
  return useQuery({
    queryKey: ["skills", "evolution", "history", skillName],
    queryFn: () => loadSkillEvolutionHistory(skillName!),
    enabled: Boolean(skillName),
    retry: false,
  });
}

/** Feedback suggestions (enabled when name is set). */
export function useSkillEvolutionSuggestions(skillName: string | null) {
  return useQuery({
    queryKey: ["skills", "evolution", "suggestions", skillName],
    queryFn: () => loadSkillEvolutionSuggestions(skillName!),
    enabled: Boolean(skillName),
    retry: false,
  });
}

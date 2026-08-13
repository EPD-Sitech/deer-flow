import type { Agent } from "@/core/agents";
import { fetch as authenticatedFetch } from "@/core/api/fetcher";
import { getBackendBaseURL } from "@/core/config";

export interface AgentFiles {
  name: string;
  config_yaml: string;
  soul: string;
  guide_questions?: Array<{ question: string; prompt?: string }>;
}

export interface AgentVersion {
  version_id: string;
  message: string;
  created_at: string;
}

export interface ValidationCheck {
  check: string;
  status: "pass" | "warn" | "error";
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  checks: ValidationCheck[];
  errors: number;
  warnings: number;
}

export interface AgentTestResult {
  response: string;
  metadata: {
    model_used: string;
    tokens_used: number;
    latency_ms: number;
  };
}

export interface AgentLog {
  timestamp: string | null;
  thread_id: string;
  user_query: string;
  response_summary: string;
  tokens_used: number;
  latency_ms: number;
  status: string;
  error?: string | null;
}

export interface AgentStats {
  total_calls: number;
  success_count: number;
  error_count: number;
  avg_latency_ms: number;
  total_tokens: number;
}

export interface AgentSchedule {
  id: string;
  title: string;
  prompt: string;
  status: string;
  schedule_type: string;
  schedule_spec: Record<string, unknown>;
  timezone: string;
  next_run_at: string | null;
  last_run_at?: string | null;
}

export interface ImportAgentResult {
  imported: Array<{ name: string; status: string; source: string }>;
  errors: Array<{ name: string; error: string }>;
}

export interface ImportSubAgentResult {
  success: boolean;
  installed_skills: string[];
  skipped_skills: string[];
  merged_sub_agents: string[];
  skipped_sub_agents: string[];
  errors: Array<{ name: string; error: string }>;
}

export interface AgentShare {
  enabled: boolean;
  public_slug: string | null;
  public_name: string;
  public_path: string;
}

export interface LocalAgentCatalogItem extends Agent {
  scope: "platform" | "user";
  runtime_name: string;
  can_manage: boolean;
  can_view_details: boolean;
  can_edit_guide_questions: boolean;
  can_edit: boolean;
  can_delete: boolean;
  can_export: boolean;
  can_clone: boolean;
  can_share: boolean;
  can_batch: boolean;
  guide_questions: Array<{ question: string; prompt?: string }>;
}

export type AgentScope = LocalAgentCatalogItem["scope"];

const api = (path: string) => `${getBackendBaseURL()}${path}`;

function withScope(path: string, scope: AgentScope) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}scope=${scope}`;
}

async function errorMessage(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as {
    detail?: unknown;
  } | null;
  return typeof body?.detail === "string" ? body.detail : fallback;
}

async function jsonRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(api(path), init);
  if (!response.ok) {
    const error = new Error(
      await errorMessage(response, `Request failed (${response.status})`),
    ) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return response.json() as Promise<T>;
}

function jsonBody(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function getAgentFiles(name: string, scope: AgentScope = "user") {
  return jsonRequest<AgentFiles>(
    withScope(`/api/agents/${encodeURIComponent(name)}/files`, scope),
  );
}

export async function listAgentCatalog() {
  const result = await jsonRequest<{ agents: LocalAgentCatalogItem[] }>(
    "/api/agent-management/catalog",
  );
  return result.agents;
}

export function updateAgentFiles(
  name: string,
  files: {
    config_yaml: string;
    soul: string;
    guide_questions?: Array<{ question: string; prompt?: string }>;
  },
  scope: AgentScope = "user",
) {
  return jsonRequest<AgentFiles>(
    withScope(`/api/agents/${encodeURIComponent(name)}/files`, scope),
    { ...jsonBody(files), method: "PUT" },
  );
}

export function getAgentShare(name: string, scope: AgentScope = "user") {
  return jsonRequest<AgentShare>(
    withScope(`/api/agents/${encodeURIComponent(name)}/share`, scope),
  );
}

export function updateAgentShare(
  name: string,
  share: { enabled: boolean; public_slug: string | null },
  scope: AgentScope = "user",
) {
  return jsonRequest<AgentShare>(
    withScope(`/api/agents/${encodeURIComponent(name)}/share`, scope),
    { ...jsonBody(share), method: "PUT" },
  );
}

export async function importAgent(
  file: File,
  options: { nameOverride?: string; overwrite?: boolean },
) {
  const body = new FormData();
  body.append("file", file);
  body.append("scope", "user");
  if (options.nameOverride) body.append("name_override", options.nameOverride);
  if (options.overwrite) body.append("overwrite", "true");
  return jsonRequest<ImportAgentResult>("/api/agents/import", {
    method: "POST",
    body,
  });
}

export async function exportAgent(
  name: string,
  format: "zip" | "md",
  scope: AgentScope = "user",
) {
  const response = await authenticatedFetch(
    api(
      withScope(
        `/api/agents/${encodeURIComponent(name)}/export?format=${encodeURIComponent(format)}`,
        scope,
      ),
    ),
  );
  if (!response.ok) {
    throw new Error(await errorMessage(response, "Export failed"));
  }
  return response.blob();
}

export async function exportAgentsBatch(
  names: string[],
  scope: AgentScope = "user",
) {
  const response = await authenticatedFetch(
    api("/api/agents/batch/export"),
    jsonBody({ agent_names: names, scope }),
  );
  if (!response.ok) {
    throw new Error(await errorMessage(response, "Batch export failed"));
  }
  return response.blob();
}

export function cloneAgent(
  name: string,
  newName: string,
  scope: AgentScope = "user",
) {
  return jsonRequest(
    withScope(`/api/agents/${encodeURIComponent(name)}/clone`, scope),
    jsonBody({ new_name: newName, scope: "user" }),
  );
}

export function deletePlatformAgent(name: string) {
  return jsonRequest(
    `/api/agent-management/platform/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
}

export function batchDeleteAgents(names: string[], scope: AgentScope = "user") {
  return jsonRequest<{
    deleted: string[];
    errors: Array<{ name: string; error: string }>;
  }>("/api/agents/batch/delete", jsonBody({ agent_names: names, scope }));
}

export async function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function listAgentVersions(
  name: string,
  scope: AgentScope = "user",
) {
  const result = await jsonRequest<{ versions: AgentVersion[] }>(
    withScope(`/api/agents/${encodeURIComponent(name)}/versions`, scope),
  );
  return result.versions;
}

export function createAgentVersion(
  name: string,
  message: string,
  scope: AgentScope = "user",
) {
  return jsonRequest<AgentVersion>(
    withScope(`/api/agents/${encodeURIComponent(name)}/versions`, scope),
    jsonBody({ message }),
  );
}

export function restoreAgentVersion(
  name: string,
  versionId: string,
  scope: AgentScope = "user",
) {
  return jsonRequest(
    withScope(
      `/api/agents/${encodeURIComponent(name)}/versions/${encodeURIComponent(versionId)}/restore`,
      scope,
    ),
    { method: "POST" },
  );
}

export async function getAgentMemory(name: string, scope: AgentScope = "user") {
  const result = await jsonRequest<{ memory: Record<string, unknown> | null }>(
    withScope(`/api/agents/${encodeURIComponent(name)}/memory`, scope),
  );
  return result.memory;
}

export function updateAgentMemory(
  name: string,
  memory: Record<string, unknown>,
  scope: AgentScope = "user",
) {
  return jsonRequest(
    withScope(`/api/agents/${encodeURIComponent(name)}/memory`, scope),
    {
      ...jsonBody({ memory }),
      method: "PUT",
    },
  );
}

export function validateAgent(name: string, scope: AgentScope = "user") {
  return jsonRequest<ValidationResult>(
    withScope(`/api/agents/${encodeURIComponent(name)}/validate`, scope),
    { method: "POST" },
  );
}

export function testAgent(
  name: string,
  prompt: string,
  scope: AgentScope = "user",
) {
  return jsonRequest<AgentTestResult>(
    withScope(`/api/agents/${encodeURIComponent(name)}/test`, scope),
    jsonBody({ test_prompt: prompt }),
  );
}

export async function getAgentLogs(name: string, scope: AgentScope = "user") {
  const result = await jsonRequest<{ logs: AgentLog[] }>(
    withScope(`/api/agents/${encodeURIComponent(name)}/logs?limit=20`, scope),
  );
  return result.logs;
}

export function getAgentStats(name: string, scope: AgentScope = "user") {
  return jsonRequest<AgentStats>(
    withScope(`/api/agents/${encodeURIComponent(name)}/stats`, scope),
  );
}

export function importSubAgentPackage(
  name: string,
  file: File,
  scope: AgentScope = "user",
) {
  const body = new FormData();
  body.append("file", file);
  return jsonRequest<ImportSubAgentResult>(
    withScope(
      `/api/agents/${encodeURIComponent(name)}/import-sub-agent-package`,
      scope,
    ),
    { method: "POST", body },
  );
}

export async function listAgentSchedules(
  name: string,
  scope: AgentScope = "user",
) {
  const result = await jsonRequest<{ jobs: AgentSchedule[] }>(
    withScope(`/api/agents/${encodeURIComponent(name)}/schedules`, scope),
  );
  return result.jobs;
}

export function createAgentSchedule(
  name: string,
  body: {
    title: string;
    prompt: string;
    schedule: {
      type: "daily" | "cron";
      timezone: string;
      time?: string;
      cron_expr?: string;
    };
    enabled: boolean;
  },
  scope: AgentScope = "user",
) {
  return jsonRequest<AgentSchedule>(
    withScope(`/api/agents/${encodeURIComponent(name)}/schedules`, scope),
    jsonBody(body),
  );
}

export function deleteAgentSchedule(
  name: string,
  scheduleId: string,
  scope: AgentScope = "user",
) {
  return jsonRequest(
    withScope(
      `/api/agents/${encodeURIComponent(name)}/schedules/${encodeURIComponent(scheduleId)}`,
      scope,
    ),
    { method: "DELETE" },
  );
}

export function triggerAgentSchedule(
  name: string,
  scheduleId: string,
  scope: AgentScope = "user",
) {
  return jsonRequest(
    withScope(
      `/api/agents/${encodeURIComponent(name)}/schedules/${encodeURIComponent(scheduleId)}/trigger`,
      scope,
    ),
    { method: "POST" },
  );
}

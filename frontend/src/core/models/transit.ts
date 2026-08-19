import { getBackendBaseURL } from "../config";
import { isStaticWebsiteOnly } from "../static-mode";
import { getCsrfHeaders } from "../api/fetcher";

/**
 * API client for the Yixin/oneai transit integration.
 *
 * These endpoints are Yixin-SSO specific and intentionally kept out of the
 * generic ``models/api.ts`` so the static-model path stays untouched.
 */

export interface TransitModelInfo {
  name: string;
  display_name?: string | null;
  description?: string | null;
  supports_thinking?: boolean;
  supports_reasoning_effort?: boolean;
  /** True when the model name/display shows "免费" — surfaced first by the backend. */
  free?: boolean;
}

export interface TransitModelsResponse {
  models: TransitModelInfo[];
  default_model?: string | null;
  is_yixin_user?: boolean;
  has_api_key?: boolean;
}

/** Force-refresh the oneai model list for the current Yixin user. */
export async function refreshTransitModels(): Promise<TransitModelsResponse> {
  if (isStaticWebsiteOnly()) {
    return { models: [] };
  }

  const res = await fetch(`${getBackendBaseURL()}/api/models/refresh`, {
    method: "POST",
    credentials: "include",
    // The gateway's CSRFMiddleware rejects state-changing requests (POST) without
    // the X-CSRF-Token header — raw fetch() skips the fetcher.ts wrapper, so we
    // must attach the header explicitly or the call 403s ("CSRF token missing").
    headers: getCsrfHeaders(),
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as
      | { detail?: string }
      | null;
    throw new Error(detail?.detail ?? "刷新模型列表失败");
  }
  return (await res.json()) as TransitModelsResponse;
}

/** Persist the user's currently selected model (per-user default). */
export async function setDefaultTransitModel(model_name: string): Promise<void> {
  if (isStaticWebsiteOnly()) return;

  await fetch(`${getBackendBaseURL()}/api/users/me/default-model`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...getCsrfHeaders() },
    body: JSON.stringify({ model_name }),
  });
}

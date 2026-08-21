import { fetch } from "@/core/api/fetcher";
import { getBackendBaseURL } from "@/core/config";

import type {
  OperationsDashboard,
  OperationsDashboardDetails,
  OperationsRange,
} from "./types";

function extractErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "Failed to load operations dashboard.";
  }

  const detail = (payload as { detail?: unknown }).detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const firstMessage = detail
      .map((item) =>
        item && typeof item === "object"
          ? (item as { msg?: unknown }).msg
          : undefined,
      )
      .find((msg): msg is string => typeof msg === "string");
    return firstMessage ?? "Operations dashboard request is invalid.";
  }
  if (detail && typeof detail === "object") {
    const message = (detail as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }

  return "Failed to load operations dashboard.";
}

export async function fetchOperationsDashboard(
  range: OperationsRange,
): Promise<OperationsDashboard> {
  const tzOffsetMinutes = -new Date().getTimezoneOffset();
  const params = new URLSearchParams({
    range: String(range),
    tz_offset_minutes: String(tzOffsetMinutes),
  });
  const response = await fetch(
    `${getBackendBaseURL()}/api/operations/dashboard?${params}`,
  );
  if (!response.ok) {
    throw new Error(
      extractErrorMessage(await response.json().catch(() => null)),
    );
  }
  return (await response.json()) as OperationsDashboard;
}

export async function fetchOperationsDashboardDetails(
  range: OperationsRange,
  tzOffsetMinutes = -new Date().getTimezoneOffset(),
): Promise<OperationsDashboardDetails> {
  const params = new URLSearchParams({
    range: String(range),
    tz_offset_minutes: String(tzOffsetMinutes),
  });
  const response = await fetch(
    `${getBackendBaseURL()}/api/operations/dashboard/details?${params}`,
  );
  if (!response.ok) {
    throw new Error(
      extractErrorMessage(await response.json().catch(() => null)),
    );
  }
  return (await response.json()) as OperationsDashboardDetails;
}

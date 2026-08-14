import "server-only";

import { cookies } from "next/headers";

import { getGatewayConfig } from "@/core/auth/gateway-config";

interface SharedAgentResponse {
  runtime_name: string;
}

export async function resolveSharedAgentRuntimeName(
  publicName: string,
): Promise<string | null> {
  const session = (await cookies()).get("access_token");

  const { internalGatewayUrl } = getGatewayConfig();
  const response = await fetch(
    `${internalGatewayUrl}/api/public/agents/${encodeURIComponent(publicName)}`,
    {
      headers: session
        ? { Cookie: `access_token=${session.value}` }
        : undefined,
      cache: "no-store",
    },
  );
  if (
    response.status === 401 ||
    response.status === 403 ||
    response.status === 404
  ) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Shared Agent lookup failed (${response.status})`);
  }
  const data = (await response.json()) as SharedAgentResponse;
  return data.runtime_name || null;
}

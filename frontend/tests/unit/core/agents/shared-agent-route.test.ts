import { beforeEach, describe, expect, it, rs } from "@rstest/core";

import { resolveSharedAgentRuntimeName } from "@/core/agents/shared-agent-route";

const mocks = rs.hoisted(() => ({
  cookies: rs.fn(),
  fetch: rs.fn(),
}));

rs.mock("server-only", () => ({}));
rs.mock("next/headers", () => ({ cookies: mocks.cookies }));
rs.mock("@/core/auth/gateway-config", () => ({
  getGatewayConfig: () => ({ internalGatewayUrl: "http://gateway" }),
}));

beforeEach(() => {
  mocks.cookies.mockReset();
  mocks.fetch.mockReset();
  mocks.cookies.mockResolvedValue({
    get: () => ({ value: "session-token" }),
  });
  rs.stubGlobal("fetch", mocks.fetch);
});

describe("resolveSharedAgentRuntimeName", () => {
  it("resolves the standard public Agent runtime with the signed-in session", async () => {
    mocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ runtime_name: "public-adviser" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(resolveSharedAgentRuntimeName("adviser demo")).resolves.toBe(
      "public-adviser",
    );
    expect(mocks.fetch).toHaveBeenCalledWith(
      "http://gateway/api/public/agents/adviser%20demo",
      {
        headers: { Cookie: "access_token=session-token" },
        cache: "no-store",
      },
    );
  });

  it("returns null when the share is unavailable", async () => {
    mocks.fetch.mockResolvedValue(new Response(null, { status: 404 }));

    await expect(resolveSharedAgentRuntimeName("missing")).resolves.toBeNull();
  });
});

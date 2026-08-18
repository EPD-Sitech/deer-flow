import { beforeEach, describe, expect, it, rs } from "@rstest/core";

import {
  getAgentShare,
  getAgentFiles,
  importAgent,
  updateAgentShare,
  updateAgentFiles,
  updateAgentSettings,
} from "@/components/workspace/agent-harness/agent-management-api";

const fetchMock = rs.hoisted(() => rs.fn());

rs.mock("@/core/api/fetcher", () => ({ fetch: fetchMock }));
rs.mock("@/core/config", () => ({ getBackendBaseURL: () => "http://gateway" }));

beforeEach(() => {
  fetchMock.mockReset();
});

describe("local agent management API", () => {
  it("loads the complete editable agent files from the incremental route", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          name: "report-agent",
          config_yaml: "name: report-agent\n",
          soul: "# Reporter",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(getAgentFiles("report agent")).resolves.toMatchObject({
      soul: "# Reporter",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://gateway/api/agents/report%20agent/files?scope=user",
      undefined,
    );
  });

  it("saves config and SOUL together", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          name: "report-agent",
          config_yaml: "name: report-agent\n",
          soul: "# Reporter",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await updateAgentFiles("report-agent", {
      config_yaml: "name: report-agent\n",
      soul: "# Reporter",
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe("PUT");
    expect(typeof request.body).toBe("string");
    expect(JSON.parse(request.body as string)).toEqual({
      config_yaml: "name: report-agent\n",
      soul: "# Reporter",
    });
  });

  it("updates public Agent settings through the scoped management route", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          name: "public-agent",
          description: "Updated",
          model: null,
          tool_groups: null,
          skills: ["research"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await updateAgentSettings(
      "public agent",
      { description: "Updated", skills: ["research"] },
      "platform",
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://gateway/api/agents/public%20agent/settings?scope=platform",
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe("PUT");
    expect(JSON.parse(request.body as string)).toEqual({
      description: "Updated",
      skills: ["research"],
    });
  });

  it("imports archives as user-scoped agents", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ imported: [], errors: [] }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const file = new File(["archive"], "agent.zip", {
      type: "application/zip",
    });

    await importAgent(file, { nameOverride: "renamed", overwrite: true });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = request.body as FormData;
    expect(request.method).toBe("POST");
    expect(body.get("scope")).toBe("user");
    expect(body.get("name_override")).toBe("renamed");
    expect(body.get("overwrite")).toBe("true");
  });

  it("loads and updates explicit public sharing", async () => {
    const shareResponse = () =>
      new Response(
        JSON.stringify({
          enabled: true,
          public_slug: "report-writer",
          public_name: "report-writer",
          public_path: "/public/agent/report-writer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    fetchMock
      .mockResolvedValueOnce(shareResponse())
      .mockResolvedValueOnce(shareResponse());

    await expect(getAgentShare("report agent")).resolves.toMatchObject({
      enabled: true,
      public_name: "report-writer",
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://gateway/api/agents/report%20agent/share?scope=user",
      undefined,
    );

    await updateAgentShare("report-agent", {
      enabled: true,
      public_slug: "report-writer",
    });
    const request = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(request.method).toBe("PUT");
    expect(JSON.parse(request.body as string)).toEqual({
      enabled: true,
      public_slug: "report-writer",
    });
  });
});

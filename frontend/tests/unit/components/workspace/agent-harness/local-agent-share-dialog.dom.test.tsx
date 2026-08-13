import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { LocalAgentShareDialog } from "@/components/workspace/agent-harness/local-agent-share-dialog";

const apiMocks = rs.hoisted(() => ({
  getAgentShare: rs.fn(),
  updateAgentShare: rs.fn(),
}));

rs.mock(
  "@/components/workspace/agent-harness/agent-management-api",
  () => apiMocks,
);

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({ locale: "zh-CN" }),
}));

rs.mock("sonner", () => ({
  toast: { success: rs.fn(), error: rs.fn() },
}));

beforeEach(() => {
  apiMocks.getAgentShare.mockReset();
  apiMocks.updateAgentShare.mockReset();
  apiMocks.getAgentShare.mockResolvedValue({
    enabled: false,
    public_slug: null,
    public_name: "report-agent",
    public_path: "/public/agent/report-agent",
  });
  apiMocks.updateAgentShare.mockResolvedValue({
    enabled: true,
    public_slug: null,
    public_name: "report-agent",
    public_path: "/public/agent/report-agent",
  });
});

afterEach(() => cleanup());

describe("LocalAgentShareDialog", () => {
  it("explicitly enables a public link through the incremental API", async () => {
    render(
      <LocalAgentShareDialog
        agentName="report-agent"
        open
        onOpenChange={rs.fn()}
      />,
    );

    expect(await screen.findByText("公开链接当前未启用")).toBeTruthy();
    expect(
      screen.getByText(
        `${window.location.origin}/public/agent/report-agent`,
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "公开访问" }));

    await waitFor(() => {
      expect(apiMocks.updateAgentShare).toHaveBeenCalledWith(
        "report-agent",
        {
          enabled: true,
          public_slug: null,
        },
        "user",
      );
    });
    expect(await screen.findByText("公开链接当前有效")).toBeTruthy();
  });
});

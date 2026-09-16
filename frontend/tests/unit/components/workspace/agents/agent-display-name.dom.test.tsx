import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toast } from "sonner";

import { AgentWelcome } from "@/components/workspace/agent-welcome";
import { AgentSettingsDialog } from "@/components/workspace/agents/agent-settings-dialog";
import type { Agent } from "@/core/agents";
import { enUS } from "@/core/i18n/locales/en-US";

const { mutateAsync, updateAgentSettings } = rs.hoisted(() => ({
  mutateAsync: rs.fn().mockResolvedValue({}),
  updateAgentSettings: rs.fn().mockResolvedValue({}),
}));
rs.mock("@/core/agents", () => ({
  useUpdateAgent: () => ({ mutateAsync, isPending: false }),
}));
rs.mock("@/core/models/hooks", () => ({ useModels: () => ({ models: [] }) }));
rs.mock("@/core/subagents", () => ({
  useSubagents: () => ({ subagents: [] }),
}));
rs.mock("@/core/i18n/hooks", () => ({ useI18n: () => ({ t: enUS }) }));
rs.mock("@/core/auth/AuthProvider", () => ({
  useAuth: () => ({ user: { system_role: "admin" } }),
}));
rs.mock("@/core/mcp/hooks", () => ({
  useMCPConfig: () => ({ config: null, isLoading: false }),
}));
rs.mock("@/core/config", () => ({ getBackendBaseURL: () => "" }));
rs.mock("@/core/skills/hooks", () => ({
  useSkills: () => ({ skills: [], isLoading: false }),
}));
rs.mock("@/components/workspace/agent-harness/agent-management-api", () => ({
  updateAgentSettings,
  validateAgent: rs.fn().mockResolvedValue({ valid: true, checks: [] }),
  testAgent: rs.fn().mockResolvedValue({ response: "" }),
  getAgentStats: rs.fn().mockResolvedValue({}),
  getAgentLogs: rs.fn().mockResolvedValue([]),
  listAgentVersions: rs.fn().mockResolvedValue([]),
}));
rs.mock("../agent-harness/agent-avatar", () => ({
  AgentAvatar: () => null,
  notifyAgentAvatarUpdated: () => undefined,
}));
rs.mock("@/env", () => ({
  env: { NEXT_PUBLIC_STATIC_WEBSITE_ONLY: "false" },
}));
rs.mock("sonner", () => ({ toast: { success: rs.fn(), error: rs.fn() } }));

const agent: Agent = {
  name: "reviewer",
  display_name: "代码审查助手",
  description: "",
  model: null,
  tool_groups: null,
  skills: null,
};
afterEach(() => {
  cleanup();
  mutateAsync.mockClear();
  updateAgentSettings.mockClear();
});

function renderDialog(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AgentSettingsDialog agent={agent} open onOpenChange={rs.fn()} />
    </QueryClientProvider>,
  );
}

describe("custom agent display names", () => {
  it("accepts 100 astral code points without an HTML code-unit limit", async () => {
    renderDialog();
    const input = screen.getByLabelText("Display name");
    expect(input.hasAttribute("maxlength")).toBe(false);
    fireEvent.change(input, { target: { value: "🦌".repeat(100) } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateAgentSettings).toHaveBeenCalledWith(
        "reviewer",
        expect.objectContaining({ display_name: "🦌".repeat(100) }),
        "user",
      ),
    );
  });

  it("rejects 101 code points before saving", () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "🦌".repeat(101) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  it("shows Unicode names and falls back for legacy or cleared names", () => {
    const { rerender } = render(
      <AgentWelcome agent={agent} agentName="reviewer" />,
    );
    expect(screen.getByText("代码审查助手")).toBeTruthy();
    for (const display_name of [undefined, null, ""]) {
      rerender(
        <AgentWelcome
          agent={{ ...agent, display_name }}
          agentName="reviewer"
        />,
      );
      expect(screen.getByText("reviewer")).toBeTruthy();
    }
  });

  it("saves a display name using the stable identifier", async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "审查员 🦌" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateAgentSettings).toHaveBeenCalledWith(
        "reviewer",
        expect.objectContaining({ display_name: "审查员 🦌" }),
        "user",
      ),
    );
  });

  it("clears a blank name without renaming the agent", async () => {
    renderDialog();
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(updateAgentSettings).toHaveBeenCalledWith(
        "reviewer",
        expect.objectContaining({ display_name: null }),
        "user",
      ),
    );
  });
});

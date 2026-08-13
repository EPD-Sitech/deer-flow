import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { LocalAgentCard } from "@/components/workspace/agent-harness/local-agent-card";

const navigation = rs.hoisted(() => ({ push: rs.fn() }));

rs.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push }),
}));

rs.mock("@/core/agents", () => ({
  useDeleteAgent: () => ({ mutateAsync: rs.fn(), isPending: false }),
}));

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    locale: "zh-CN",
    t: {
      agents: {
        chat: "对话",
        settings: "模型设置",
        delete: "删除",
        deleteSuccess: "已删除",
        deleteConfirm: "确认删除？",
      },
      common: { cancel: "取消", loading: "加载中", delete: "删除" },
    },
  }),
}));

rs.mock("@/components/workspace/agents/agent-settings-dialog", () => ({
  AgentSettingsDialog: () => null,
}));

rs.mock(
  "@/components/workspace/agent-harness/local-agent-detail-dialog",
  () => ({ LocalAgentDetailDialog: () => null }),
);

afterEach(() => {
  cleanup();
  navigation.push.mockReset();
});

describe("LocalAgentCard management menu", () => {
  function renderCard(
    agent: React.ComponentProps<typeof LocalAgentCard>["agent"],
  ) {
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <LocalAgentCard agent={agent} />
      </QueryClientProvider>,
    );
  }

  async function openMenu(name: string) {
    const trigger = screen.getByRole("button", {
      name: `${name}: 更多操作`,
    });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
  }

  it("exposes migrated local management actions", async () => {
    renderCard({
      name: "report-agent",
      description: "Writes reports",
      model: null,
      tool_groups: null,
      skills: null,
      can_view_details: true,
      can_edit_guide_questions: false,
    });
    await openMenu("report-agent");

    expect(screen.getByText("详情编辑")).toBeTruthy();
    expect(screen.getByText("分享公开链接")).toBeTruthy();
    expect(screen.getByText("定时任务")).toBeTruthy();
    expect(screen.getByText("克隆")).toBeTruthy();
    expect(screen.getByText("导出 ZIP")).toBeTruthy();
    expect(screen.getByText("导出 Markdown")).toBeTruthy();
    expect(screen.getByText("模型设置")).toBeTruthy();
  });

  it("limits a public Agent to read-only details for regular users", async () => {
    renderCard({
      name: "public-report-agent",
      description: "Public reports",
      model: null,
      tool_groups: null,
      skills: null,
      runtime_name: "public-report-agent",
      scope: "platform",
      can_manage: false,
      can_view_details: true,
      can_edit_guide_questions: true,
      can_edit: false,
      can_delete: false,
      can_export: false,
      can_clone: false,
      can_share: false,
      can_batch: false,
    });
    await openMenu("public-report-agent");

    expect(screen.getByText("查看详情")).toBeTruthy();
    expect(screen.queryByText("克隆")).toBeNull();
    expect(screen.queryByText("导出 ZIP")).toBeNull();
    expect(screen.queryByText("导出 Markdown")).toBeNull();
    expect(screen.queryByText("分享公开链接")).toBeNull();
    expect(screen.queryByText("详情编辑")).toBeNull();
    expect(screen.queryByText("定时任务")).toBeNull();
    expect(screen.queryByText("模型设置")).toBeNull();
    expect(screen.queryByText("删除")).toBeNull();
  });

  it("shows public Agent management actions to administrators", async () => {
    renderCard({
      name: "public-admin-agent",
      description: "Admin managed",
      model: null,
      tool_groups: null,
      skills: null,
      runtime_name: "public-admin-agent",
      scope: "platform",
      can_manage: true,
      can_view_details: true,
      can_edit_guide_questions: false,
      can_edit: true,
      can_delete: true,
      can_export: true,
      can_clone: true,
      can_share: true,
      can_batch: true,
    });
    await openMenu("public-admin-agent");

    expect(screen.getByText("分享公开链接")).toBeTruthy();
    expect(screen.getByText("详情编辑")).toBeTruthy();
    expect(screen.getByText("定时任务")).toBeTruthy();
    expect(screen.getByText("模型设置")).toBeTruthy();
    expect(screen.getByText("删除")).toBeTruthy();
  });

  it("uses the runtime alias to chat with a Chinese public Agent", async () => {
    renderCard({
      name: "ai产品经理培训答疑",
      runtime_name: "agent-0123456789abcdef",
      description: "产品经理培训答疑",
      model: null,
      tool_groups: null,
      skills: null,
      scope: "platform",
      can_manage: false,
      can_view_details: true,
      can_edit_guide_questions: false,
      can_edit: false,
      can_delete: false,
      can_export: false,
      can_clone: false,
      can_share: false,
      can_batch: false,
    });

    fireEvent.click(screen.getByTitle("与 ai产品经理培训答疑 对话"));
    expect(navigation.push).toHaveBeenCalledWith(
      "/workspace/agents/agent-0123456789abcdef/chats/new",
    );

    await openMenu("ai产品经理培训答疑");
    expect(screen.getByRole("menuitem", { name: "查看详情" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "克隆" })).toBeNull();
  });
});

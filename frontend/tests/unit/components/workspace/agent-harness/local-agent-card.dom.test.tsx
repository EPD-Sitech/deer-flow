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
  AgentSettingsDialog: ({ scope }: { scope?: string }) => (
    <div data-testid="agent-settings-dialog" data-scope={scope} />
  ),
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

    expect(screen.getByText("编辑")).toBeTruthy();
    expect(screen.getByText("分享")).toBeTruthy();
    expect(screen.getByText("定时")).toBeTruthy();
    expect(screen.getByText("克隆")).toBeTruthy();
    expect(screen.getAllByText("导出")).toHaveLength(1);
    expect(screen.queryByText("导出 Markdown")).toBeNull();
    expect(screen.getByText("模型设置")).toBeTruthy();

    fireEvent.click(screen.getByText("模型设置"));
    expect(
      screen.getByTestId("agent-settings-dialog").getAttribute("data-scope"),
    ).toBe("user");
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
      guide_questions: [
        { question: "学习", prompt: "请帮我制定学习计划" },
        { question: "岗位职责" },
        { question: "什么是真需求" },
        { question: "这条不应展示" },
      ],
    });
    expect(
      screen.queryByRole("button", {
        name: "public-report-agent: 更多操作",
      }),
    ).toBeNull();
    expect(screen.queryByText("克隆")).toBeNull();
    expect(screen.queryByText("导出")).toBeNull();
    expect(screen.queryByText("分享")).toBeNull();
    expect(screen.queryByText("编辑")).toBeNull();
    expect(screen.queryByText("定时")).toBeNull();
    expect(screen.queryByText("模型设置")).toBeNull();
    expect(screen.queryByText("删除")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /public-report-agent/ }),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("专家简介")).toBeTruthy();
    expect(screen.getByText("核心能力")).toBeTruthy();
    expect(screen.getByText("可以这样问")).toBeTruthy();
    expect(screen.getByRole("button", { name: "学习" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "岗位职责" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "什么是真需求" })).toBeTruthy();
    expect(screen.queryByText("这条不应展示")).toBeNull();
    expect(screen.queryByText("配置与角色")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "学习" }));
    expect(navigation.push).toHaveBeenCalledWith(
      "/workspace/agents/public-report-agent/chats/new?prompt=%E8%AF%B7%E5%B8%AE%E6%88%91%E5%88%B6%E5%AE%9A%E5%AD%A6%E4%B9%A0%E8%AE%A1%E5%88%92",
    );
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

    expect(screen.getByText("分享")).toBeTruthy();
    expect(screen.getByText("编辑")).toBeTruthy();
    expect(screen.getByText("定时")).toBeTruthy();
    expect(screen.getAllByText("导出")).toHaveLength(1);
    expect(screen.getByText("模型设置")).toBeTruthy();
    expect(screen.getByText("删除")).toBeTruthy();

    fireEvent.click(screen.getByText("模型设置"));
    expect(
      screen.getByTestId("agent-settings-dialog").getAttribute("data-scope"),
    ).toBe("platform");
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

    expect(
      screen.queryByRole("button", {
        name: "ai产品经理培训答疑: 更多操作",
      }),
    ).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "克隆" })).toBeNull();
  });
});

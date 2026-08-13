import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { LocalAgentGallery } from "@/components/workspace/agent-harness/local-agent-gallery";

const agentsState = rs.hoisted(() => ({
  publicCanManage: false,
  agents: [
    {
      name: "sql-analyst",
      description: "Analyze business data",
      model: null,
      tool_groups: ["database"],
      skills: null,
      runtime_name: "sql-analyst",
      scope: "user",
      can_manage: true,
      can_view_details: true,
      can_edit_guide_questions: true,
      can_edit: true,
      can_delete: true,
      can_export: true,
      can_clone: true,
      can_share: true,
      can_batch: true,
    },
    {
      name: "meeting-assistant",
      description: "Create meeting notes",
      model: null,
      tool_groups: null,
      skills: ["documents"],
      runtime_name: "meeting-assistant",
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
    },
  ],
}));

rs.mock("@/components/workspace/agent-harness/agent-management-api", () => ({
  listAgentCatalog: () =>
    Promise.resolve(
      agentsState.agents.map((agent) =>
        agent.scope === "platform"
          ? {
              ...agent,
              can_manage: agentsState.publicCanManage,
              can_edit: agentsState.publicCanManage,
              can_delete: agentsState.publicCanManage,
              can_share: agentsState.publicCanManage,
              can_batch: agentsState.publicCanManage,
            }
          : agent,
      ),
    ),
}));

rs.mock("next/navigation", () => ({
  useRouter: () => ({ push: rs.fn() }),
}));

rs.mock("@/core/i18n/hooks", () => ({
  useI18n: () => ({
    locale: "zh-CN",
    t: {
      agents: {
        description: "创建和管理具有专属能力的自定义智能体。",
        newAgent: "新建智能体",
        emptyTitle: "还没有自定义智能体",
        emptyDescription: "创建你的第一个自定义智能体。",
      },
      common: { loading: "加载中" },
    },
  }),
}));

rs.mock("@/components/workspace/agent-harness/local-agent-card", () => ({
  LocalAgentCard: ({
    agent,
  }: {
    agent: { name: string; can_manage: boolean };
  }) => (
    <article>
      <span>{agent.name}</span>
      {agent.can_manage && <span>{agent.name}-manageable</span>}
    </article>
  ),
}));

afterEach(() => {
  cleanup();
  agentsState.publicCanManage = false;
});

describe("LocalAgentGallery", () => {
  function renderGallery() {
    return render(
      <QueryClientProvider client={new QueryClient()}>
        <LocalAgentGallery />
      </QueryClientProvider>,
    );
  }

  it("renders only the local agent experience", async () => {
    renderGallery();

    expect(screen.getByText("召唤专家")).toBeTruthy();
    expect(screen.getByText("召唤你的专属业务专家伙伴")).toBeTruthy();
    expect(await screen.findByText("sql-analyst")).toBeTruthy();
    expect(await screen.findByText("meeting-assistant")).toBeTruthy();
    expect(screen.getByRole("button", { name: "导入" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "公共" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "自定义" })).toBeTruthy();
    expect(screen.queryByText("远程 Agent")).toBeNull();
    expect(screen.queryByText("模板市场")).toBeNull();
  });

  it("filters local agents by search text", async () => {
    renderGallery();

    await screen.findByText("sql-analyst");

    fireEvent.change(screen.getByPlaceholderText("搜索专家或描述"), {
      target: { value: "meeting" },
    });

    expect(screen.queryByText("sql-analyst")).toBeNull();
    expect(screen.getByText("meeting-assistant")).toBeTruthy();
  });

  it("filters public and custom local agents by scope", async () => {
    renderGallery();
    await screen.findByText("sql-analyst");

    fireEvent.click(screen.getByRole("button", { name: "公共" }));
    expect(screen.queryByText("sql-analyst")).toBeNull();
    expect(screen.getByText("meeting-assistant")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "自定义" }));
    expect(screen.getByText("sql-analyst")).toBeTruthy();
    expect(screen.queryByText("meeting-assistant")).toBeNull();
  });

  it("passes administrator management permission to public cards", async () => {
    agentsState.publicCanManage = true;
    renderGallery();
    expect(
      await screen.findByText("meeting-assistant-manageable"),
    ).toBeTruthy();
  });
});

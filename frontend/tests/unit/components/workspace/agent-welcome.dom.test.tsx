import { describe, expect, it } from "@rstest/core";
import { render, screen } from "@testing-library/react";

import { AgentWelcome } from "@/components/workspace/agent-welcome";

describe("AgentWelcome", () => {
  it("prefers the platform display name over the runtime name", () => {
    render(
      <AgentWelcome
        agent={{
          name: "agent-2776d1f2c2ef7f60",
          display_name: "产品经理培训答疑",
          description: "回答产品经理培训问题",
          model: null,
          tool_groups: null,
          skills: null,
        }}
        agentName="agent-2776d1f2c2ef7f60"
      />,
    );

    expect(screen.getByText("产品经理培训答疑")).toBeTruthy();
    expect(screen.queryByText("agent-2776d1f2c2ef7f60")).toBeNull();
  });
});

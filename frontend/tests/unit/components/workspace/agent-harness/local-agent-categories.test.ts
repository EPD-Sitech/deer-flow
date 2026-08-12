import { describe, expect, it } from "@rstest/core";

import {
  ALL_LOCAL_AGENT_CATEGORY,
  getLocalAgentCategoryIds,
  localAgentMatchesCategory,
} from "@/components/workspace/agent-harness/local-agent-categories";
import type { Agent } from "@/core/agents";

function agent(overrides: Partial<Agent>): Agent {
  return {
    name: "general-agent",
    description: "",
    model: null,
    tool_groups: null,
    skills: null,
    ...overrides,
  };
}

describe("local agent categories", () => {
  it("infers a business category from the agent's searchable metadata", () => {
    const dataAgent = agent({
      name: "sql-analyst",
      description: "Builds charts and analyzes warehouse data",
      tool_groups: ["database"],
    });

    expect(getLocalAgentCategoryIds(dataAgent)).toEqual(["data_analysis"]);
    expect(localAgentMatchesCategory(dataAgent, "data_analysis")).toBe(true);
  });

  it("places unmatched agents in other while all matches every agent", () => {
    const generalAgent = agent({ description: "A flexible specialist" });

    expect(getLocalAgentCategoryIds(generalAgent)).toEqual(["other"]);
    expect(
      localAgentMatchesCategory(generalAgent, ALL_LOCAL_AGENT_CATEGORY),
    ).toBe(true);
  });
});

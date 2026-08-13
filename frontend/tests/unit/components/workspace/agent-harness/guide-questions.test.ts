import { describe, expect, it } from "@rstest/core";

import { validateAgentGuideQuestions } from "@/components/workspace/agent-harness/guide-questions";

describe("agent guide questions", () => {
  it("rejects incomplete and excessive questions", () => {
    expect(validateAgentGuideQuestions([{ question: "" }])).toContain(
      "缺少问题文案",
    );
    expect(
      validateAgentGuideQuestions(
        Array.from({ length: 7 }, (_, index) => ({
          question: `问题 ${index + 1}`,
        })),
      ),
    ).toContain("最多配置 6 条");
  });
});

import { describe, expect, it, rs } from "@rstest/core";
import { fireEvent, render, screen } from "@testing-library/react";

import { LocalAgentGuideQuestions } from "@/components/workspace/agent-harness/local-agent-guide-questions";

describe("LocalAgentGuideQuestions", () => {
  it("renders the shared question layout and selects the configured prompt", () => {
    const onSelect = rs.fn();
    render(
      <LocalAgentGuideQuestions
        className="absolute top-full right-0 left-0"
        questions={[{ question: "帮我分析报告", prompt: "分析附件中的报告" }]}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByText("试试这样问")).toBeTruthy();
    expect(screen.getByText("试试这样问").closest("section")?.className).toContain(
      "absolute top-full",
    );
    fireEvent.click(screen.getByRole("button", { name: "帮我分析报告" }));
    expect(onSelect).toHaveBeenCalledWith("分析附件中的报告");
  });

  it("renders duplicate question labels without a React key warning", () => {
    const consoleError = rs
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    render(
      <LocalAgentGuideQuestions
        questions={[
          { question: "生成旅游攻略 HTML", prompt: "生成版本一" },
          { question: "生成旅游攻略 HTML", prompt: "生成版本二" },
        ]}
        onSelect={rs.fn()}
      />,
    );

    expect(screen.getAllByRole("button", { name: "生成旅游攻略 HTML" })).toHaveLength(2);
    expect(consoleError).not.toHaveBeenCalled();
  });
});

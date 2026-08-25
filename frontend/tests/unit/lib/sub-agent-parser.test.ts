import { describe, expect, it } from "@rstest/core";

import { parseSubAgentsFromSoul } from "@/lib/sub-agent-parser";

describe("parseSubAgentsFromSoul", () => {
  it("parses importer-generated headings without inline frontmatter", () => {
    const soul = `# Parent agent

## Sub-Agents

### yx-fund-advisor

Route fund questions.

## Routing details

### Priority rules

Use the first matching route.

### yx-fund-strategist

Review a fund and give a conclusion.

### Output rules

Keep the answer concise.
`;

    expect(parseSubAgentsFromSoul(soul)).toEqual([
      {
        displayName: "yx-fund-advisor",
        name: "yx-fund-advisor",
        tools: [],
        prompt: `Route fund questions.

## Routing details

### Priority rules

Use the first matching route.`,
      },
      {
        displayName: "yx-fund-strategist",
        name: "yx-fund-strategist",
        tools: [],
        prompt: `Review a fund and give a conclusion.

### Output rules

Keep the answer concise.`,
      },
    ]);
  });
});

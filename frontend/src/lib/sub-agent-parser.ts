import type { SubAgentInfo } from "@/core/agents/types";

/**
 * Parse sub-agent definitions from the agent's SOUL.md content.
 * Supports both Chinese and English section headings used by harness.
 */
export function parseSubAgentsFromSoul(soulContent: string): SubAgentInfo[] {
  if (!soulContent) return [];

  const sectionMatch =
    /(?:^|\n)##\s+(?:子智能体定义|Sub-Agents)\s*\n([\s\S]*?)(?=\n##\s|\n#\s|$)/.exec(
      soulContent,
    );
  const section = sectionMatch?.[1];
  if (!section) return [];

  const agents: SubAgentInfo[] = [];
  const agentPattern = /###\s+(.+?)(?:\n|$)([\s\S]*?)(?=###\s+|$)/g;
  let match: RegExpExecArray | null;

  while ((match = agentPattern.exec(section)) !== null) {
    const title = match[1]?.trim() ?? "";
    const body = match[2]?.trim() ?? "";
    const frontmatter = /^---\s*\n([\s\S]*?)\n---/.exec(body);
    let name = "";
    let tools: string[] = [];

    if (frontmatter?.[1]) {
      const nameMatch = /(?:^|\n)name:\s*(.+)$/.exec(frontmatter[1]);
      name = nameMatch?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
      const toolsMatch = /(?:^|\n)tools:\s*\n([\s\S]*?)(?=\n[a-z_]+:|\n---|$)/.exec(
        frontmatter[1],
      );
      tools = (toolsMatch?.[1] ?? "")
        .split("\n")
        .map((line) => line.replace(/^-\s*/, "").trim())
        .filter(Boolean)
        .map((tool) => tool.replace(/^["']|["']$/g, ""));
    } else {
      name = /\(([^)]+)\)$/.exec(title)?.[1]?.trim() ?? "";
    }

    if (!name) continue;
    const displayName = title.split("(")[0]?.trim() ?? name;
    const prompt = frontmatter
      ? body.slice(frontmatter[0].length).trim()
      : body;

    agents.push({ displayName, name, tools, prompt });
  }

  return agents;
}

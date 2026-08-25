import type { SubAgentInfo } from "@/core/agents/types";

/**
 * Parse sub-agent definitions from the agent's SOUL.md content.
 * Supports both Chinese and English section headings used by harness.
 */
export function parseSubAgentsFromSoul(soulContent: string): SubAgentInfo[] {
  if (!soulContent) return [];

  const sectionMatch = /(?:^|\n)##\s+(?:子智能体定义|Sub-Agents)\s*\n/.exec(
    soulContent,
  );
  if (sectionMatch?.index === undefined) return [];
  const section = soulContent.slice(
    sectionMatch.index + sectionMatch[0].length,
  );

  // Imported packages contain full Markdown documents. Their bodies may have
  // their own `##`/`###` headings, so a plain "next heading" split would
  // truncate the first sub-agent and hide the rest. First identify headings
  // that look like actual sub-agent definitions, then use only those headings
  // as boundaries.
  const headings = Array.from(
    section.matchAll(/^###\s+(.+?)\s*$/gm),
  ).map((match) => ({
    title: match[1]?.trim() ?? "",
    index: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  const candidates = headings.filter((heading, index) => {
    const nextHeading = headings[index + 1];
    const body = section.slice(heading.end, nextHeading?.index).trim();
    if (/\(([^)]+)\)$/.test(heading.title)) return true;
    if (/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(heading.title)) return true;
    return /^---\s*\n[\s\S]*?\n---/.test(body);
  });

  const agents: SubAgentInfo[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const nextCandidate = candidates[index + 1];
    const title = candidate.title;
    const body = section.slice(candidate.end, nextCandidate?.index).trim();
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
      // The sub-agent package importer emits headings from the frontmatter
      // name and stores the frontmatter separately from the merged SOUL
      // content. In that format the heading itself is the stable identifier.
      name = /\(([^)]+)\)$/.exec(title)?.[1]?.trim() ?? title;
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

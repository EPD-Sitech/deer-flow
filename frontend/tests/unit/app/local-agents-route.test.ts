import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "@rstest/core";

function readProjectFile(path: string): string {
  return readFileSync(resolve(__dirname, "../../../", path), "utf8");
}

describe("local agents route migration", () => {
  it("runs the exact agents rewrite before filesystem routes", () => {
    const nextConfig = readProjectFile("next.config.js");

    expect(nextConfig).toMatch(
      /const beforeFiles = \[\s*\{\s*source: "\/workspace\/agents",\s*destination: "\/workspace\/agents\/local",/,
    );
    expect(nextConfig).toContain(
      "return { beforeFiles, afterFiles, fallback: [] }",
    );
  });

  it("anchors Turbopack's Tailwind import to the frontend package", () => {
    const nextConfig = readProjectFile("next.config.js");

    expect(nextConfig).toContain("resolveAlias");
    expect(nextConfig).toContain("tailwindcss:");
    expect(nextConfig).toContain(
      'new URL("./node_modules/tailwindcss", import.meta.url)',
    );
  });

  it("keeps the original page intact behind the migrated route", () => {
    const originalPage = readProjectFile("src/app/workspace/agents/page.tsx");
    const migratedPage = readProjectFile(
      "src/app/workspace/agents/local/page.tsx",
    );

    expect(originalPage).toContain(
      'from "@/components/workspace/agents/agent-gallery"',
    );
    expect(migratedPage).toContain(
      'from "@/components/workspace/agent-harness/local-agent-gallery"',
    );
  });
});

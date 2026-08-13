import { expect, test } from "@rstest/core";

import { brandedAboutMarkdown } from "@/components/workspace/settings/branded-about-content";

test("runtime about content uses the product brand", () => {
  expect(brandedAboutMarkdown).toContain("易信Trade AI");
  expect(brandedAboutMarkdown).not.toMatch(/deer[ -]?flow/i);
});

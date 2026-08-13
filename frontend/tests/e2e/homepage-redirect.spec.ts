import { expect, test } from "@playwright/test";

import { mockLangGraphAPI } from "./utils/mock-api";

test.describe("Homepage redirect", () => {
  test("redirects to the new conversation page when authenticated", async ({
    page,
  }) => {
    mockLangGraphAPI(page);

    await page.goto("/");

    // The landing route is hidden — "/" bounces straight to the workspace
    // entry point. (E2E runs with DEER_FLOW_AUTH_DISABLED=1, so the SSR
    // guard treats the visitor as authenticated.)
    await page.waitForURL("**/workspace/chats/new");
    await expect(page).toHaveURL(/\/workspace\/chats\/new/);
  });
});

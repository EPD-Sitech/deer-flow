import { redirect } from "next/navigation";

import { getServerSideUser } from "@/core/auth/server";
import { assertNever } from "@/core/auth/types";
import { DEMO_THREAD_IDS } from "@/core/threads/static-demo";
import { env } from "@/env";

export const dynamic = "force-dynamic";

/**
 * Homepage — hidden landing route.
 *
 * "/" no longer renders the landing page; it redirects straight to the
 * authenticated workspace entry point (the new-conversation page) and to
 * /login when no session exists.  The landing page components stay in the
 * tree because blog/docs layouts reuse the Header/Footer.
 */
export default async function HomePage() {
  const result = await getServerSideUser();

  switch (result.tag) {
    case "authenticated":
      // Static website mode has no real auth — keep the canonical demo thread
      // as the single entry point (mirrors the /workspace redirect).
      if (env.NEXT_PUBLIC_STATIC_WEBSITE_ONLY === "true") {
        return redirect(`/workspace/chats/${DEMO_THREAD_IDS[0]}`);
      }
      return redirect("/workspace/chats/new");
    case "needs_setup":
      redirect("/setup");
    case "system_setup_required":
      redirect("/setup");
    case "unauthenticated":
      redirect("/login");
    case "gateway_unavailable":
      // The login page probes setup status and surfaces a retry UI when the
      // gateway is unreachable, so landing there beats a dead end at "/".
      redirect("/login");
    case "config_error":
      throw new Error(result.message);
    default:
      assertNever(result);
  }
}

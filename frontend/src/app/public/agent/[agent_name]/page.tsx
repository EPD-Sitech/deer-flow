import { notFound, redirect } from "next/navigation";

import { resolveSharedAgentRuntimeName } from "@/core/agents/shared-agent-route";
import { getServerSideUser } from "@/core/auth/server";
import { buildLoginUrl } from "@/core/auth/types";

export default async function PublicAgentPage({
  params,
}: {
  params: Promise<{ agent_name: string }>;
}) {
  const { agent_name: publicName } = await params;
  const publicPath = `/public/agent/${encodeURIComponent(publicName)}`;
  const auth = await getServerSideUser();
  if (auth.tag === "unauthenticated") redirect(buildLoginUrl(publicPath));
  if (auth.tag === "needs_setup" || auth.tag === "system_setup_required") {
    redirect("/setup");
  }
  if (auth.tag === "config_error") throw new Error(auth.message);
  if (auth.tag === "gateway_unavailable")
    throw new Error("Gateway unavailable");

  const runtimeName = await resolveSharedAgentRuntimeName(publicName);
  if (!runtimeName) notFound();
  redirect(`/workspace/agents/${encodeURIComponent(runtimeName)}/chats/new`);
}

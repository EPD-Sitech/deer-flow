import { PublicLocalAgentPage } from "@/components/workspace/agent-harness/public-local-agent-page";

export default async function PublicAgentPage({
  params,
}: {
  params: Promise<{ agent_name: string }>;
}) {
  const { agent_name: publicName } = await params;
  return <PublicLocalAgentPage publicName={publicName} />;
}

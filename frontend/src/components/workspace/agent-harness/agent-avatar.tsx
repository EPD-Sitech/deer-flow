import { useState, type ImgHTMLAttributes } from "react";

import { getBackendBaseURL } from "@/core/config";

export const AGENT_AVATAR_UPDATED_EVENT = "deerflow:agent-avatar-updated";

const DEFAULT_AVATARS = [
  "expert-01.png",
  "expert-02.png",
  "expert-03.png",
  "expert-04.png",
  "expert-05.png",
  "expert-06.png",
  "expert-07.png",
  "expert-08.png",
  "expert-09.png",
  "expert-10.png",
  "financial-quant-expert.png",
  "frontend-design-expert.png",
  "risk-control-expert.png",
] as const;

const SPECIAL_AVATARS: Record<string, string> = {
  "financial-quant-expert": "financial-quant-expert.png",
  "frontend-design-expert": "frontend-design-expert.png",
  "risk-control-expert": "risk-control-expert.png",
};

function hashName(name: string) {
  return Array.from(name).reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7);
}

export function getDefaultAgentAvatar(name: string) {
  return `/images/agent-avatars/${SPECIAL_AVATARS[name] ?? DEFAULT_AVATARS[hashName(name) % DEFAULT_AVATARS.length]}`;
}

export function getAgentAvatarUrl(name: string, scope: "user" | "platform" = "user") {
  return `${getBackendBaseURL()}/api/agents/${encodeURIComponent(name)}/avatar?scope=${scope}`;
}

export function notifyAgentAvatarUpdated(name: string, scope: "user" | "platform") {
  window.dispatchEvent(
    new CustomEvent(AGENT_AVATAR_UPDATED_EVENT, { detail: { name, scope } }),
  );
}

export function AgentAvatar({
  name,
  scope = "user",
  version = 0,
  ...props
}: Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "onError"> & {
  name: string;
  scope?: "user" | "platform";
  version?: number;
}) {
  const [failedVersion, setFailedVersion] = useState<number | null>(null);
  const failed = failedVersion === version;
  return (
    <img
      {...props}
      alt={props.alt ?? ""}
      src={failed ? getDefaultAgentAvatar(name) : `${getAgentAvatarUrl(name, scope)}&v=${version}`}
      onError={() => setFailedVersion(version)}
    />
  );
}

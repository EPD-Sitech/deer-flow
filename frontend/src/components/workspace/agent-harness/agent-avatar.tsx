import { useState, type ImgHTMLAttributes } from "react";

import { getBackendBaseURL } from "@/core/config";

export const AGENT_AVATAR_UPDATED_EVENT = "deerflow:agent-avatar-updated";

const DEFAULT_AVATARS = [
  "expert-01.jpg",
  "expert-02.jpg",
  "expert-03.jpg",
  "expert-04.jpg",
  "expert-05.jpg",
  "expert-06.jpg",
  "expert-07.jpg",
  "expert-08.jpg",
  "expert-09.jpg",
  "expert-10.jpg",
  "financial-quant-expert.jpg",
  "frontend-design-expert.jpg",
  "risk-control-expert.jpg",
] as const;

const SPECIAL_AVATARS: Record<string, string> = {
  "financial-quant-expert": "financial-quant-expert.jpg",
  "frontend-design-expert": "frontend-design-expert.jpg",
  "risk-control-expert": "risk-control-expert.jpg",
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
      onLoad={(event) => {
        if (event.currentTarget.naturalWidth === 0) setFailedVersion(version);
      }}
      onError={() => setFailedVersion(version)}
    />
  );
}

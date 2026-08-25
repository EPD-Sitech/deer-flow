"use client";

import { useEffect, useState } from "react";

import { type Agent } from "@/core/agents";
import { cn } from "@/lib/utils";

import {
  AGENT_AVATAR_UPDATED_EVENT,
  AgentAvatar,
} from "./agent-harness/agent-avatar";

export function AgentWelcome({
  className,
  agent,
  agentName,
  scope,
}: {
  className?: string;
  agent: Agent | null | undefined;
  agentName: string;
  scope?: "user" | "platform";
}) {
  const [avatarVersion, setAvatarVersion] = useState(0);
  const avatarScope = scope ?? "user";
  useEffect(() => {
    const handleUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ name?: string; scope?: string }>).detail;
      if (detail?.name === agentName && detail.scope === avatarScope) setAvatarVersion((value) => value + 1);
    };
    window.addEventListener(AGENT_AVATAR_UPDATED_EVENT, handleUpdate);
    return () => window.removeEventListener(AGENT_AVATAR_UPDATED_EVENT, handleUpdate);
  }, [agentName, avatarScope]);
  const displayName = agent?.display_name ?? agent?.name ?? agentName;
  const description = agent?.description;

  return (
    <div
      className={cn(
        "mx-auto flex w-full flex-col items-center justify-center gap-2 px-8 py-4 text-center",
        className,
      )}
    >
      <div className="flex max-w-full items-center justify-center gap-3">
        <div className="bg-primary/10 flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full">
          <AgentAvatar
            name={agentName}
            scope={avatarScope}
            version={avatarVersion}
            alt=""
            className="size-full object-cover"
          />
        </div>
        <div className="min-w-0 truncate text-2xl font-bold">
          {displayName}
        </div>
      </div>
      {description && (
        <p className="text-muted-foreground max-w-sm text-sm">{description}</p>
      )}
    </div>
  );
}

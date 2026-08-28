"use client";

import { ArrowRightIcon, MessageSquareIcon } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Agent } from "@/core/agents";
import { useI18n } from "@/core/i18n/hooks";

import { AgentAvatar } from "./agent-avatar";
import type { AgentScope, LocalAgentCatalogItem } from "./agent-management-api";

interface LocalAgentOverviewDialogProps {
  agent: Agent | LocalAgentCatalogItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: AgentScope;
  accent: string;
  categoryLabel: string;
  capabilities: string[];
  onStartChat: (prompt?: string) => void;
}

export function LocalAgentOverviewDialog({
  agent,
  open,
  onOpenChange,
  scope,
  accent,
  categoryLabel,
  capabilities,
  onStartChat,
}: LocalAgentOverviewDialogProps) {
  const { locale } = useI18n();
  const zh = locale.startsWith("zh");
  const guideQuestions =
    "guide_questions" in agent && Array.isArray(agent.guide_questions)
      ? agent.guide_questions.slice(0, 3)
      : [];
  const scopeLabel =
    scope === "platform" ? (zh ? "公共" : "Public") : zh ? "自定义" : "Custom";
  const displayName = agent.display_name ?? agent.name;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-hidden rounded-2xl border-border bg-popover p-0 shadow-[0_30px_80px_rgb(0_0_0_/_0.3)] sm:top-[40%] sm:max-w-[700px]">
        <DialogHeader className="flex-row items-center gap-3 border-b border-border bg-muted/40 px-6 py-5 pr-14 text-left">
          <AgentAvatar
            name={agent.name}
            scope={scope}
            alt=""
            className="size-16 shrink-0 rounded-full border-2 border-background object-cover shadow-sm"
          />
          <div className="min-w-0">
            <DialogTitle className="truncate text-xl text-foreground">
              {displayName}
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs text-muted-foreground">
              {categoryLabel} · {scopeLabel}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="max-h-[calc(100dvh-10rem)] overflow-y-auto px-6 py-5">
          <section>
            <h3 className="text-xs font-semibold text-foreground">
              {zh ? "专家简介" : "About this expert"}
            </h3>
            <p className="mt-2 text-xs leading-6 text-muted-foreground">
              {agent.description ||
                (zh
                  ? "为复杂业务任务提供专业分析与执行支持。"
                  : "Specialized analysis and execution for complex tasks.")}
            </p>
          </section>

          <section className="mt-4">
            <h3 className="text-xs font-semibold text-foreground">
              {zh ? "核心能力" : "Core capabilities"}
            </h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {capabilities.map((capability) => (
                <span
                  key={capability}
                  className="rounded-full border px-2.5 py-1 text-[10px] font-medium"
                  style={{
                    backgroundColor: `${accent}14`,
                    borderColor: `${accent}55`,
                    color: accent,
                  }}
                >
                  {capability}
                </span>
              ))}
            </div>
          </section>

          {guideQuestions.length > 0 && (
            <section className="mt-5">
              <h3 className="text-xs font-semibold text-foreground">
                {zh ? "可以这样问" : "Try asking"}
              </h3>
              <div className="mt-2 space-y-2">
                {guideQuestions.map((guideQuestion) => (
                  <button
                    key={`${guideQuestion.question}:${guideQuestion.prompt ?? ""}`}
                    type="button"
                    className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-4 rounded-lg border border-border bg-muted/35 px-3.5 text-left text-xs text-muted-foreground transition-colors hover:border-primary/30 hover:bg-accent hover:text-foreground focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
                    onClick={() =>
                      onStartChat(
                        guideQuestion.prompt ?? guideQuestion.question,
                      )
                    }
                  >
                    <span>{guideQuestion.question}</span>
                    <ArrowRightIcon className="size-3.5 shrink-0" />
                  </button>
                ))}
              </div>
            </section>
          )}

          <div className="mt-5 flex justify-end">
            <button
              type="button"
              className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg px-4 text-xs font-medium shadow-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
              onClick={() => onStartChat()}
            >
              <MessageSquareIcon className="size-4" />
              {zh ? "开始对话" : "Start chat"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

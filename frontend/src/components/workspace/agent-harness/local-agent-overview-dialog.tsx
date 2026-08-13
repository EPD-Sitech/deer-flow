"use client";

import { ArrowRightIcon, BotIcon, MessageSquareIcon } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Agent } from "@/core/agents";
import { useI18n } from "@/core/i18n/hooks";

import type { AgentScope, LocalAgentCatalogItem } from "./agent-management-api";

interface LocalAgentOverviewDialogProps {
  agent: Agent | LocalAgentCatalogItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: AgentScope;
  accent: string;
  tint: string;
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
  tint,
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-hidden rounded-2xl border bg-background p-0 shadow-[0_30px_80px_rgba(12,38,61,0.25)] sm:top-[40%] sm:max-w-[700px]">
        <DialogHeader className="bg-muted/40 flex-row items-center gap-3 px-6 py-5 pr-14 text-left">
          <div
            className="grid size-16 shrink-0 place-items-center rounded-full border-2 border-white shadow-sm dark:border-slate-700"
            style={{ backgroundColor: tint, color: accent }}
            aria-hidden="true"
          >
            <BotIcon className="size-7" />
          </div>
          <div className="min-w-0">
            <DialogTitle className="text-foreground truncate text-xl">
              {agent.name}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground mt-1 text-xs">
              {categoryLabel} · {scopeLabel}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="max-h-[calc(100dvh-10rem)] overflow-y-auto px-6 py-5">
          <section>
            <h3 className="text-foreground text-xs font-semibold">
              {zh ? "专家简介" : "About this expert"}
            </h3>
            <p className="text-muted-foreground mt-2 text-xs leading-6">
              {agent.description ||
                (zh
                  ? "为复杂业务任务提供专业分析与执行支持。"
                  : "Specialized analysis and execution for complex tasks.")}
            </p>
          </section>

          <section className="mt-4">
            <h3 className="text-foreground text-xs font-semibold">
              {zh ? "核心能力" : "Core capabilities"}
            </h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {capabilities.map((capability) => (
                <span
                  key={capability}
                  className="rounded-full border px-2.5 py-1 text-[10px] font-medium"
                  style={{ borderColor: `${accent}35`, color: accent }}
                >
                  {capability}
                </span>
              ))}
            </div>
          </section>

          {guideQuestions.length > 0 && (
            <section className="mt-5">
              <h3 className="text-foreground text-xs font-semibold">
                {zh ? "可以这样问" : "Try asking"}
              </h3>
              <div className="mt-2 space-y-2">
                {guideQuestions.map((guideQuestion) => (
                  <button
                    key={`${guideQuestion.question}:${guideQuestion.prompt ?? ""}`}
                    type="button"
                    className="text-muted-foreground hover:border-foreground/30 hover:bg-muted hover:text-foreground flex min-h-11 w-full cursor-pointer items-center justify-between gap-4 rounded-lg border bg-muted/30 px-3.5 text-left text-xs transition-colors"
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
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg px-4 text-xs font-medium transition-colors"
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

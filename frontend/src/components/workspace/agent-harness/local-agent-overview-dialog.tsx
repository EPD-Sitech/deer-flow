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
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-hidden rounded-2xl border-[#d5e3ee] bg-white p-0 shadow-[0_30px_80px_rgba(12,38,61,0.25)] sm:top-[40%] sm:max-w-[700px] dark:border-slate-700 dark:bg-slate-950">
        <DialogHeader className="flex-row items-center gap-3 bg-[#eff6fb] px-6 py-5 pr-14 text-left dark:bg-slate-900">
          <div
            className="grid size-16 shrink-0 place-items-center rounded-full border-2 border-white shadow-sm dark:border-slate-700"
            style={{ backgroundColor: tint, color: accent }}
            aria-hidden="true"
          >
            <BotIcon className="size-7" />
          </div>
          <div className="min-w-0">
            <DialogTitle className="truncate text-xl text-[#173a5b] dark:text-slate-100">
              {agent.name}
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs text-[#71869a] dark:text-slate-400">
              {categoryLabel} · {scopeLabel}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="max-h-[calc(100dvh-10rem)] overflow-y-auto px-6 py-5">
          <section>
            <h3 className="text-xs font-semibold text-[#294a67] dark:text-slate-200">
              {zh ? "专家简介" : "About this expert"}
            </h3>
            <p className="mt-2 text-xs leading-6 text-[#60768a] dark:text-slate-300">
              {agent.description ||
                (zh
                  ? "为复杂业务任务提供专业分析与执行支持。"
                  : "Specialized analysis and execution for complex tasks.")}
            </p>
          </section>

          <section className="mt-4">
            <h3 className="text-xs font-semibold text-[#294a67] dark:text-slate-200">
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
              <h3 className="text-xs font-semibold text-[#294a67] dark:text-slate-200">
                {zh ? "可以这样问" : "Try asking"}
              </h3>
              <div className="mt-2 space-y-2">
                {guideQuestions.map((guideQuestion) => (
                  <button
                    key={`${guideQuestion.question}:${guideQuestion.prompt ?? ""}`}
                    type="button"
                    className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-4 rounded-lg border border-[#e3ebf2] bg-[#f8fafc] px-3.5 text-left text-xs text-[#60768a] transition-colors hover:border-[#b9d4e8] hover:bg-[#f1f7fb] hover:text-[#356b96] dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800"
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
              className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg bg-[#357df3] px-4 text-xs font-medium text-white shadow-[0_8px_18px_rgba(53,125,243,0.24)] transition-colors hover:bg-[#256fe3]"
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

"use client";

import { ArrowRightIcon, MessageCircleQuestionIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import type { AgentGuideQuestion } from "./guide-questions";

export function LocalAgentGuideQuestions({
  className,
  questions,
  onSelect,
  disabled = false,
}: {
  className?: string;
  questions: AgentGuideQuestion[];
  onSelect: (prompt: string) => void;
  disabled?: boolean;
}) {
  if (questions.length === 0) return null;

  return (
    <section className={cn("mt-6 w-full px-1 text-left", className)}>
      <h2 className="text-muted-foreground mb-[9px] text-[10px] font-semibold">
        试试这样问
      </h2>
      <div className="grid grid-cols-1 gap-2">
        {questions.map((item, index) => (
          <button
            key={`${item.question}-${index}`}
            type="button"
            className="border-border bg-background text-muted-foreground hover:border-primary/35 hover:bg-accent/50 hover:text-foreground group flex min-h-[52px] w-full cursor-pointer items-center gap-2 rounded-md border px-3.5 py-2.5 text-left text-xs leading-5 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            disabled={disabled}
            onClick={() => onSelect(item.prompt ?? item.question)}
          >
            <MessageCircleQuestionIcon className="text-primary size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{item.question}</span>
            <ArrowRightIcon className="size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" />
          </button>
        ))}
      </div>
    </section>
  );
}

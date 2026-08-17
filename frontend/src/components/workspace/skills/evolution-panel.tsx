"use client";

import { CheckIcon, LoaderIcon, SparklesIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  useApplySkillEvolution,
  useProposeSkillEvolution,
  useRejectSkillEvolution,
  useSkillEvolutionHistory,
  useSkillEvolutionSuggestions,
} from "@/core/skills/extended";
import type { SkillEvolutionRecord } from "@/core/skills/extended";

interface EvolutionPanelProps {
  skillName: string;
  canEdit: boolean;
}

function statusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "待处理";
    case "applied":
      return "已应用";
    case "rejected":
      return "已拒绝";
    default:
      return status;
  }
}

function statusClass(status: string): string {
  switch (status) {
    case "pending":
      return "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200";
    case "applied":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200";
    case "rejected":
      return "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200";
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200";
  }
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function EvolutionPanel({ skillName, canEdit }: EvolutionPanelProps) {
  const [feedback, setFeedback] = useState("");
  const proposeMutation = useProposeSkillEvolution();
  const applyMutation = useApplySkillEvolution();
  const rejectMutation = useRejectSkillEvolution();
  const { data: historyData, isLoading: historyLoading } =
    useSkillEvolutionHistory(skillName);
  const { data: suggestionData } = useSkillEvolutionSuggestions(skillName);

  const records: SkillEvolutionRecord[] = historyData?.records ?? [];
  const suggestions = suggestionData?.suggestions ?? [];

  const handlePropose = async () => {
    const trimmed = feedback.trim();
    if (!trimmed) {
      toast.error("请填写反馈或改进意见");
      return;
    }
    try {
      const rec = await proposeMutation.mutateAsync({
        skillName,
        feedback: trimmed,
      });
      toast.success("AI 改进建议已生成，请审阅后应用");
      setFeedback("");
      void rec;
    } catch (e) {
      toast.error(`生成失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleApply = async (recordId: string) => {
    try {
      await applyMutation.mutateAsync({ skillName, recordId });
      toast.success("已应用 AI 改进版本（可随时在版本历史中回滚）");
    } catch (e) {
      toast.error(`应用失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleReject = async (recordId: string) => {
    try {
      await rejectMutation.mutateAsync({ skillName, recordId });
      toast.success("已拒绝该改进");
    } catch (e) {
      toast.error(`拒绝失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="h-full space-y-3 overflow-y-auto p-3">
      {canEdit && (
        <div className="border-border bg-muted/30 space-y-2 rounded-md border p-3">
          <div className="text-foreground text-sm font-medium">
            AI 演进 · 反馈意见
          </div>
          {suggestions.length > 0 && (
            <ul className="text-muted-foreground space-y-1 text-xs">
              {suggestions.map((s, i) => (
                <li key={i}>· {s}</li>
              ))}
            </ul>
          )}
          <Textarea
            className="bg-background text-foreground placeholder:text-muted-foreground min-h-16 text-sm"
            placeholder="描述你想改进的技能行为或补充的能力…"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
          />
          <Button
            size="sm"
            className="w-full"
            disabled={proposeMutation.isPending || !feedback.trim()}
            onClick={() => void handlePropose()}
          >
            {proposeMutation.isPending ? (
              <LoaderIcon className="mr-1 size-4 animate-spin" />
            ) : (
              <SparklesIcon className="mr-1 size-4" />
            )}
            {proposeMutation.isPending ? "AI 生成中..." : "生成 AI 改进建议"}
          </Button>
        </div>
      )}

      <div className="text-muted-foreground text-xs font-semibold">
        演进记录
      </div>
      {historyLoading ? (
        <div className="text-muted-foreground flex h-16 items-center justify-center text-xs">
          加载中...
        </div>
      ) : records.length === 0 ? (
        <div className="text-muted-foreground rounded-md border border-dashed p-4 text-center text-xs">
          暂无演进记录。填写反馈意见后生成第一条 AI 改进建议。
        </div>
      ) : (
        <div className="space-y-2">
          {records.map((record) => (
            <div
              key={record.id}
              className="border-border rounded-md border p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusClass(record.status)}`}
                >
                  {statusLabel(record.status)}
                </span>
                <span className="text-muted-foreground text-[10px]">
                  {formatTime(record.created_at)}
                </span>
              </div>
              <p className="text-foreground mt-2 text-xs font-medium">
                {record.summary}
              </p>
              <p className="text-muted-foreground mt-1 text-[11px] break-words">
                {record.feedback}
              </p>
              {record.status === "pending" && canEdit && (
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    disabled={applyMutation.isPending}
                    onClick={() => void handleApply(record.id)}
                  >
                    <CheckIcon className="mr-1 size-3.5" />
                    应用
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-muted-foreground h-7 text-xs"
                    disabled={rejectMutation.isPending}
                    onClick={() => void handleReject(record.id)}
                  >
                    <XIcon className="mr-1 size-3.5" />
                    拒绝
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

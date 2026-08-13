"use client";

import { LoaderIcon, PuzzleIcon } from "lucide-react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { SkillRequestError } from "@/core/skills/api";
import { SKILL_CATEGORIES } from "@/core/skills/categories";
import { useCustomSkillContent } from "@/core/skills/extended";
import type { Skill } from "@/core/skills/type";

function skillCategoryLabel(skill: Skill): string {
  return (
    skill.category_label ??
    SKILL_CATEGORIES.find((item) => item.id === skill.skill_category)?.label ??
    "其他"
  );
}

interface SkillDetailDialogProps {
  skill: Skill;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ROW_LABEL_CLASS =
  "w-[72px] shrink-0 text-[11px] font-medium text-[#71869a] dark:text-slate-400";
const ROW_VALUE_CLASS =
  "min-w-0 text-[12px] leading-[1.7] break-words text-[#2c4a66] dark:text-slate-200";

function MetaRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      <span className={ROW_LABEL_CLASS}>{label}</span>
      <span className={ROW_VALUE_CLASS}>{children}</span>
    </div>
  );
}

export function SkillDetailDialog({
  skill,
  open,
  onOpenChange,
}: SkillDetailDialogProps) {
  const router = useRouter();
  const contentQuery = useCustomSkillContent(
    open && skill.editable ? skill.name : null,
  );

  const contentError = contentQuery.error;
  const contentBlocked =
    contentError instanceof SkillRequestError &&
    contentError.isAdminRequired;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-32px)] gap-0 overflow-hidden rounded-[14px] border-[#d8e4ee] bg-white p-0 shadow-[0_24px_70px_rgba(27,67,104,0.2)] backdrop-blur-none sm:max-w-[560px] dark:border-slate-700 dark:bg-slate-950"
      >
        <header className="flex items-start gap-[11px] border-b border-[#edf2f7] bg-[linear-gradient(120deg,#f7fbff,#eef6ff_70%,#f9fcff)] px-6 pt-5 pb-[15px] dark:border-slate-800 dark:bg-[linear-gradient(120deg,#172033,#0f172a_70%,#111827)]">
          <div className="grid size-[38px] shrink-0 place-items-center rounded-[11px] bg-[linear-gradient(145deg,#e2f0ff,#cfe6ff)] text-[#2582ea] shadow-[inset_0_0_0_1px_rgba(65,155,255,0.18)] dark:bg-[linear-gradient(145deg,#1e3a5f,#172b47)] dark:text-sky-300">
            <PuzzleIcon className="size-[19px]" />
          </div>
          <div className="min-w-0">
            <DialogTitle className="truncate text-[17px] leading-6 font-semibold text-[#173b5e] dark:text-slate-100">
              技能详情 · {skill.name}
            </DialogTitle>
            <DialogDescription className="mt-[3px] text-[10px] text-[#8496a8] dark:text-slate-400">
              技能元数据与配置信息
            </DialogDescription>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              className="h-7 rounded-[7px] bg-[linear-gradient(145deg,#2587ea,#419bff)] px-3 text-[11px] text-white shadow-[0_6px_14px_rgba(37,130,234,0.22)] hover:opacity-95"
              onClick={() => {
                onOpenChange(false);
                void router.push(
                  `/workspace/chats/new?skill=${encodeURIComponent(skill.name)}`,
                );
              }}
            >
              去试试
            </Button>
            <button
              type="button"
              className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-[7px] text-lg leading-none text-[#8b9cad] transition-colors hover:bg-[#edf4fa] hover:text-[#356b96] dark:hover:bg-slate-800 dark:hover:text-slate-100"
              aria-label="关闭"
              onClick={() => onOpenChange(false)}
            >
              ×
            </button>
          </div>
        </header>

        <div className="max-h-[calc(100dvh-260px)] overflow-auto bg-[#f7fafd] px-6 pt-4 pb-6 dark:bg-slate-950/80">
          <section className="overflow-hidden rounded-[12px] border border-[#e4edf5] bg-white shadow-[0_1px_2px_rgba(15,56,94,0.05)] dark:border-slate-800 dark:bg-slate-900">
            <div className="flex h-9 items-center border-b border-[#eef3f8] bg-[linear-gradient(120deg,#fcfeff,#f5f9fd)] px-4 text-xs font-semibold text-[#2c4a66] dark:border-slate-800 dark:bg-[linear-gradient(120deg,#111827,#172033)] dark:text-slate-200">
              基本信息
            </div>
            <MetaRow label="名称">{skill.name}</MetaRow>
            <div className="mx-4 border-t border-[#eef3f8] dark:border-slate-800" />
            <MetaRow label="类型">{skillCategoryLabel(skill)}</MetaRow>
            <div className="mx-4 border-t border-[#eef3f8] dark:border-slate-800" />
            <MetaRow label="状态">
              <span
                className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${
                  skill.enabled ? "text-[#189a80]" : "text-[#93a3b4]"
                }`}
              >
                <span
                  className={`size-1.5 rounded-full ${
                    skill.enabled
                      ? "bg-[#50d3b9] shadow-[0_0_0_3px_rgba(80,211,185,0.16)]"
                      : "bg-[#b6c5d2]"
                  }`}
                />
                {skill.enabled ? "运行中" : "已停用"}
              </span>
            </MetaRow>
            <div className="mx-4 border-t border-[#eef3f8] dark:border-slate-800" />
            <MetaRow label="许可证">{skill.license || "—"}</MetaRow>
            {skill.description && (
              <>
                <div className="mx-4 border-t border-[#eef3f8] dark:border-slate-800" />
                <MetaRow label="描述">{skill.description}</MetaRow>
              </>
            )}
          </section>

          {skill.editable && (
            <section className="mt-3.5 overflow-hidden rounded-[12px] border border-[#e4edf5] bg-white shadow-[0_1px_2px_rgba(15,56,94,0.05)] dark:border-slate-800 dark:bg-slate-900">
              <div className="flex h-9 items-center border-b border-[#eef3f8] bg-[linear-gradient(120deg,#fcfeff,#f5f9fd)] px-4 text-xs font-semibold text-[#2c4a66] dark:border-slate-800 dark:bg-[linear-gradient(120deg,#111827,#172033)] dark:text-slate-200">
                SKILL.md 内容
              </div>
              <div className="p-3.5">
                {contentQuery.isLoading ? (
                  <div className="flex h-24 items-center justify-center gap-2 text-xs text-[#8496a8] dark:text-slate-400">
                    <LoaderIcon className="size-3.5 animate-spin" />
                    加载中...
                  </div>
                ) : contentBlocked ? (
                  <p className="text-xs leading-6 text-[#8496a8] dark:text-slate-400">
                    需要管理员权限才能查看技能内容。
                  </p>
                ) : contentError ? (
                  <p className="text-xs leading-6 text-[#e04a52]">
                    {contentError.message}
                  </p>
                ) : (
                  <pre className="max-h-[300px] overflow-auto rounded-[8px] border border-[#eef3f8] bg-[#f8fafc] p-3 font-mono text-[11px] leading-[1.7] whitespace-pre-wrap text-[#3c5a76] dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300">
                    {contentQuery.data?.content ?? ""}
                  </pre>
                )}
              </div>
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

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
  "text-muted-foreground w-[72px] shrink-0 text-[11px] font-medium";
const ROW_VALUE_CLASS =
  "text-foreground min-w-0 text-[12px] leading-[1.7] break-words";

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
        className="max-h-[calc(100dvh-32px)] gap-0 overflow-hidden rounded-[14px] border bg-background p-0 shadow-[0_24px_70px_rgba(27,67,104,0.2)] backdrop-blur-none sm:max-w-[560px]"
      >
        <header className="flex items-start gap-[11px] border-b bg-transparent px-6 pt-5 pb-[15px]">
          <div className="bg-muted text-muted-foreground grid size-[38px] shrink-0 place-items-center rounded-[11px]">
            <PuzzleIcon className="size-[19px]" />
          </div>
          <div className="min-w-0">
            <DialogTitle className="text-foreground truncate text-[17px] leading-6 font-semibold">
              技能详情 · {skill.name}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground mt-[3px] text-[10px]">
              技能元数据与配置信息
            </DialogDescription>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              className="bg-primary text-primary-foreground hover:bg-primary/90 h-7 rounded-[7px] px-3 text-[11px]"
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
              className="text-muted-foreground hover:bg-accent hover:text-foreground grid size-7 shrink-0 cursor-pointer place-items-center rounded-[7px] text-lg leading-none transition-colors"
              aria-label="关闭"
              onClick={() => onOpenChange(false)}
            >
              ×
            </button>
          </div>
        </header>

        <div className="max-h-[calc(100dvh-260px)] overflow-auto bg-background px-6 pt-4 pb-6">
          <section className="overflow-hidden rounded-[12px] border bg-background shadow-[0_1px_2px_rgba(15,56,94,0.05)]">
            <div className="text-foreground flex h-9 items-center border-b bg-muted/40 px-4 text-xs font-semibold">
              基本信息
            </div>
            <MetaRow label="名称">{skill.name}</MetaRow>
            <div className="mx-4 border-t" />
            <MetaRow label="类型">{skillCategoryLabel(skill)}</MetaRow>
            <div className="mx-4 border-t" />
            <MetaRow label="状态">
              <span
                className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${
                  skill.enabled ? "text-[#189a80]" : "text-muted-foreground"
                }`}
              >
                <span
                  className={`size-1.5 rounded-full ${
                    skill.enabled
                      ? "bg-[#50d3b9] shadow-[0_0_0_3px_rgba(80,211,185,0.16)]"
                      : "bg-border"
                  }`}
                />
                {skill.enabled ? "运行中" : "已停用"}
              </span>
            </MetaRow>
            <div className="mx-4 border-t" />
            <MetaRow label="许可证">{skill.license || "—"}</MetaRow>
            {skill.description && (
              <>
                <div className="mx-4 border-t" />
                <MetaRow label="描述">{skill.description}</MetaRow>
              </>
            )}
          </section>

          {skill.editable && (
            <section className="mt-3.5 overflow-hidden rounded-[12px] border bg-background shadow-[0_1px_2px_rgba(15,56,94,0.05)]">
              <div className="text-foreground flex h-9 items-center border-b bg-muted/40 px-4 text-xs font-semibold">
                SKILL.md 内容
              </div>
              <div className="p-3.5">
                {contentQuery.isLoading ? (
                  <div className="text-muted-foreground flex h-24 items-center justify-center gap-2 text-xs">
                    <LoaderIcon className="size-3.5 animate-spin" />
                    加载中...
                  </div>
                ) : contentBlocked ? (
                  <p className="text-muted-foreground text-xs leading-6">
                    需要管理员权限才能查看技能内容。
                  </p>
                ) : contentError ? (
                  <p className="text-destructive text-xs leading-6">
                    {contentError.message}
                  </p>
                ) : (
                  <pre className="text-foreground max-h-[300px] overflow-auto rounded-[8px] border bg-muted p-3 font-mono text-[11px] leading-[1.7] whitespace-pre-wrap">
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

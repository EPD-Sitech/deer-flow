"use client";

import { LayoutGridIcon, LoaderIcon, PencilIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SKILL_CATEGORIES } from "@/core/skills/categories";
import { useCreateSkill } from "@/core/skills/extended";

interface CreateSkillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (name: string) => void;
}

const FIELD_INPUT_CLASS =
  "h-[38px] rounded-[9px] border-input bg-background px-3 text-sm shadow-none transition";
const FIELD_LABEL_CLASS =
  "text-muted-foreground mb-1.5 block text-[10px] font-semibold";

export function CreateSkillDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateSkillDialogProps) {
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [tags, setTags] = useState("");
  const createMutation = useCreateSkill();

  const reset = () => {
    setName("");
    setDisplayName("");
    setDescription("");
    setCategory("");
    setTags("");
  };

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("请输入技能名称");
      return;
    }
    try {
      const tagList = tags
        .split(/[，,\s]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      const result = await createMutation.mutateAsync({
        name: trimmed,
        display_name: displayName.trim() || undefined,
        description: description.trim() || undefined,
        category: category.trim() || undefined,
        tags: tagList.length > 0 ? tagList : undefined,
      });
      toast.success(`技能 ${result.name} 已创建`);
      onOpenChange(false);
      reset();
      onCreated?.(result.name);
    } catch (e) {
      toast.error(`创建失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-32px)] gap-0 overflow-hidden rounded-[14px] border bg-background p-0 shadow-[0_24px_70px_rgba(27,67,104,0.2)] backdrop-blur-none sm:max-w-[560px]"
      >
        <header className="flex items-start gap-[11px] border-b bg-transparent px-6 pt-5 pb-[15px]">
          <div className="bg-muted text-muted-foreground grid size-[38px] shrink-0 place-items-center rounded-[11px]">
            <PlusIcon className="size-[19px]" />
          </div>
          <div className="min-w-0">
            <DialogTitle className="text-foreground truncate text-[17px] leading-6 font-semibold">
              新建技能
            </DialogTitle>
            <DialogDescription className="text-muted-foreground mt-[3px] text-[10px]">
              创建一个空白的用户技能骨架，可立即进入编辑器完善 SKILL.md。
            </DialogDescription>
          </div>
          <button
            type="button"
            className="text-muted-foreground hover:bg-accent hover:text-foreground ml-auto grid size-7 shrink-0 cursor-pointer place-items-center rounded-[7px] text-lg leading-none transition-colors"
            aria-label="关闭"
            onClick={() => onOpenChange(false)}
          >
            ×
          </button>
        </header>

        <div className="max-h-[calc(100dvh-260px)] overflow-auto bg-background px-6 pt-4 pb-1.5">
          <section className="mb-3.5 overflow-hidden rounded-[12px] border bg-background shadow-[0_1px_2px_rgba(15,56,94,0.05)]">
            <div className="flex h-11 items-center gap-2.5 border-b bg-muted/40 px-3.5">
              <PencilIcon className="text-muted-foreground size-4" />
              <b className="text-foreground text-xs font-semibold">基础信息</b>
            </div>
            <div className="p-3.5">
              <label htmlFor="cs-name" className={FIELD_LABEL_CLASS}>
                名称（小写字母/数字/-/_）
              </label>
              <Input
                id="cs-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-skill"
                maxLength={80}
                className={FIELD_INPUT_CLASS}
              />
              <label htmlFor="cs-display" className={`mt-[13px] ${FIELD_LABEL_CLASS}`}>
                显示名称（可选）
              </label>
              <Input
                id="cs-display"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="我的技能"
                maxLength={120}
                className={FIELD_INPUT_CLASS}
              />
              <label htmlFor="cs-desc" className={`mt-[13px] ${FIELD_LABEL_CLASS}`}>
                简介
              </label>
              <Input
                id="cs-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="简短描述技能用途"
                maxLength={400}
                className={FIELD_INPUT_CLASS}
              />
            </div>
          </section>

          <section className="mb-3.5 overflow-hidden rounded-[12px] border bg-background shadow-[0_1px_2px_rgba(15,56,94,0.05)]">
            <div className="flex h-11 items-center gap-2.5 border-b bg-muted/40 px-3.5">
              <LayoutGridIcon className="text-muted-foreground size-4" />
              <b className="text-foreground text-xs font-semibold">类型</b>
            </div>
            <div className="p-3.5">
              <label htmlFor="cs-cat" className={FIELD_LABEL_CLASS}>
                分类（可选）
              </label>
              <select
                id="cs-cat"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="border-input bg-background text-foreground h-[38px] w-full cursor-pointer rounded-[9px] border px-3 text-sm shadow-none transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <option value="">未分类</option>
                {SKILL_CATEGORIES.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
              <label htmlFor="cs-tags" className={`mt-[13px] ${FIELD_LABEL_CLASS}`}>
                标签（用空格或逗号分隔，可选）
              </label>
              <Input
                id="cs-tags"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="ai, automation"
                className={FIELD_INPUT_CLASS}
              />
            </div>
          </section>
        </div>

        <footer className="flex justify-end gap-2 border-t bg-background px-6 pt-3 pb-[18px]">
          <Button
            variant="outline"
            className="h-9 px-3.5 text-[11px] font-semibold"
            onClick={() => onOpenChange(false)}
            disabled={createMutation.isPending}
          >
            取消
          </Button>
          <Button
            className="bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-3.5 text-[11px] font-semibold"
            onClick={handleCreate}
            disabled={createMutation.isPending || !name.trim()}
          >
            {createMutation.isPending ? (
              <LoaderIcon className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <PlusIcon className="mr-2 h-4 w-4" />
            )}
            {createMutation.isPending ? "创建中..." : "创建"}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

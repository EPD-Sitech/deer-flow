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
  "h-[38px] rounded-[9px] border-[#d3e1ee] bg-white px-3 text-sm text-[#1e293b] shadow-none transition focus-visible:border-[#87bdf0] focus-visible:ring-2 focus-visible:ring-[rgba(65,155,255,0.13)] dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100";
const FIELD_LABEL_CLASS =
  "mb-1.5 block text-[10px] font-semibold text-[#5d7185] dark:text-slate-300";

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
        className="max-h-[calc(100dvh-32px)] gap-0 overflow-hidden rounded-[14px] border-[#d8e4ee] bg-white p-0 shadow-[0_24px_70px_rgba(27,67,104,0.2)] backdrop-blur-none sm:max-w-[560px] dark:border-slate-700 dark:bg-slate-950"
      >
        <header className="flex items-start gap-[11px] border-b border-[#edf2f7] bg-[linear-gradient(120deg,#f7fbff,#eef6ff_70%,#f9fcff)] px-6 pt-5 pb-[15px] dark:border-slate-800 dark:bg-[linear-gradient(120deg,#172033,#0f172a_70%,#111827)]">
          <div className="grid size-[38px] shrink-0 place-items-center rounded-[11px] bg-[linear-gradient(145deg,#e2f0ff,#cfe6ff)] text-[#2582ea] shadow-[inset_0_0_0_1px_rgba(65,155,255,0.18)] dark:bg-[linear-gradient(145deg,#1e3a5f,#172b47)] dark:text-sky-300">
            <PlusIcon className="size-[19px]" />
          </div>
          <div className="min-w-0">
            <DialogTitle className="truncate text-[17px] leading-6 font-semibold text-[#173b5e] dark:text-slate-100">
              新建技能
            </DialogTitle>
            <DialogDescription className="mt-[3px] text-[10px] text-[#8496a8] dark:text-slate-400">
              创建一个空白的用户技能骨架，可立即进入编辑器完善 SKILL.md。
            </DialogDescription>
          </div>
          <button
            type="button"
            className="ml-auto grid size-7 shrink-0 cursor-pointer place-items-center rounded-[7px] text-lg leading-none text-[#8b9cad] transition-colors hover:bg-[#edf4fa] hover:text-[#356b96] dark:hover:bg-slate-800 dark:hover:text-slate-100"
            aria-label="关闭"
            onClick={() => onOpenChange(false)}
          >
            ×
          </button>
        </header>

        <div className="max-h-[calc(100dvh-260px)] overflow-auto bg-[#f7fafd] px-6 pt-4 pb-1.5 dark:bg-slate-950/80">
          <section className="mb-3.5 overflow-hidden rounded-[12px] border border-[#e4edf5] bg-white shadow-[0_1px_2px_rgba(15,56,94,0.05)] dark:border-slate-800 dark:bg-slate-900">
            <div className="flex h-11 items-center gap-2.5 border-b border-[#eef3f8] bg-[linear-gradient(120deg,#fcfeff,#f5f9fd)] px-3.5 dark:border-slate-800 dark:bg-[linear-gradient(120deg,#111827,#172033)]">
              <PencilIcon className="size-4 text-[#2582ea] dark:text-sky-300" />
              <b className="text-xs font-semibold text-[#2c4a66] dark:text-slate-200">
                基础信息
              </b>
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

          <section className="mb-3.5 overflow-hidden rounded-[12px] border border-[#e4edf5] bg-white shadow-[0_1px_2px_rgba(15,56,94,0.05)] dark:border-slate-800 dark:bg-slate-900">
            <div className="flex h-11 items-center gap-2.5 border-b border-[#eef3f8] bg-[linear-gradient(120deg,#fcfeff,#f5f9fd)] px-3.5 dark:border-slate-800 dark:bg-[linear-gradient(120deg,#111827,#172033)]">
              <LayoutGridIcon className="size-4 text-[#2582ea] dark:text-sky-300" />
              <b className="text-xs font-semibold text-[#2c4a66] dark:text-slate-200">
                类型
              </b>
            </div>
            <div className="p-3.5">
              <label htmlFor="cs-cat" className={FIELD_LABEL_CLASS}>
                分类（可选）
              </label>
              <select
                id="cs-cat"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="h-[38px] w-full cursor-pointer rounded-[9px] border border-[#d3e1ee] bg-white px-3 text-sm text-[#1e293b] shadow-none transition focus:border-[#87bdf0] focus:ring-2 focus:ring-[rgba(65,155,255,0.13)] focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
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

        <footer className="flex justify-end gap-2 border-t border-[#edf2f7] bg-white px-6 pt-3 pb-[18px] dark:border-slate-800 dark:bg-slate-950">
          <Button
            variant="outline"
            className="h-9 rounded-[10px] border-[#d1dfeb] bg-white px-3.5 text-[11px] font-semibold text-[#52677b] shadow-none hover:border-[#8fbfe8] hover:bg-[#fbfdff] hover:text-[#1471c3] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            onClick={() => onOpenChange(false)}
            disabled={createMutation.isPending}
          >
            取消
          </Button>
          <Button
            className="h-9 rounded-[10px] bg-[#419bff] px-3.5 text-[11px] font-semibold text-white shadow-[0_7px_16px_rgba(65,155,255,0.2)] hover:bg-[#2582ea]"
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

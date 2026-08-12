"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建技能</DialogTitle>
          <DialogDescription>
            创建一个空白的用户技能骨架，可立即进入编辑器完善 SKILL.md。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <label htmlFor="cs-name" className="text-sm font-medium">
              名称（小写字母/数字/-/_）
            </label>
            <Input
              id="cs-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-skill"
              maxLength={80}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="cs-display" className="text-sm font-medium">
              显示名称（可选）
            </label>
            <Input
              id="cs-display"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="我的技能"
              maxLength={120}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="cs-desc" className="text-sm font-medium">
              简介
            </label>
            <Input
              id="cs-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="简短描述技能用途"
              maxLength={400}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="cs-cat" className="text-sm font-medium">
              分类（可选）
            </label>
            <select
              id="cs-cat"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="h-9 w-full cursor-pointer rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <option value="">未分类</option>
              {SKILL_CATEGORIES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="cs-tags" className="text-sm font-medium">
              标签（用空格或逗号分隔，可选）
            </label>
            <Input
              id="cs-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="ai, automation"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={createMutation.isPending}
          >
            取消
          </Button>
          <Button
            onClick={handleCreate}
            disabled={createMutation.isPending || !name.trim()}
          >
            {createMutation.isPending ? "创建中..." : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import {
  CheckSquareIcon,
  DownloadIcon,
  LoaderIcon,
  PlusIcon,
  PuzzleIcon,
  SearchIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
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
import { useAuth } from "@/core/auth/AuthProvider";
import { useI18n } from "@/core/i18n/hooks";
import { SkillRequestError } from "@/core/skills/api";
import { SKILL_CATEGORIES } from "@/core/skills/categories";
import { exportSkillsBatch } from "@/core/skills/extended";
import { useBatchDeleteSkills } from "@/core/skills/extended";
import { useSkills } from "@/core/skills/hooks";
import type { Skill } from "@/core/skills/type";

import { CreateSkillDialog } from "./create-skill-dialog";
import { ImportSkillDialog } from "./import-skill-dialog";
import { SkillCard } from "./skill-card";
import { SkillDetailDialog } from "./skill-detail-dialog";
import { SkillEditorDialog } from "./skill-editor-dialog";

export function SkillsGallery() {
  const { t } = useI18n();
  const { skills, isLoading, error } = useSkills();
  const { user } = useAuth();
  const canManage = !!user;

  // Local tab state (no top tabs — the gallery is the whole page)
  const [searchQuery, setSearchQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
  const [batchDeleteConfirm, setBatchDeleteConfirm] = useState(false);
  const batchDelete = useBatchDeleteSkills();
  const [detailSkill, setDetailSkill] = useState<Skill | null>(null);
  const [editSkill, setEditSkill] = useState<Skill | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const filteredSkills = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = skills.filter((skill) => {
      if (scopeFilter !== "all" && skill.scope !== scopeFilter) return false;
      if (categoryFilter !== "all" && skill.skill_category !== categoryFilter)
        return false;
      if (!q) return true;
      return (
        skill.name.toLowerCase().includes(q) ||
        (skill.display_name?.toLowerCase().includes(q) ?? false) ||
        (skill.category_label?.toLowerCase().includes(q) ?? false) ||
        (skill.tags?.some((tag) => tag.toLowerCase().includes(q)) ?? false) ||
        (skill.description_zh?.toLowerCase().includes(q) ?? false) ||
        skill.description.toLowerCase().includes(q)
      );
    });
    // User/custom skills first, then public/system
    return filtered.sort((a, b) => {
      if (a.scope === "user" && b.scope !== "user") return -1;
      if (a.scope !== "user" && b.scope === "user") return 1;
      return 0;
    });
  }, [skills, scopeFilter, categoryFilter, searchQuery]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: skills.length };
    for (const skill of skills) {
      const category = skill.skill_category ?? "other";
      counts[category] = (counts[category] ?? 0) + 1;
    }
    return counts;
  }, [skills]);

  const toggleSelect = useCallback((name: string) => {
    setSelectedSkills((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedSkills(new Set()), []);

  async function handleBatchDelete() {
    if (selectedSkills.size === 0) return;
    try {
      const result = await batchDelete.mutateAsync([...selectedSkills]);
      if (result.success) {
        toast.success(`已删除 ${result.deleted.length} 个技能`);
      } else if (result.deleted.length > 0) {
        toast.warning(
          `已删除 ${result.deleted.length} 个，失败 ${result.failed.length} 个`,
        );
      } else {
        toast.error("删除失败");
      }
      clearSelection();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
    setBatchDeleteConfirm(false);
  }

  async function handleBatchExport() {
    if (selectedSkills.size === 0) return;
    try {
      const { blob, filename } = await exportSkillsBatch([...selectedSkills]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename || "skills-export.zip";
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`已导出 ${selectedSkills.size} 个技能`);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : JSON.stringify(err);
      toast.error(msg);
    }
  }

  const manageableFilteredSkills = useMemo(
    () => filteredSkills.filter((s) => s.can_manage ?? s.editable),
    [filteredSkills],
  );

  const handleSelectAll = useCallback(() => {
    const allNames = new Set(manageableFilteredSkills.map((s) => s.name));
    setSelectedSkills((prev) => {
      const allSelected = manageableFilteredSkills.every((s) =>
        prev.has(s.name),
      );
      return allSelected ? new Set() : allNames;
    });
  }, [manageableFilteredSkills]);

  const adminRequired =
    error instanceof SkillRequestError && error.isAdminRequired;

  return (
    <div className="bg-background flex size-full min-w-0 flex-col">
      {/* 页面头部 */}
      <div className="bg-card shrink-0 border-b">
        <header className="flex flex-col gap-4 px-5 py-4 sm:px-6 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <h1 className="text-[24px] leading-tight font-semibold text-[#173a5b] dark:text-slate-100">
              推荐技能
            </h1>
            <p className="mt-1 text-sm text-[#71869a] dark:text-slate-400">
              试试推荐业务技能与能力
            </p>
          </div>
          <div className="flex w-full flex-col gap-2 sm:flex-row xl:w-auto">
            <div className="relative min-w-0 flex-1 sm:w-[280px] xl:w-[320px]">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-[#89a0b3] dark:text-slate-500" />
              <Input
                className="bg-background h-9 rounded-lg border-[#d8e5ef] pl-9 text-xs text-[#34495e] shadow-none placeholder:text-[#9badbf] focus-visible:border-[#86bae1] focus-visible:ring-2 focus-visible:ring-sky-200/50 dark:border-slate-700 dark:text-slate-100"
                placeholder="搜索技能..."
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </div>
            {canManage ? (
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button
                  variant="outline"
                  className="h-9 shrink-0 rounded-lg px-3 text-xs"
                  onClick={() => setImportDialogOpen(true)}
                >
                  <UploadIcon className="size-3.5" />
                  导入
                </Button>
                <Button
                  className="h-9 flex-1 rounded-lg bg-[#2587ea] px-3 text-xs text-white shadow-[0_7px_16px_rgba(37,130,234,0.24)] hover:bg-[#1778d8] sm:flex-none"
                  onClick={() => setCreateDialogOpen(true)}
                >
                  <PlusIcon className="mr-1.5 size-3.5" />
                  新建技能
                </Button>
              </div>
            ) : null}
          </div>
        </header>
      </div>

      {/* 分类筛选 + scope 筛选 + 数量 */}
      <div className="flex shrink-0 flex-col gap-3 border-b border-[#edf2f6] px-5 py-3 sm:px-6 xl:flex-row xl:items-center xl:justify-between dark:border-slate-800">
        <div className="-mx-1 flex max-w-full gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
          {[{ id: "all", label: "全部" }, ...SKILL_CATEGORIES].map(
            (category) => {
              const active = categoryFilter === category.id;
              return (
                <button
                  key={category.id}
                  type="button"
                  onClick={() => setCategoryFilter(category.id)}
                  className={
                    active
                      ? "h-8 shrink-0 cursor-pointer rounded-md border border-[#d2e3f1] bg-[#edf6ff] px-[9px] text-xs font-semibold text-[#1673c7] shadow-sm dark:border-sky-800 dark:bg-sky-950/60 dark:text-sky-300"
                      : "h-8 shrink-0 cursor-pointer rounded-md border border-transparent px-[9px] text-xs font-medium text-[#75879a] transition-colors hover:bg-[#f1f6fa] hover:text-[#3e6585] dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                  }
                >
                  {category.label}
                  <span className="ml-1 opacity-65">
                    {categoryCounts[category.id] ?? 0}
                  </span>
                </button>
              );
            },
          )}
        </div>

        <div className="flex items-center justify-between gap-3 xl:justify-end">
          <span className="shrink-0 text-[11px] text-[#8295a7] dark:text-slate-400">
            {filteredSkills.length} 个技能
          </span>
          <div className="inline-flex h-8 items-center gap-0.5 rounded-lg border border-[#d8e5ef] bg-[#f6f8fb] p-0.5 dark:border-slate-700 dark:bg-slate-900">
            {(
              [
                ["all", "全部"],
                ["public", "公共"],
                ["user", "自定义"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setScopeFilter(value)}
                className={
                  scopeFilter === value
                    ? "h-6 cursor-pointer rounded-md bg-white px-2.5 text-[10px] font-medium text-[#2376ba] shadow-sm dark:bg-slate-800 dark:text-sky-300"
                    : "h-6 cursor-pointer rounded-md px-2.5 text-[10px] font-medium text-[#71869a] hover:text-[#365a78] dark:text-slate-400 dark:hover:text-slate-100"
                }
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 批量操作工具栏 */}
      {selectedSkills.size > 0 && (
        <div className="bg-muted/30 border-border flex items-center gap-3 border-b px-5 py-2 sm:px-6">
          <span className="text-text-secondary text-sm font-medium">
            已选择 {selectedSkills.size} 个
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 border-sky-200 text-sky-700 hover:bg-[var(--gp-surface-from)]"
            onClick={handleSelectAll}
          >
            <CheckSquareIcon className="mr-1 h-3.5 w-3.5" />
            {manageableFilteredSkills.every((s) => selectedSkills.has(s.name))
              ? "取消全选"
              : "全选"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 border-red-200 text-red-700 hover:bg-red-50"
            onClick={() => setBatchDeleteConfirm(true)}
            disabled={batchDelete.isPending}
          >
            <Trash2Icon className="mr-1 h-3.5 w-3.5" />
            批量删除
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 border-sky-200 text-sky-700 hover:bg-[var(--gp-surface-from)]"
            onClick={handleBatchExport}
          >
            <DownloadIcon className="mr-1 h-3.5 w-3.5" />
            批量导出
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-text-muted h-7"
            onClick={clearSelection}
          >
            取消
          </Button>
        </div>
      )}

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto px-5 py-4 sm:px-6">
        {isLoading ? (
          <div className="text-muted-foreground flex h-40 items-center justify-center text-sm">
            <LoaderIcon className="mr-2 size-4 animate-spin" />
            {t.common.loading}
          </div>
        ) : adminRequired ? (
          <div className="text-muted-foreground flex h-40 items-center justify-center text-sm">
            {t.settings.skills.adminRequired}
          </div>
        ) : error ? (
          <div className="text-destructive flex h-40 items-center justify-center text-sm">
            {error.message}
          </div>
        ) : filteredSkills.length === 0 ? (
          <div className="bg-card mx-auto flex h-64 max-w-2xl flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-[#cadbe8] px-8 text-center dark:border-slate-700">
            <div className="flex h-14 w-14 items-center justify-center rounded-full border border-sky-200/80 bg-[#eef7ff] shadow-[0_12px_24px_-18px_rgba(39,96,201,0.45)] dark:border-sky-800 dark:bg-sky-950/60">
              <PuzzleIcon className="text-primary h-8 w-8" />
            </div>
            <div>
              <p className="text-foreground text-lg font-semibold">
                {t.settings.skills.emptyTitle}
              </p>
              <p className="text-muted-foreground mt-2 text-sm leading-7">
                {t.settings.skills.emptyDescription}
              </p>
            </div>
            {canManage && (
              <Button
                variant="outline"
                className="mt-2 rounded-lg border-sky-200"
                onClick={() => setCreateDialogOpen(true)}
              >
                <PlusIcon className="mr-1.5 h-4 w-4" />
                {t.settings.skills.emptyButton}
              </Button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
            {filteredSkills.map((skill) => (
              <SkillCard
                key={skill.name}
                skill={skill}
                selected={selectedSkills.has(skill.name)}
                onToggleSelect={
                  (skill.can_manage ?? skill.editable)
                    ? () => toggleSelect(skill.name)
                    : undefined
                }
                onViewDetail={() => setDetailSkill(skill)}
                onEdit={() => setEditSkill(skill)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 技能详情弹窗（点卡片打开） */}
      {detailSkill && (
        <SkillDetailDialog
          skill={detailSkill}
          open={!!detailSkill}
          onOpenChange={(open) => {
            if (!open) setDetailSkill(null);
          }}
        />
      )}

      {/* 技能编辑器弹窗（管理员更多菜单"编辑"打开） */}
      {editSkill && (
        <SkillEditorDialog
          skill={editSkill}
          open={!!editSkill}
          onOpenChange={(open) => {
            if (!open) setEditSkill(null);
          }}
        />
      )}

      {/* 导入技能弹窗 */}
      <ImportSkillDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
      />

      {/* 新建技能弹窗 */}
      <CreateSkillDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />

      {/* 批量删除确认弹窗 */}
      <Dialog open={batchDeleteConfirm} onOpenChange={setBatchDeleteConfirm}>
        <DialogContent className="glass-panel border-[color:var(--gp-border)]">
          <DialogHeader>
            <DialogTitle>批量删除技能</DialogTitle>
            <DialogDescription>
              确定要删除选中的 {selectedSkills.size} 个技能吗？此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBatchDeleteConfirm(false)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={handleBatchDelete}
              disabled={batchDelete.isPending}
            >
              {batchDelete.isPending ? (
                <LoaderIcon className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Trash2Icon className="mr-1.5 h-4 w-4" />
              )}
              批量删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

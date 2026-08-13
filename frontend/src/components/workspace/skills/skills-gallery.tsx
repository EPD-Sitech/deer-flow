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
    <div className="flex size-full flex-col">
      {/* 页面头部 */}
      <div className="shrink-0 border-b">
        <header className="flex flex-col gap-4 px-5 py-4 sm:px-6 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <h1 className="text-foreground text-[24px] leading-tight font-semibold">
              推荐技能
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              试试推荐业务技能与能力
            </p>
          </div>
          <div className="flex w-full flex-col gap-2 sm:flex-row xl:w-auto">
            <div className="relative min-w-0 flex-1 sm:w-[280px] xl:w-[320px]">
              <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2" />
              <Input
                className="bg-background text-foreground placeholder:text-muted-foreground h-9 rounded-md border pl-9 text-sm shadow-none"
                placeholder="搜索技能..."
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </div>
            {canManage ? (
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button
                  variant="outline"
                  className="text-foreground h-9 flex-1 px-3 text-xs sm:flex-none"
                  onClick={() => setImportDialogOpen(true)}
                >
                  <UploadIcon className="mr-1.5 size-3.5" />
                  导入技能
                </Button>
                <Button
                  className="bg-primary text-primary-foreground hover:bg-primary/90 h-9 flex-1 px-3 text-xs sm:flex-none"
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
      <div className="flex shrink-0 flex-col gap-3 border-b px-5 py-3 sm:px-6 xl:flex-row xl:items-center xl:justify-between">
        <div className="-mx-1 flex max-w-full gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
          <button
            type="button"
            onClick={() => setCategoryFilter("all")}
            className={`h-7 shrink-0 cursor-pointer rounded-[7px] border px-[9px] text-[10px] font-medium transition-colors ${
              categoryFilter === "all"
                ? "bg-accent text-foreground border-foreground/20 font-semibold"
                : "text-muted-foreground hover:bg-muted hover:text-foreground border-transparent bg-transparent"
            }`}
          >
            全部分类
          </button>
          {SKILL_CATEGORIES.map((category) => (
            <button
              key={category.id}
              type="button"
              onClick={() => setCategoryFilter(category.id)}
              className={`h-7 shrink-0 cursor-pointer rounded-[7px] border px-[9px] text-[10px] font-medium transition-colors ${
                categoryFilter === category.id
                  ? "bg-accent text-foreground border-foreground/20 font-semibold"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground border-transparent bg-transparent"
              }`}
            >
              {category.label}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between gap-3 xl:justify-end">
          <span className="text-muted-foreground shrink-0 text-[11px]">
            {filteredSkills.length} 个技能
          </span>
          <div className="bg-muted inline-flex h-8 items-center gap-0.5 rounded-[8px] border p-0.5">
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
                className={`h-6 cursor-pointer rounded-[6px] px-2.5 text-[10px] font-medium transition-colors ${
                  scopeFilter === value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 批量操作工具栏 */}
      {selectedSkills.size > 0 && (
        <div className="flex items-center gap-3 border-b px-5 py-2 sm:px-6">
          <span className="text-foreground text-sm font-medium">
            已选择 {selectedSkills.size} 个
          </span>
          <Button
            size="sm"
            variant="outline"
            className="text-foreground h-7"
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
            className="text-destructive hover:bg-destructive/10 h-7 border-destructive/30"
            onClick={() => setBatchDeleteConfirm(true)}
            disabled={batchDelete.isPending}
          >
            <Trash2Icon className="mr-1 h-3.5 w-3.5" />
            批量删除
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-foreground h-7"
            onClick={handleBatchExport}
          >
            <DownloadIcon className="mr-1 h-3.5 w-3.5" />
            批量导出
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground h-7"
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
          <div className="mx-auto flex h-64 max-w-2xl flex-col items-center justify-center gap-4 rounded-[14px] border border-dashed px-8 text-center">
            <div className="bg-muted flex h-14 w-14 items-center justify-center rounded-full">
              <PuzzleIcon className="text-muted-foreground h-7 w-7" />
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
              <Button variant="outline" className="mt-2" onClick={() => setCreateDialogOpen(true)}>
                <PlusIcon className="mr-1.5 h-4 w-4" />
                {t.settings.skills.emptyButton}
              </Button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3.5">
            {filteredSkills.map((skill) => (
              <SkillCard
                key={skill.name}
                skill={skill}
                selected={selectedSkills.has(skill.name)}
                onToggleSelect={
                  skill.can_manage ?? skill.editable
                    ? () => toggleSelect(skill.name)
                    : undefined
                }
                onViewDetail={() => setDetailSkill(skill)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 技能详情弹窗 */}
      {detailSkill && (
        <SkillDetailDialog
          skill={detailSkill}
          open={!!detailSkill}
          onOpenChange={(open) => {
            if (!open) setDetailSkill(null);
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
        <DialogContent className="glass-panel border-border">
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

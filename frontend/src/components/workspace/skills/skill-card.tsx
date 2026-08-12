"use client";

import {
  DownloadIcon,
  EyeIcon,
  LoaderIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PuzzleIcon,
  SettingsIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useState,
} from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/core/auth/AuthProvider";
import { SKILL_CATEGORIES } from "@/core/skills/categories";
import {
  useDeleteSkill,
  useGenerateSkillMetadata,
  useUpdateSkillCategory,
} from "@/core/skills/extended";
import { exportInstalledSkill } from "@/core/skills/extended";
import { useEnableSkill } from "@/core/skills/hooks";
import type { Skill } from "@/core/skills/type";
import { env } from "@/env";

const SKILL_ACCENTS: Record<string, string> = {
  customer_insight: "#2d9ab7",
  industry_market: "#4388cf",
  product_factory: "#419bff",
  trading_assist: "#6571d8",
  compliance_risk: "#35a894",
  data_analysis: "#4f7fd1",
  operations_finance: "#4d91b7",
  enterprise_office: "#8b72e8",
  other: "#5d8db9",
};

const SKILL_TINTS: Record<string, string> = {
  customer_insight: "#edfafd",
  industry_market: "#eff7ff",
  product_factory: "#eef7ff",
  trading_assist: "#f1f2ff",
  compliance_risk: "#ecfaf8",
  data_analysis: "#eff5ff",
  operations_finance: "#edf9fb",
  enterprise_office: "#f3f0ff",
  other: "#eff6fb",
};

const MENU_ITEM_CLASS =
  "h-[34px] rounded-[7px] px-[9px] py-0 text-[10px] font-normal text-[#5d7185] focus:bg-[#f0f6fb] focus:text-[#1d6da8] hover:bg-[#f0f6fb] hover:text-[#1d6da8] [&_svg]:size-[15px]";
const MENU_DANGER_ITEM_CLASS =
  "mt-1 rounded-t-none rounded-b-[7px] border-t border-[#f2dede] text-[#e04a52] focus:bg-[#fff3f3] focus:text-[#d9343f] hover:bg-[#fff3f3] hover:text-[#d9343f]";

function scopeLabel(scope: string | undefined): string {
  if (scope === "user") return "自定义";
  if (scope === "legacy") return "旧版";
  return "公共";
}

interface SkillCardProps {
  skill: Skill;
  selected?: boolean;
  onToggleSelect?: () => void;
  onViewDetail?: () => void;
}

export function SkillCard({
  skill,
  selected,
  onToggleSelect,
  onViewDetail,
}: SkillCardProps) {
  const { user } = useAuth();
  const isAdmin = user?.system_role === "admin";
  const { mutate: enableSkill } = useEnableSkill();
  const deleteSkillMutation = useDeleteSkill();
  const generateMetadataMutation = useGenerateSkillMetadata();
  const updateCategoryMutation = useUpdateSkillCategory();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [displayNameValue, setDisplayNameValue] = useState(
    skill.display_name ?? skill.name,
  );
  const [categoryValue, setCategoryValue] = useState(
    skill.skill_category ?? "other",
  );

  const displayName = skill.display_name ?? skill.name;
  const displayDesc = skill.description_zh ?? skill.description ?? "";
  const skillCategory = skill.skill_category ?? "other";
  const skillAccent = SKILL_ACCENTS[skillCategory] ?? SKILL_ACCENTS.other;
  const skillTint = SKILL_TINTS[skillCategory] ?? SKILL_TINTS.other;
  const categoryLabel =
    SKILL_CATEGORIES.find((item) => item.id === skillCategory)?.label ?? "其他";
  const metaLabel =
    skill.name !== displayName ? skill.name : (skill.category_label ?? categoryLabel);
  const displayTags = Array.from(new Set(skill.tags ?? [])).slice(0, 2);
  const canManage = (skill.can_manage ?? skill.editable) && isAdmin;

  useEffect(() => {
    setDisplayNameValue(skill.display_name ?? skill.name);
    setCategoryValue(skill.skill_category ?? "other");
  }, [skill.name, skill.display_name, skill.skill_category]);

  function handleToggleEnabled() {
    enableSkill({ skillName: skill.name, enabled: !skill.enabled });
  }

  async function handleDelete() {
    try {
      await deleteSkillMutation.mutateAsync(skill.name);
      toast.success(`技能「${skill.name}」已删除`);
      setDeleteOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleGenerateMetadata() {
    try {
      await generateMetadataMutation.mutateAsync(skill.name);
      toast.success(`已为「${displayName}」生成中文元数据`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleUpdateCategory() {
    const nextDisplayName = displayNameValue.trim();
    if (!nextDisplayName) {
      toast.error("Skill 名称不能为空");
      return;
    }
    try {
      await updateCategoryMutation.mutateAsync({
        skillName: skill.name,
        displayName: nextDisplayName,
        category: categoryValue,
        tags: skill.tags ?? [],
      });
      toast.success(`已更新设置：${nextDisplayName}`);
      setCategoryOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleExport() {
    try {
      const { blob, filename } = await exportInstalledSkill(skill.name, "zip");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename || `${skill.name}.skill.zip`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`技能「${skill.name}」已导出`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  function handleCardClick(event: MouseEvent<HTMLDivElement>) {
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("button, input, [role='menuitem']")
    ) {
      return;
    }
    onViewDetail?.();
  }

  function handleCardKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onViewDetail?.();
    }
  }

  return (
    <>
      <Card
        className={`skill-module-card group relative h-[176px] cursor-pointer gap-0 overflow-hidden rounded-[12px] border-[#d8e5ef] py-0 shadow-[0_1px_2px_rgba(15,56,94,0.05)] transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-[3px] hover:border-[#9bc9ed] hover:shadow-[0_16px_34px_rgba(38,91,139,0.12)] focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-sky-300 ${skill.enabled ? "" : "opacity-90"}`}
        style={
          {
            "--skill-accent": skillAccent,
            "--skill-tint": skillTint,
          } as CSSProperties
        }
        role={onViewDetail ? "button" : undefined}
        tabIndex={onViewDetail ? 0 : undefined}
        onClick={handleCardClick}
        onKeyDown={handleCardKeyDown}
      >
        {onToggleSelect && (
          <div className="absolute top-3 right-[78px] z-20">
            <input
              type="checkbox"
              checked={selected ?? false}
              onChange={onToggleSelect}
              onClick={(event) => event.stopPropagation()}
              aria-label={`选择 ${displayName}`}
              className="border-border size-3.5 cursor-pointer rounded text-sky-600 opacity-0 transition-opacity group-hover:opacity-100"
              style={selected ? { opacity: 1 } : undefined}
            />
          </div>
        )}
        <div className="relative z-10 h-full p-3.5 pb-2.5">
          <div className="flex min-w-0 items-center gap-2.5 pr-[76px]">
            <div
              className={`flex size-[38px] shrink-0 items-center justify-center rounded-full border-2 border-white/90 text-[color:var(--skill-accent)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--skill-accent)_24%,#d7e4ee),0_6px_14px_rgba(44,98,146,0.09)] dark:border-slate-700 ${
                skill.enabled
                  ? "bg-[color-mix(in_srgb,var(--skill-accent)_18%,white)]"
                  : "bg-slate-100 text-slate-400 dark:bg-slate-800"
              }`}
            >
              <PuzzleIcon className="size-[18px] stroke-[1.9]" />
            </div>
            <div className="min-w-0">
              <h2
                className={`truncate text-[12.5px] leading-5 font-semibold ${
                  skill.enabled
                    ? "text-[#173a5b] dark:text-slate-100"
                    : "text-[#7e90a2] dark:text-slate-400"
                }`}
              >
                {displayName}
              </h2>
              <p className="mt-0.5 truncate text-[9px] text-[#8b9bad] dark:text-slate-500">
                {metaLabel}
              </p>
            </div>
          </div>

          {displayDesc && (
            <p
              className={`mt-2 line-clamp-2 h-8 pr-2 text-[10px] leading-[1.65] ${
                skill.enabled
                  ? "text-[#6d8093] dark:text-slate-300"
                  : "text-[#9aa9b8] dark:text-slate-500"
              }`}
            >
              {displayDesc}
            </p>
          )}

          <div className="absolute right-[78px] bottom-3 left-3.5 flex min-w-0 gap-1 overflow-hidden">
            <span
              className={`max-w-20 truncate rounded-full px-2 py-0.5 text-[9px] font-medium ${
                skill.scope === "user"
                  ? "bg-[#f3f0ff] text-[#6d4bd1]"
                  : "bg-[#ebf4ff] text-[#2582ea]"
              }`}
            >
              {scopeLabel(skill.scope)}
            </span>
            <span className="max-w-20 truncate rounded-full bg-[#eef2f6] px-2 py-0.5 text-[9px] font-medium text-[#68798b]">
              {categoryLabel}
            </span>
            {displayTags.map((tag, index) => (
              <span
                key={tag}
                className={`max-w-20 truncate rounded-full px-2 py-0.5 text-[9px] font-medium ${
                  index % 2 === 0
                    ? "bg-[#e0fdf6] text-[#1a9c82]"
                    : "bg-[#fff5e9] text-[#c46b13]"
                }`}
              >
                {tag}
              </span>
            ))}
          </div>

          <span
            className={`absolute right-3.5 bottom-3 inline-flex items-center gap-1 text-[9px] font-semibold ${
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
        </div>

        <div className="absolute top-2.5 right-2.5 z-20 flex items-center gap-1">
          <Switch
            checked={skill.enabled}
            onCheckedChange={handleToggleEnabled}
            onClick={(event) => event.stopPropagation()}
            className="h-[19px] w-[34px] data-[state=checked]:bg-[#419bff]"
            disabled={
              env.NEXT_PUBLIC_STATIC_WEBSITE_ONLY === "true" || !isAdmin
            }
            aria-label={`${skill.enabled ? "停用" : "启用"}技能：${displayName}`}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex size-[26px] cursor-pointer items-center justify-center rounded-[7px] text-[#8b9cad] transition-colors hover:bg-[#edf4fa] hover:text-[#356b96] dark:hover:bg-slate-800 dark:hover:text-slate-100"
                aria-label={`${displayName} 更多操作`}
                title="更多操作"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
              >
                <MoreHorizontalIcon className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-[152px] min-w-[152px] rounded-[11px] border-[#d8e4ee] bg-[rgba(255,255,255,0.98)] p-1.5 shadow-[0_16px_36px_rgba(27,67,104,0.16)] backdrop-blur-none dark:border-slate-700 dark:bg-slate-900/95 dark:shadow-[0_16px_36px_rgba(0,0,0,0.3)]"
            >
              <DropdownMenuItem
                className={MENU_ITEM_CLASS}
                onSelect={() => onViewDetail?.()}
              >
                <EyeIcon />
                查看详情
              </DropdownMenuItem>
              <DropdownMenuItem
                className={MENU_ITEM_CLASS}
                onSelect={handleExport}
              >
                <DownloadIcon />
                导出 Zip
              </DropdownMenuItem>
              {canManage && (
                <>
                  <DropdownMenuItem
                    className={MENU_ITEM_CLASS}
                    onSelect={handleGenerateMetadata}
                    disabled={generateMetadataMutation.isPending}
                  >
                    {generateMetadataMutation.isPending ? (
                      <LoaderIcon className="animate-spin" />
                    ) : (
                      <SparklesIcon />
                    )}
                    生成中文元数据
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className={MENU_ITEM_CLASS}
                    onSelect={() => setCategoryOpen(true)}
                  >
                    <SettingsIcon />
                    编辑设置
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className={`${MENU_ITEM_CLASS} ${MENU_DANGER_ITEM_CLASS}`}
                    variant="destructive"
                    onSelect={() => setDeleteOpen(true)}
                    disabled={deleteSkillMutation.isPending}
                  >
                    <Trash2Icon />
                    删除技能
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </Card>

      {/* 编辑设置弹窗 */}
      <Dialog open={categoryOpen} onOpenChange={setCategoryOpen}>
        <DialogContent
          showCloseButton={false}
          className="max-h-[calc(100dvh-32px)] gap-0 overflow-hidden rounded-[14px] border-[#d8e4ee] bg-white p-0 shadow-[0_24px_70px_rgba(27,67,104,0.2)] backdrop-blur-none sm:max-w-[560px] dark:border-slate-700 dark:bg-slate-950"
        >
          <header className="flex items-start gap-[11px] border-b border-[#edf2f7] bg-[linear-gradient(120deg,#f7fbff,#eef6ff_70%,#f9fcff)] px-6 pt-5 pb-[15px] dark:border-slate-800 dark:bg-[linear-gradient(120deg,#172033,#0f172a_70%,#111827)]">
            <div className="grid size-[38px] shrink-0 place-items-center rounded-[11px] bg-[linear-gradient(145deg,#e2f0ff,#cfe6ff)] text-[#2582ea] shadow-[inset_0_0_0_1px_rgba(65,155,255,0.18)] dark:bg-[linear-gradient(145deg,#1e3a5f,#172b47)] dark:text-sky-300">
              <SettingsIcon className="size-[19px]" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="truncate text-[17px] leading-6 font-semibold text-[#173b5e] dark:text-slate-100">
                技能设置 · {displayName}
              </DialogTitle>
              <DialogDescription className="mt-[3px] text-[10px] text-[#8496a8] dark:text-slate-400">
                修改技能名称与类型，保存后立即生效
              </DialogDescription>
            </div>
            <button
              type="button"
              className="ml-auto grid size-7 shrink-0 cursor-pointer place-items-center rounded-[7px] text-lg leading-none text-[#8b9cad] transition-colors hover:bg-[#edf4fa] hover:text-[#356b96] dark:hover:bg-slate-800 dark:hover:text-slate-100"
              aria-label="关闭"
              onClick={() => setCategoryOpen(false)}
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
                <label
                  className="mb-1.5 block text-[10px] font-semibold text-[#5d7185] dark:text-slate-300"
                  htmlFor={`skill-name-${skill.name}`}
                >
                  技能名称
                </label>
                <Input
                  id={`skill-name-${skill.name}`}
                  value={displayNameValue}
                  onChange={(event) => setDisplayNameValue(event.target.value)}
                  placeholder={skill.name}
                  className="h-[38px] rounded-[9px] border-[#d3e1ee] bg-white px-3 text-sm text-[#1e293b] shadow-none transition focus-visible:border-[#87bdf0] focus-visible:ring-2 focus-visible:ring-[rgba(65,155,255,0.13)] dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                />
                <label
                  className="mt-[13px] mb-1.5 block text-[10px] font-semibold text-[#5d7185] dark:text-slate-300"
                  htmlFor={`skill-category-${skill.name}`}
                >
                  技能分类
                </label>
                <select
                  id={`skill-category-${skill.name}`}
                  value={categoryValue}
                  onChange={(event) => setCategoryValue(event.target.value)}
                  className="h-[38px] w-full cursor-pointer rounded-[9px] border border-[#d3e1ee] bg-white px-3 text-sm text-[#1e293b] shadow-none transition focus:border-[#87bdf0] focus:ring-2 focus:ring-[rgba(65,155,255,0.13)] focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
                >
                  {SKILL_CATEGORIES.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.label}
                    </option>
                  ))}
                </select>
              </div>
            </section>
          </div>

          <footer className="flex items-center justify-end gap-2 border-t border-[#edf2f7] bg-white px-6 py-3.5 dark:border-slate-800 dark:bg-slate-950">
            <Button
              variant="outline"
              className="h-9 rounded-[9px] border-[#d3e1ee] bg-white px-4 text-xs text-[#49677f] shadow-none hover:bg-[#f3f8fc] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              onClick={() => setCategoryOpen(false)}
              disabled={updateCategoryMutation.isPending}
            >
              取消
            </Button>
            <Button
              className="h-9 rounded-[9px] bg-[linear-gradient(145deg,#2587ea,#419bff)] px-4 text-xs text-white shadow-[0_7px_16px_rgba(37,130,234,0.24)] hover:opacity-95"
              onClick={handleUpdateCategory}
              disabled={updateCategoryMutation.isPending}
            >
              {updateCategoryMutation.isPending ? "保存中..." : "保存"}
            </Button>
          </footer>
        </DialogContent>
      </Dialog>

      {/* 删除确认弹窗 */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="glass-panel">
          <DialogHeader>
            <DialogTitle>删除技能</DialogTitle>
            <DialogDescription>
              确定要删除技能「{skill.name}」吗？此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteSkillMutation.isPending}
            >
              {deleteSkillMutation.isPending ? (
                <LoaderIcon className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Trash2Icon className="mr-1.5 h-4 w-4" />
              )}
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

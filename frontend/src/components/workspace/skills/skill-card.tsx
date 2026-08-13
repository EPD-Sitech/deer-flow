"use client";

import {
  BotIcon,
  CheckIcon,
  DownloadIcon,
  EyeIcon,
  LayoutGridIcon,
  LoaderIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PuzzleIcon,
  SettingsIcon,
  Trash2Icon,
  UsersIcon,
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
  "text-muted-foreground h-[34px] rounded-[7px] px-[9px] py-0 text-[10px] font-normal hover:bg-accent hover:text-foreground focus:bg-accent focus:text-foreground [&_svg]:size-[15px]";
const MENU_DANGER_ITEM_CLASS =
  "text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive mt-1 rounded-t-none rounded-b-[7px] border-t border-destructive/20";

const CATEGORY_CHIP_CLASS =
  "hover:border-foreground/30 hover:text-foreground h-8 cursor-pointer rounded-[8px] border px-[13px] text-[10px] transition-colors";

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
        className={`skill-module-card group relative h-[176px] cursor-pointer gap-0 overflow-hidden rounded-[12px] border py-0 shadow-[0_1px_2px_rgba(15,56,94,0.05)] transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-[3px] hover:border-foreground/20 hover:shadow-[0_16px_34px_rgba(38,91,139,0.12)] focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-sky-300 ${skill.enabled ? "" : "opacity-90"}`}
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
                    ? "text-foreground"
                    : "text-muted-foreground"
                }`}
              >
                {displayName}
              </h2>
              <p className="text-muted-foreground mt-0.5 truncate text-[9px]">
                {metaLabel}
              </p>
            </div>
          </div>

          {displayDesc && (
            <p
              className={`mt-2 line-clamp-2 h-8 pr-2 text-[10px] leading-[1.65] ${
                skill.enabled
                  ? "text-muted-foreground"
                  : "text-muted-foreground/70"
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
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {scopeLabel(skill.scope)}
            </span>
            <span className="bg-muted text-foreground max-w-20 truncate rounded-full px-2 py-0.5 text-[9px] font-medium">
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
        </div>

        <div className="absolute top-2.5 right-2.5 z-20 flex items-center gap-1">
          <Switch
            checked={skill.enabled}
            onCheckedChange={handleToggleEnabled}
            onClick={(event) => event.stopPropagation()}
            className="h-[19px] w-[34px]"
            disabled={
              env.NEXT_PUBLIC_STATIC_WEBSITE_ONLY === "true" || !isAdmin
            }
            aria-label={`${skill.enabled ? "停用" : "启用"}技能：${displayName}`}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="text-muted-foreground inline-flex size-[26px] cursor-pointer items-center justify-center rounded-[7px] transition-colors hover:bg-accent hover:text-foreground"
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
              className="bg-popover text-popover-foreground w-[152px] min-w-[152px] rounded-[11px] border p-1.5 shadow-[0_16px_36px_rgba(27,67,104,0.16)]"
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
          className="max-h-[calc(100dvh-32px)] gap-0 overflow-hidden rounded-[14px] border bg-background p-0 shadow-[0_24px_70px_rgba(27,67,104,0.2)] backdrop-blur-none sm:max-w-[560px]"
        >
          <header className="flex items-start gap-[11px] border-b bg-transparent px-6 pt-5 pb-[15px]">
            <div className="bg-muted text-muted-foreground grid size-[38px] shrink-0 place-items-center rounded-[11px]">
              <SettingsIcon className="size-[19px]" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-foreground truncate text-[17px] leading-6 font-semibold">
                技能设置 · {displayName}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground mt-[3px] text-[10px]">
                修改技能名称与类型，保存后立即生效
              </DialogDescription>
            </div>
            <button
              type="button"
              className="text-muted-foreground hover:bg-accent hover:text-foreground ml-auto grid size-7 shrink-0 cursor-pointer place-items-center rounded-[7px] text-lg leading-none transition-colors"
              aria-label="关闭"
              onClick={() => setCategoryOpen(false)}
            >
              ×
            </button>
          </header>

          <div className="max-h-[calc(100dvh-260px)] overflow-auto bg-background px-6 pt-4 pb-1.5">
            <section className="mb-3.5 overflow-hidden rounded-[12px] border bg-background shadow-[0_1px_2px_rgba(15,56,94,0.05)]">
              <div className="flex h-11 items-center gap-2.5 border-b bg-muted/40 px-3.5">
                <PencilIcon className="text-muted-foreground size-4" />
                <b className="text-foreground text-xs font-semibold">
                  基础信息
                </b>
              </div>
              <div className="p-3.5">
                <label
                  className="text-muted-foreground mb-1.5 block text-[10px] font-semibold"
                  htmlFor={`skill-name-${skill.name}`}
                >
                  技能名称
                </label>
                <Input
                  id={`skill-name-${skill.name}`}
                  value={displayNameValue}
                  onChange={(event) => setDisplayNameValue(event.target.value)}
                  placeholder={skill.name}
                  className="border-input bg-background h-[38px] rounded-[9px] px-3 text-sm shadow-none transition"
                />
                <div className="mt-[13px] grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {(
                    [
                      {
                        value: "public",
                        title: "公共",
                        desc: "所有人可见",
                        icon: UsersIcon,
                      },
                      {
                        value: "personal",
                        title: "个人",
                        desc: "仅创建者可见",
                        icon: BotIcon,
                      },
                    ] as const
                  ).map((scope) => {
                    const Icon = scope.icon;
                    const active =
                      scope.value === "public"
                        ? skill.scope === "public"
                        : skill.scope !== "public";
                    return (
                      <button
                        key={scope.value}
                        type="button"
                        aria-pressed={active}
                        className={`relative flex cursor-default items-center gap-2.5 rounded-[10px] border p-[11px_13px] text-left transition-colors ${
                          active
                            ? "border-foreground/30 bg-accent"
                            : "border-border bg-background"
                        }`}
                      >
                        <Icon
                          className={`size-[17px] shrink-0 ${
                            active ? "text-foreground" : "text-muted-foreground"
                          }`}
                        />
                        <span>
                          <b className="text-foreground block text-[11px] font-semibold">
                            {scope.title}
                          </b>
                          <small className="text-muted-foreground block text-[8.5px]">
                            {scope.desc}
                          </small>
                        </span>
                        <span
                          className={`absolute top-2 right-2 grid size-4 place-items-center rounded-full bg-foreground text-background transition ${
                            active
                              ? "scale-100 opacity-100"
                              : "scale-75 opacity-0"
                          }`}
                        >
                          <CheckIcon className="size-2.5" />
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>

            <section className="mb-3.5 overflow-hidden rounded-[12px] border bg-background shadow-[0_1px_2px_rgba(15,56,94,0.05)]">
              <div className="flex h-11 items-center gap-2.5 border-b bg-muted/40 px-3.5">
                <LayoutGridIcon className="text-muted-foreground size-4" />
                <b className="text-foreground text-xs font-semibold">
                  类型
                </b>
                <span className="bg-muted text-muted-foreground ml-auto rounded-full px-2 py-0.5 text-[9px] font-bold">
                  1
                </span>
              </div>
              <div className="p-3.5">
                <div className="flex flex-wrap gap-2">
                  {SKILL_CATEGORIES.map((category) => {
                    const active = categoryValue === category.id;
                    return (
                      <button
                        key={category.id}
                        type="button"
                        className={`${CATEGORY_CHIP_CLASS} ${
                          active
                            ? "border-foreground/30 bg-accent font-bold text-foreground"
                            : "border-border bg-background text-muted-foreground"
                        }`}
                        onClick={() => setCategoryValue(category.id)}
                      >
                        {category.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </section>
          </div>

          <footer className="flex justify-end gap-2 border-t bg-background px-6 pt-3 pb-[18px]">
            <Button
              variant="outline"
              className="h-9 px-3.5 text-[11px] font-semibold"
              onClick={() => setCategoryOpen(false)}
            >
              取消
            </Button>
            <Button
              className="bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-3.5 text-[11px] font-semibold"
              onClick={handleUpdateCategory}
              disabled={updateCategoryMutation.isPending}
            >
              {updateCategoryMutation.isPending ? (
                <LoaderIcon className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <SettingsIcon className="mr-2 h-4 w-4" />
              )}
              保存修改
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

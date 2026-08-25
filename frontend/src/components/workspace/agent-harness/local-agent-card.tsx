"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  CalendarClockIcon,
  CopyIcon,
  DownloadIcon,
  EyeIcon,
  FileEditIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  SettingsIcon,
  Share2Icon,
  Trash2Icon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  useMemo,
  useEffect,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { AgentSettingsDialog } from "@/components/workspace/agents/agent-settings-dialog";
import { useDeleteAgent } from "@/core/agents";
import type { Agent } from "@/core/agents";
import { useI18n } from "@/core/i18n/hooks";

import {
  AGENT_AVATAR_UPDATED_EVENT,
  AgentAvatar,
} from "./agent-avatar";
import {
  cloneAgent,
  deletePlatformAgent,
  downloadBlob,
  exportAgent,
  type AgentScope,
  type LocalAgentCatalogItem,
} from "./agent-management-api";
import {
  getLocalAgentCategoryIds,
  getLocalAgentCategoryLabel,
} from "./local-agent-categories";
import { LocalAgentDetailDialog } from "./local-agent-detail-dialog";
import { LocalAgentOverviewDialog } from "./local-agent-overview-dialog";
import { LocalAgentShareDialog } from "./local-agent-share-dialog";

const CATEGORY_COLORS = {
  customer_insight: { accent: "#16819b", tint: "#eaf8fa" },
  industry_market: { accent: "#2e76b7", tint: "#edf6fd" },
  product_factory: { accent: "#267bc5", tint: "#eef6fd" },
  trading_assist: { accent: "#5965bd", tint: "#f0f1fb" },
  compliance_risk: { accent: "#168a72", tint: "#eaf8f4" },
  data_analysis: { accent: "#3e6fb8", tint: "#eef4fc" },
  operations_finance: { accent: "#337c9d", tint: "#ebf7f9" },
  enterprise_office: { accent: "#7259bd", tint: "#f2effb" },
  other: { accent: "#477a9e", tint: "#edf5f9" },
} as const;

interface LocalAgentCardProps {
  agent: Agent | LocalAgentCatalogItem;
  selected?: boolean;
  onToggleSelect?: () => void;
}

export function LocalAgentCard({
  agent,
  selected = false,
  onToggleSelect,
}: LocalAgentCardProps) {
  const { locale, t } = useI18n();
  const queryClient = useQueryClient();
  const router = useRouter();
  const deleteAgent = useDeleteAgent();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<"files" | "schedules">("files");
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [deletingPlatform, setDeletingPlatform] = useState(false);
  const [avatarVersion, setAvatarVersion] = useState(0);
  const categoryId = getLocalAgentCategoryIds(agent)[0] ?? "other";
  const categoryLabel = getLocalAgentCategoryLabel(categoryId, locale);
  const colors = CATEGORY_COLORS[categoryId];
  const scope: AgentScope =
    "scope" in agent && agent.scope === "platform" ? "platform" : "user";
  useEffect(() => {
    const handleUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ name?: string; scope?: string }>).detail;
      if (detail?.name === agent.name && detail.scope === scope) setAvatarVersion((value) => value + 1);
    };
    window.addEventListener(AGENT_AVATAR_UPDATED_EVENT, handleUpdate);
    return () => window.removeEventListener(AGENT_AVATAR_UPDATED_EVENT, handleUpdate);
  }, [agent.name, scope]);
  const isPlatform = scope === "platform";
  const runtimeName = "runtime_name" in agent ? agent.runtime_name : agent.name;
  const displayName = agent.display_name ?? agent.name;
  const [cloneName, setCloneName] = useState(`${runtimeName}-copy`);
  const canManage = !("can_manage" in agent) || agent.can_manage;
  const canViewDetails =
    !("can_view_details" in agent) || agent.can_view_details;
  const canEditGuideQuestions =
    "can_edit_guide_questions" in agent && agent.can_edit_guide_questions;
  const canEdit = !("can_edit" in agent) || agent.can_edit;
  const canDelete = !("can_delete" in agent) || agent.can_delete;
  const canExport = !("can_export" in agent) || agent.can_export;
  const canClone = !("can_clone" in agent) || agent.can_clone;
  const canShare = !("can_share" in agent) || agent.can_share;
  const hasActions =
    canManage || canExport || canClone || canShare || canEdit || canDelete;
  const scopeLabel =
    "scope" in agent && agent.scope === "platform"
      ? locale.startsWith("zh")
        ? "公共"
        : "Public"
      : locale.startsWith("zh")
        ? "自定义"
        : "Custom";
  const text = locale.startsWith("zh")
    ? {
        local: "本地",
        more: "更多操作",
        fallback: "为复杂任务提供专业分析与执行支持。",
        chatWith: `与 ${displayName} 对话`,
      }
    : {
        local: "Local",
        more: "More actions",
        fallback: "Specialized analysis and execution for complex tasks.",
        chatWith: `Chat with ${displayName}`,
      };
  const displayTags = useMemo(
    () =>
      Array.from(new Set([categoryLabel, ...(agent.tool_groups ?? [])])).slice(
        0,
        3,
      ),
    [agent.tool_groups, categoryLabel],
  );

  function handleChat() {
    router.push(
      `/workspace/agents/${encodeURIComponent(runtimeName)}/chats/new`,
    );
  }

  function handleOverviewChat(prompt?: string) {
    const query = prompt ? `?prompt=${encodeURIComponent(prompt)}` : "";
    router.push(
      `/workspace/agents/${encodeURIComponent(runtimeName)}/chats/new${query}`,
    );
  }

  function handleCardClick(event: MouseEvent<HTMLDivElement>) {
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest("button, input, a, [role='menuitem']")
    ) {
      return;
    }
    if (canViewDetails) setOverviewOpen(true);
  }

  function handleCardKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (canViewDetails) setOverviewOpen(true);
    }
  }

  async function handleDelete() {
    try {
      if (isPlatform) {
        setDeletingPlatform(true);
        await deletePlatformAgent(agent.name);
      } else {
        await deleteAgent.mutateAsync(agent.name);
      }
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      toast.success(t.agents.deleteSuccess);
      setDeleteOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setDeletingPlatform(false);
    }
  }

  async function handleExport(format: "zip" | "md") {
    try {
      const blob = await exportAgent(agent.name, format, scope);
      await downloadBlob(
        blob,
        `${agent.name}.agent.${format === "zip" ? "zip" : "md"}`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleClone() {
    setCloning(true);
    try {
      await cloneAgent(agent.name, cloneName.trim(), scope);
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      toast.success(locale.startsWith("zh") ? "智能体已克隆" : "Agent cloned");
      setCloneOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setCloning(false);
    }
  }

  return (
    <>
      <Card
        className={`group relative h-44 min-w-0 cursor-pointer gap-0 overflow-hidden rounded-lg border py-0 shadow-[0_9px_22px_-18px_rgba(27,67,104,0.38)] transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-[0_16px_34px_-22px_rgba(27,67,104,0.32)] ${selected ? "ring-2 ring-sky-400" : ""}`}
        role={canViewDetails ? "button" : undefined}
        tabIndex={canViewDetails ? 0 : undefined}
        onClick={handleCardClick}
        onKeyDown={handleCardKeyDown}
        style={
          {
            "--local-agent-accent": colors.accent,
            "--local-agent-tint": colors.tint,
          } as CSSProperties
        }
      >
        <div className="relative h-full p-3.5">
          {onToggleSelect && (
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
              aria-label={`${locale.startsWith("zh") ? "选择" : "Select"} ${displayName}`}
              className={`absolute top-3 right-10 z-10 size-4 cursor-pointer transition-opacity ${selected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
              onClick={(event) => event.stopPropagation()}
            />
          )}
          <div className="flex min-w-0 items-center gap-2.5 pr-8">
            <AgentAvatar
              name={agent.name}
              scope={scope}
              version={avatarVersion}
              alt=""
              className="size-10 shrink-0 rounded-full border border-white object-cover shadow-sm dark:border-slate-700"
            />
            <div className="min-w-0">
              <h2 className="truncate text-[13px] leading-5 font-semibold text-[#173a5b] dark:text-slate-100">
                {displayName}
              </h2>
              <p className="mt-0.5 truncate text-[10px] text-[#8292a3] dark:text-slate-400">
                {scopeLabel} · {categoryLabel}
                {agent.model ? ` · ${agent.model}` : ""}
              </p>
            </div>
          </div>

          <p className="mt-2 line-clamp-2 h-8 pr-2 text-[11px] leading-[1.5] text-[#61768a] dark:text-slate-300">
            {agent.description || text.fallback}
          </p>

          <div className="absolute right-12 bottom-3 left-3.5 flex min-w-0 gap-1 overflow-hidden">
            {displayTags.map((tag, index) => (
              <span
                key={tag}
                className={
                  index === 0
                    ? "max-w-20 truncate rounded-full bg-[color:var(--local-agent-tint)] px-2 py-0.5 text-[9px] font-medium text-[color:var(--local-agent-accent)] dark:bg-slate-800"
                    : "max-w-20 truncate rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                }
              >
                {tag}
              </span>
            ))}
          </div>

          <Button
            size="sm"
            className="absolute right-3 bottom-3 size-8 rounded-lg bg-[#2587ea] p-0 text-white shadow-[0_7px_16px_rgba(37,130,234,0.24)] transition-transform hover:-translate-y-0.5 hover:bg-[#1778d8]"
            onClick={(event) => {
              event.stopPropagation();
              handleChat();
            }}
            title={text.chatWith}
          >
            <MessageSquareIcon className="size-3.5" />
            <span className="sr-only">{t.agents.chat}</span>
          </Button>

          {hasActions && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="absolute top-2.5 right-2.5 inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-[#7b91a5] transition-colors hover:bg-[#edf4fa] hover:text-[#356b96] dark:hover:bg-slate-800 dark:hover:text-slate-100"
                  aria-label={`${displayName}: ${text.more}`}
                  title={text.more}
                  onClick={(event) => event.stopPropagation()}
                >
                  <MoreHorizontalIcon className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="min-w-44 rounded-lg p-1"
              >
                {canShare && (
                  <DropdownMenuItem onSelect={() => setShareOpen(true)}>
                    <Share2Icon />
                    {locale.startsWith("zh") ? "分享" : "Share"}
                  </DropdownMenuItem>
                )}
                {canEdit && (
                  <DropdownMenuItem
                    onSelect={() => {
                      setDetailTab("files");
                      setDetailOpen(true);
                    }}
                  >
                    <FileEditIcon />
                    {locale.startsWith("zh") ? "编辑" : "Edit"}
                  </DropdownMenuItem>
                )}
                {canViewDetails && !canEdit && (
                  <DropdownMenuItem
                    onSelect={() => {
                      setDetailTab("files");
                      setDetailOpen(true);
                    }}
                  >
                    <EyeIcon />
                    {locale.startsWith("zh") ? "查看详情" : "View details"}
                  </DropdownMenuItem>
                )}
                {canManage && (
                  <DropdownMenuItem
                    onSelect={() => {
                      setDetailTab("schedules");
                      setDetailOpen(true);
                    }}
                  >
                    <CalendarClockIcon />
                    {locale.startsWith("zh") ? "定时" : "Schedule"}
                  </DropdownMenuItem>
                )}
                {canClone && (
                  <DropdownMenuItem
                    onSelect={() => {
                      setCloneName(`${runtimeName}-copy`);
                      setCloneOpen(true);
                    }}
                  >
                    <CopyIcon />
                    {locale.startsWith("zh") ? "克隆" : "Clone"}
                  </DropdownMenuItem>
                )}
                {canExport && (
                  <DropdownMenuItem onSelect={() => void handleExport("zip")}>
                    <DownloadIcon />
                    {locale.startsWith("zh") ? "导出" : "Export"}
                  </DropdownMenuItem>
                )}
                {canEdit && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => {
                        setSettingsOpen(true);
                      }}
                    >
                      <SettingsIcon />
                      {t.agents.settings}
                    </DropdownMenuItem>
                  </>
                )}
                {canDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onSelect={() => setDeleteOpen(true)}
                    >
                      <Trash2Icon />
                      {t.agents.delete}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </Card>

      {settingsOpen && (
        <AgentSettingsDialog
          agent={agent}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          scope={scope}
        />
      )}

      {overviewOpen && (
        <LocalAgentOverviewDialog
          agent={agent}
          open={overviewOpen}
          onOpenChange={setOverviewOpen}
          scope={scope}
          accent={colors.accent}
          categoryLabel={categoryLabel}
          capabilities={displayTags}
          onStartChat={handleOverviewChat}
        />
      )}

      {detailOpen && (
        <LocalAgentDetailDialog
          agent={agent}
          open={detailOpen}
          onOpenChange={setDetailOpen}
          initialTab={detailTab}
          scope={scope}
          readOnly={!canEdit}
          canEditGuideQuestions={canEditGuideQuestions}
        />
      )}

      {shareOpen && (
        <LocalAgentShareDialog
          agentName={agent.name}
          scope={scope}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
      )}

      <Dialog open={cloneOpen} onOpenChange={setCloneOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {locale.startsWith("zh") ? "克隆智能体" : "Clone agent"}
            </DialogTitle>
            <DialogDescription>
              {locale.startsWith("zh")
                ? "复制配置、SOUL 与能力绑定，不复制记忆。"
                : "Copies configuration, SOUL, and capabilities without memory."}
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label={
              locale.startsWith("zh") ? "新智能体名称" : "New agent name"
            }
            value={cloneName}
            onChange={(event) => setCloneName(event.target.value)}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCloneOpen(false)}
              disabled={cloning}
            >
              {t.common.cancel}
            </Button>
            <Button
              onClick={() => void handleClone()}
              disabled={cloning || !cloneName.trim()}
            >
              {cloning
                ? t.common.loading
                : locale.startsWith("zh")
                  ? "克隆"
                  : "Clone"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.agents.delete}</DialogTitle>
            <DialogDescription>{t.agents.deleteConfirm}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleteAgent.isPending || deletingPlatform}
            >
              {t.common.cancel}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteAgent.isPending || deletingPlatform}
            >
              {deleteAgent.isPending || deletingPlatform
                ? t.common.loading
                : t.common.delete}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

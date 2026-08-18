"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BotIcon,
  DownloadIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/core/i18n/hooks";

import {
  batchDeleteAgents,
  downloadBlob,
  exportAgentsBatch,
  listAgentCatalog,
  type AgentScope,
} from "./agent-management-api";
import { ImportLocalAgentDialog } from "./import-local-agent-dialog";
import { LocalAgentCard } from "./local-agent-card";
import {
  ALL_LOCAL_AGENT_CATEGORY,
  LOCAL_AGENT_CATEGORIES,
  getLocalAgentCategoryIds,
  getLocalAgentCategoryLabel,
  localAgentMatchesCategory,
  type LocalAgentCategoryId,
} from "./local-agent-categories";

export function LocalAgentGallery() {
  const { locale, t } = useI18n();
  const queryClient = useQueryClient();
  const {
    data: agents = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["agents", "catalog"],
    queryFn: listAgentCatalog,
  });
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(new Set());
  const [batchLoading, setBatchLoading] = useState(false);
  const [scopeFilter, setScopeFilter] = useState<"all" | "platform" | "user">(
    "all",
  );
  const [categoryFilter, setCategoryFilter] = useState<LocalAgentCategoryId>(
    ALL_LOCAL_AGENT_CATEGORY,
  );
  const text = locale.startsWith("zh")
    ? {
        title: "召唤专家",
        description: "召唤你的专属业务专家伙伴",
        search: "搜索专家或描述",
        create: "新建专家",
        count: (count: number) => `${count} 位专家`,
        loadError: "智能体加载失败，请稍后重试。",
      }
    : {
        title: "Local agents",
        description: "Call on your dedicated business expert partners",
        search: "Search agents, capabilities, or use cases",
        create: "New expert",
        count: (count: number) => `${count} specialists`,
        loadError: "Agents could not be loaded. Try again later.",
      };

  const filteredAgents = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return agents.filter((agent) => {
      if (scopeFilter !== "all" && agent.scope !== scopeFilter) return false;
      if (!localAgentMatchesCategory(agent, categoryFilter)) return false;
      if (!query) return true;
      return [
        agent.name,
        agent.description,
        agent.model ?? "",
        ...(agent.tool_groups ?? []),
        ...(agent.skills ?? []),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query);
    });
  }, [agents, categoryFilter, scopeFilter, searchQuery]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<LocalAgentCategoryId, number>();
    counts.set(ALL_LOCAL_AGENT_CATEGORY, agents.length);
    for (const agent of agents) {
      for (const categoryId of getLocalAgentCategoryIds(agent)) {
        counts.set(categoryId, (counts.get(categoryId) ?? 0) + 1);
      }
    }
    return counts;
  }, [agents]);

  const selectedItems = useMemo(
    () =>
      agents.filter((agent) =>
        selectedAgents.has(`${agent.scope}:${agent.name}`),
      ),
    [agents, selectedAgents],
  );

  function toggleSelected(scope: AgentScope, name: string) {
    const key = `${scope}:${name}`;
    setSelectedAgents((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectedNames(scope: AgentScope) {
    return selectedItems
      .filter((agent) => agent.scope === scope)
      .map((agent) => agent.name);
  }

  async function handleBatchExport() {
    setBatchLoading(true);
    try {
      for (const scope of ["user", "platform"] as const) {
        const names = selectedNames(scope);
        if (names.length === 0) continue;
        const blob = await exportAgentsBatch(names, scope);
        await downloadBlob(
          blob,
          scope === "platform"
            ? "public-agents-export.zip"
            : "custom-agents-export.zip",
        );
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBatchLoading(false);
    }
  }

  async function handleBatchDelete() {
    if (
      !window.confirm(
        locale.startsWith("zh")
          ? `确认删除选中的 ${selectedAgents.size} 个智能体？`
          : `Delete ${selectedAgents.size} selected agents?`,
      )
    ) {
      return;
    }
    setBatchLoading(true);
    try {
      const errors: string[] = [];
      for (const scope of ["user", "platform"] as const) {
        const names = selectedNames(scope);
        if (names.length === 0) continue;
        const result = await batchDeleteAgents(names, scope);
        errors.push(...result.errors.map((item) => item.error));
      }
      if (errors.length > 0) {
        toast.error(errors.join(", "));
      } else {
        toast.success(
          locale.startsWith("zh") ? "批量删除完成" : "Agents deleted",
        );
      }
      setSelectedAgents(new Set());
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBatchLoading(false);
    }
  }

  return (
    <div className="bg-background flex size-full min-w-0 flex-col">
      <div className="bg-card shrink-0 border-b">
        <header className="flex flex-col gap-4 px-5 py-4 sm:px-6 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl leading-tight font-semibold text-[#173a5b] dark:text-slate-100">
              {text.title}
            </h1>
            <p className="mt-1 text-sm text-[#71869a] dark:text-slate-400">
              {text.description}
            </p>
          </div>
          <div className="flex w-full flex-col gap-2 sm:flex-row xl:w-auto">
            <div className="relative min-w-0 flex-1 sm:w-72 xl:w-80">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-[#89a0b3] dark:text-slate-500" />
              <Input
                className="bg-background h-9 rounded-lg border-[#d8e5ef] pl-9 text-xs text-[#34495e] shadow-none placeholder:text-[#9badbf] focus-visible:border-[#86bae1] focus-visible:ring-2 focus-visible:ring-sky-200/50 dark:border-slate-700 dark:text-slate-100"
                placeholder={text.search}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
            </div>
            <Button
              variant="outline"
              className="h-9 shrink-0 rounded-lg px-3 text-xs"
              onClick={() => setImportOpen(true)}
            >
              <UploadIcon className="size-3.5" />
              {locale.startsWith("zh") ? "导入" : "Import"}
            </Button>
            <Button
              className="h-9 shrink-0 rounded-lg bg-[#2587ea] px-3 text-xs text-white shadow-[0_7px_16px_rgba(37,130,234,0.24)] hover:bg-[#1778d8]"
              onClick={() => router.push("/workspace/agents/new")}
            >
              <PlusIcon className="mr-1.5 size-3.5" />
              {text.create}
            </Button>
          </div>
        </header>

        <div className="flex flex-col gap-3 border-t border-[#edf2f6] px-5 py-3 sm:px-6 xl:flex-row xl:items-center xl:justify-between dark:border-slate-800">
          <div className="-mx-1 flex max-w-full gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
            {LOCAL_AGENT_CATEGORIES.map((category) => {
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
                  {getLocalAgentCategoryLabel(category.id, locale)}
                  <span className="ml-1 opacity-65">
                    {categoryCounts.get(category.id) ?? 0}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center justify-between gap-3 xl:justify-end">
            <span className="shrink-0 text-[11px] text-[#8295a7] dark:text-slate-400">
              {text.count(filteredAgents.length)}
            </span>
            <div className="inline-flex h-8 items-center gap-0.5 rounded-lg border border-[#d8e5ef] bg-[#f6f8fb] p-0.5 dark:border-slate-700 dark:bg-slate-900">
              {(
                [
                  ["all", locale.startsWith("zh") ? "全部" : "All"],
                  ["platform", locale.startsWith("zh") ? "公共" : "Public"],
                  ["user", locale.startsWith("zh") ? "自定义" : "Custom"],
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
      </div>

      {selectedAgents.size > 0 && (
        <div className="bg-muted/30 flex shrink-0 flex-wrap items-center gap-2 border-b px-5 py-2 sm:px-6">
          <span className="mr-1 text-xs font-medium">
            {locale.startsWith("zh")
              ? `已选择 ${selectedAgents.size} 个`
              : `${selectedAgents.size} selected`}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={batchLoading}
            onClick={() => void handleBatchExport()}
          >
            <DownloadIcon className="size-3.5" />
            {locale.startsWith("zh") ? "批量导出" : "Export"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs text-red-600"
            disabled={batchLoading}
            onClick={() => void handleBatchDelete()}
          >
            <Trash2Icon className="size-3.5" />
            {locale.startsWith("zh") ? "批量删除" : "Delete"}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            title={locale.startsWith("zh") ? "取消选择" : "Clear selection"}
            onClick={() => setSelectedAgents(new Set())}
          >
            <XIcon className="size-4" />
          </Button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-5 py-4 sm:px-6">
        {isLoading ? (
          <div className="text-muted-foreground flex h-40 items-center justify-center text-sm">
            {t.common.loading}
          </div>
        ) : error ? (
          <div className="text-destructive flex h-40 items-center justify-center text-sm">
            {text.loadError}
          </div>
        ) : filteredAgents.length === 0 ? (
          <div className="bg-card mx-auto flex h-64 max-w-2xl flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-[#cadbe8] px-8 text-center dark:border-slate-700">
            <div className="flex size-14 items-center justify-center rounded-full border border-sky-200 bg-[#eef7ff] dark:border-sky-800 dark:bg-sky-950/60">
              <BotIcon className="size-7 text-[#2587ea]" />
            </div>
            <div>
              <p className="text-lg font-semibold">{t.agents.emptyTitle}</p>
              <p className="text-muted-foreground mt-2 text-sm leading-6">
                {t.agents.emptyDescription}
              </p>
            </div>
            <Button
              variant="outline"
              className="mt-1 rounded-lg"
              onClick={() => router.push("/workspace/agents/new")}
            >
              <PlusIcon className="mr-1.5 size-4" />
              {text.create}
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {filteredAgents.map((agent) => (
              <LocalAgentCard
                key={`${agent.scope}:${agent.name}`}
                agent={agent}
                selected={selectedAgents.has(`${agent.scope}:${agent.name}`)}
                onToggleSelect={
                  agent.can_batch
                    ? () => toggleSelected(agent.scope, agent.name)
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </div>

      {importOpen && (
        <ImportLocalAgentDialog
          open={importOpen}
          onOpenChange={setImportOpen}
        />
      )}
    </div>
  );
}

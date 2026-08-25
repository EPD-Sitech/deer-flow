"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  ActivityIcon,
  BotIcon,
  CheckCircle2Icon,
  CheckIcon,
  ChevronDownIcon,
  HistoryIcon,
  Loader2Icon,
  PlayIcon,
  PlugIcon,
  RotateCcwIcon,
  UserIcon,
  WrenchIcon,
  XCircleIcon,
  ZapIcon,
  UploadIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  Agent,
  ReasoningEffort,
  SubAgentInfo,
  UpdateAgentRequest,
} from "@/core/agents";
import { fetch as authenticatedFetch } from "@/core/api/fetcher";
import { useAuth } from "@/core/auth/AuthProvider";
import { getBackendBaseURL } from "@/core/config";
import { useI18n } from "@/core/i18n/hooks";
import { useMCPConfig } from "@/core/mcp/hooks";
import { useModels } from "@/core/models/hooks";
import { useSkills } from "@/core/skills/hooks";
import { parseSubAgentsFromSoul } from "@/lib/sub-agent-parser";
import { cn } from "@/lib/utils";

import {
  getAgentAvatarUrl,
  getDefaultAgentAvatar,
} from "../agent-harness/agent-avatar";
import {
  createAgentVersion,
  getAgentLogs,
  getAgentStats,
  listAgentVersions,
  restoreAgentVersion,
  testAgent,
  updateAgentSettings,
  validateAgent,
  type AgentLog,
  type AgentScope,
  type AgentStats,
  type AgentTestResult,
  type AgentVersion,
  type ValidationResult,
} from "../agent-harness/agent-management-api";
import {
  ALL_LOCAL_AGENT_CATEGORY,
  getLocalAgentCategoryIds,
  LOCAL_AGENT_CATEGORIES,
  type LocalAgentCategoryId,
} from "../agent-harness/local-agent-categories";

import {
  DEFAULT_MODEL_VALUE,
  INHERIT_VALUE,
  MAX_AGENT_OUTPUT_TOKENS,
  parseAgentModelSettingsDraft,
  resolveEffectiveModel,
  selectionToThinkingEnabled,
  thinkingEnabledToSelection,
} from "./agent-settings-dialog-helpers";

const REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high"];

const EMPTY_STATS: AgentStats = {
  total_calls: 0,
  success_count: 0,
  error_count: 0,
  avg_latency_ms: 0,
  total_tokens: 0,
};

interface AgentSettingsDialogProps {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope?: AgentScope;
}

function SettingsSection({
  icon,
  title,
  description,
  open,
  onToggle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border-border overflow-hidden rounded-lg border">
      <button
        type="button"
        onClick={onToggle}
        className="hover:bg-muted/50 flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2.5 text-left"
      >
        <span className="text-muted-foreground shrink-0">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="text-foreground block text-sm font-medium">
            {title}
          </span>
          {description && (
            <span className="text-muted-foreground block truncate text-xs">
              {description}
            </span>
          )}
        </span>
        <ChevronDownIcon
          className={cn(
            "text-muted-foreground size-4 shrink-0 transition-transform",
            !open && "-rotate-90",
          )}
        />
      </button>
      {open && (
        <div className="border-border bg-muted/20 border-t px-3.5 py-3">
          {children}
        </div>
      )}
    </div>
  );
}

function StatMetric({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="border-border bg-background rounded-md border p-2 text-center">
      <p className="text-foreground text-sm font-semibold">{value}</p>
      <p className="text-muted-foreground mt-0.5 text-[10px]">{label}</p>
    </div>
  );
}

/**
 * Agent settings dialog (harness-style): collapsible sections for identity,
 * model behaviour and enabled skills. Persists through `PUT /api/agents/{name}`;
 * changes take effect on the agent's next run.
 */
export function AgentSettingsDialog({
  agent,
  open,
  onOpenChange,
  scope = "user",
}: AgentSettingsDialogProps) {
  const { t } = useI18n();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { models } = useModels();
  const { skills: skillsData, isLoading: skillsLoading } = useSkills();
  const { config: mcpConfig, isLoading: mcpLoading } = useMCPConfig();
  const [settingsSaving, setSettingsSaving] = useState(false);

  const [description, setDescription] = useState(agent.description ?? "");
  const [avatarVersion, setAvatarVersion] = useState(0);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [targetScope, setTargetScope] = useState<AgentScope>(scope);
  const [category, setCategory] = useState<LocalAgentCategoryId>(
    () =>
      (agent.category as LocalAgentCategoryId | undefined) ??
      getLocalAgentCategoryIds(agent)[0] ??
      "other",
  );
  const [model, setModel] = useState(agent.model ?? DEFAULT_MODEL_VALUE);
  const [temperature, setTemperature] = useState(
    agent.model_settings?.temperature != null
      ? String(agent.model_settings.temperature)
      : "",
  );
  const [maxTokens, setMaxTokens] = useState(
    agent.model_settings?.max_tokens != null
      ? String(agent.model_settings.max_tokens)
      : "",
  );
  const [thinking, setThinking] = useState(
    thinkingEnabledToSelection(agent.thinking_enabled),
  );
  const [reasoningEffort, setReasoningEffort] = useState(
    agent.reasoning_effort ?? INHERIT_VALUE,
  );
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(
    () => new Set(agent.skills ?? []),
  );
  const [selectedMcpServers, setSelectedMcpServers] = useState<Set<string>>(
    () => new Set(agent.mcp_servers ?? []),
  );
  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionMessage, setVersionMessage] = useState("");
  const [versionAction, setVersionAction] = useState(false);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [testPrompt, setTestPrompt] = useState("请介绍你自己");
  const [testResult, setTestResult] = useState<AgentTestResult | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [stats, setStats] = useState<AgentStats>(EMPTY_STATS);
  const [logs, setLogs] = useState<AgentLog[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [sectionOpen, setSectionOpen] = useState({
    identity: true,
    category: true,
    model: true,
    skills: true,
    mcp: false,
    subAgents: true,
    versions: false,
    debug: false,
    activity: false,
  });

  const selectedModel = useMemo(
    () => resolveEffectiveModel(models, model),
    [models, model],
  );
  const supportsThinking = selectedModel?.supports_thinking ?? false;
  const supportsReasoningEffort =
    selectedModel?.supports_reasoning_effort ?? false;

  // Enabled skills sorted with selected ones first
  const allEnabledSkills = useMemo(
    () =>
      [...(skillsData ?? [])]
        .filter((skill) => skill.enabled)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [skillsData],
  );
  const sortedSkills = useMemo(() => {
    return [...allEnabledSkills].sort((a, b) => {
      const aSelected = selectedSkills.has(a.name) ? 0 : 1;
      const bSelected = selectedSkills.has(b.name) ? 0 : 1;
      if (aSelected !== bSelected) return aSelected - bSelected;
      return a.name.localeCompare(b.name);
    });
  }, [allEnabledSkills, selectedSkills]);
  const sortedMcpServers = useMemo(() => {
    return Object.entries(mcpConfig?.mcp_servers ?? {})
      .filter(([, server]) => server.enabled)
      .sort(([leftName], [rightName]) => {
        const leftSelected = selectedMcpServers.has(leftName) ? 0 : 1;
        const rightSelected = selectedMcpServers.has(rightName) ? 0 : 1;
        if (leftSelected !== rightSelected) return leftSelected - rightSelected;
        return leftName.localeCompare(rightName);
      });
  }, [mcpConfig, selectedMcpServers]);
  const parsedSubAgents: SubAgentInfo[] = useMemo(
    () => parseSubAgentsFromSoul(agent.soul ?? ""),
    [agent.soul],
  );

  function toggleSkill(skillName: string) {
    setSelectedSkills((prev) => {
      const next = new Set(prev);
      if (next.has(skillName)) {
        next.delete(skillName);
      } else {
        next.add(skillName);
      }
      return next;
    });
  }

  function toggleMcpServer(serverName: string) {
    setSelectedMcpServers((prev) => {
      const next = new Set(prev);
      if (next.has(serverName)) {
        next.delete(serverName);
      } else {
        next.add(serverName);
      }
      return next;
    });
  }

  async function loadVersions() {
    setVersionsLoading(true);
    try {
      setVersions(await listAgentVersions(agent.name, scope));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setVersionsLoading(false);
    }
  }

  async function handleCreateVersion() {
    setVersionAction(true);
    try {
      await createAgentVersion(agent.name, versionMessage.trim(), scope);
      setVersionMessage("");
      await loadVersions();
      toast.success("版本快照已创建");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setVersionAction(false);
    }
  }

  async function handleRestoreVersion(versionId: string) {
    if (!window.confirm("恢复到这个版本？当前状态会自动创建快照。")) return;
    setVersionAction(true);
    try {
      await restoreAgentVersion(agent.name, versionId, scope);
      await loadVersions();
      toast.success("版本已恢复");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setVersionAction(false);
    }
  }

  async function handleValidate() {
    setDebugLoading(true);
    try {
      setValidation(await validateAgent(agent.name, scope));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setDebugLoading(false);
    }
  }

  async function handleTest() {
    setDebugLoading(true);
    try {
      setTestResult(await testAgent(agent.name, testPrompt, scope));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setDebugLoading(false);
    }
  }

  async function loadActivity() {
    setActivityLoading(true);
    try {
      const [nextStats, nextLogs] = await Promise.all([
        getAgentStats(agent.name, scope),
        getAgentLogs(agent.name, scope),
      ]);
      setStats(nextStats);
      setLogs(nextLogs);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setActivityLoading(false);
    }
  }

  async function handleSave() {
    const parsedSettings = parseAgentModelSettingsDraft({
      temperature,
      maxTokens,
    });
    if (!parsedSettings.ok) {
      toast.error(
        parsedSettings.error === "temperature"
          ? t.agents.settingsInvalidTemperature
          : t.agents.settingsInvalidMaxTokens,
      );
      return;
    }

    const request: UpdateAgentRequest = {
      description: description.trim() || null,
      model: model === DEFAULT_MODEL_VALUE ? null : model,
      model_settings: parsedSettings.modelSettings,
      thinking_enabled: supportsThinking
        ? selectionToThinkingEnabled(thinking)
        : null,
      reasoning_effort:
        supportsReasoningEffort && reasoningEffort !== INHERIT_VALUE
          ? (reasoningEffort as ReasoningEffort)
          : null,
      skills: [...selectedSkills].sort(),
      mcp_servers: [...selectedMcpServers].sort(),
      category:
        category === ALL_LOCAL_AGENT_CATEGORY ? "other" : category,
      scope: targetScope,
    };

    setSettingsSaving(true);
    try {
      await updateAgentSettings(agent.name, request, scope);
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      toast.success(t.agents.settingsSaved);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSettingsSaving(false);
    }
  }

  async function handleAvatarUpload(file: File) {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 5 * 1024 * 1024) {
      toast.error("请选择 PNG、JPEG 或 WebP 图片，且大小不超过 5MB");
      return;
    }
    setAvatarUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await authenticatedFetch(
        `${getBackendBaseURL()}/api/agents/${encodeURIComponent(agent.name)}/avatar?scope=${scope}`,
        { method: "POST", body },
      );
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail ?? "头像上传失败");
      setAvatarVersion((value) => value + 1);
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      toast.success("头像已更新");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setAvatarUploading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(760px,calc(100dvh-48px))] max-h-[calc(100dvh-48px)] flex-col gap-0 overflow-visible p-0 sm:max-w-[560px]">
        <DialogHeader className="border-border shrink-0 border-b px-5 pt-4 pb-3">
          <DialogTitle>{t.agents.settingsTitle}</DialogTitle>
          <DialogDescription>{t.agents.settingsDescription}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-5 py-4">
          {/* Identity */}
          <SettingsSection
            icon={<UserIcon className="size-4" />}
            title="基本信息"
            description={agent.name}
            open={sectionOpen.identity}
            onToggle={() =>
              setSectionOpen((s) => ({ ...s, identity: !s.identity }))
            }
          >
            <div className="space-y-2.5">
              <div className="space-y-1">
                <span className="text-foreground block text-xs font-medium">
                  名称
                </span>
                <Input value={agent.name} disabled />
                <p className="text-muted-foreground text-[11px]">
                  智能体名称作为唯一标识，暂不支持重命名
                </p>
              </div>
              <div className="space-y-1">
                <span className="text-foreground block text-xs font-medium">头像</span>
                <div className="flex items-center gap-3 rounded-md border p-2.5">
                  <img
                    src={`${getAgentAvatarUrl(agent.name, scope)}&v=${avatarVersion}`}
                    onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = getDefaultAgentAvatar(agent.name); }}
                    alt=""
                    className="size-14 rounded-full object-cover"
                  />
                  <label className="cursor-pointer">
                    <Button type="button" variant="outline" size="sm" disabled={avatarUploading} asChild>
                      <span><UploadIcon className="mr-1.5 size-3.5" />{avatarUploading ? "上传中…" : "上传头像"}</span>
                    </Button>
                    <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(event) => { const file = event.target.files?.[0]; if (file) void handleAvatarUpload(file); event.target.value = ""; }} />
                  </label>
                  <span className="text-muted-foreground text-[11px]">未上传时使用系统默认头像</span>
                </div>
              </div>
              <div className="space-y-1">
                <span className="text-foreground block text-xs font-medium">
                  描述
                </span>
                <Input
                  value={description}
                  placeholder="智能体描述…"
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <span className="text-foreground block text-xs font-medium">
                  可见范围
                </span>
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ["user", "个人", "仅自己可见和使用"],
                      ["platform", "公共", "所有用户可见和使用"],
                    ] as const
                  ).map(([value, label, hint]) => {
                    const selected = targetScope === value;
                    const disabled = user?.system_role !== "admin";
                    return (
                      <button
                        key={value}
                        type="button"
                        disabled={disabled}
                        onClick={() => setTargetScope(value)}
                        aria-pressed={selected}
                        className={cn(
                          "rounded-md border p-2.5 text-left transition-all",
                          selected
                            ? "border-primary/40 bg-primary/10 text-primary shadow-sm ring-1 ring-primary/20"
                            : "border-border bg-background text-muted-foreground",
                          disabled
                            ? "cursor-not-allowed opacity-60"
                            : "cursor-pointer hover:border-primary/30 hover:bg-muted/50",
                        )}
                      >
                        <span className="flex items-center justify-between gap-2 text-xs font-semibold">
                          {label}
                          {selected && <CheckIcon className="size-3.5 shrink-0" />}
                        </span>
                        <span className="text-muted-foreground mt-0.5 block text-[10px]">
                          {hint}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {user?.system_role !== "admin" && (
                  <p className="text-muted-foreground text-[11px]">
                    仅管理员可以切换专家的公共/个人范围
                  </p>
                )}
              </div>
            </div>
          </SettingsSection>

          <SettingsSection
            icon={<WrenchIcon className="size-4" />}
            title="专家分类"
            description={
              LOCAL_AGENT_CATEGORIES.find((item) => item.id === category)?.zhLabel ??
              "其他"
            }
            open={sectionOpen.category}
            onToggle={() =>
              setSectionOpen((state) => ({
                ...state,
                category: !state.category,
              }))
            }
          >
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {LOCAL_AGENT_CATEGORIES.filter(
                (item) => item.id !== ALL_LOCAL_AGENT_CATEGORY,
              ).map((item) => {
                const selected = category === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setCategory(item.id)}
                    className={cn(
                      "flex cursor-pointer items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-xs font-medium transition-all",
                      selected
                        ? "border-primary/40 bg-primary/10 text-primary shadow-sm ring-1 ring-primary/20"
                        : "border-border bg-background text-muted-foreground hover:border-primary/30 hover:bg-muted/50 hover:text-foreground",
                    )}
                  >
                    <span>{item.zhLabel}</span>
                    {selected && <CheckIcon className="size-3.5 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </SettingsSection>

          {/* Model */}
          <SettingsSection
            icon={<ZapIcon className="size-4" />}
            title="模型与生成参数"
            description={t.agents.settingsModel}
            open={sectionOpen.model}
            onToggle={() => setSectionOpen((s) => ({ ...s, model: !s.model }))}
          >
            <div className="space-y-3">
              <div className="space-y-1.5">
                <span className="text-foreground block text-xs font-medium">
                  {t.agents.settingsModel}
                </span>
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_MODEL_VALUE}>
                      {t.agents.settingsModelDefault}
                    </SelectItem>
                    {models.map((m) => (
                      <SelectItem key={m.name} value={m.name}>
                        {m.display_name || m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <span className="text-foreground block text-xs font-medium">
                  {t.agents.settingsTemperature}
                </span>
                <Input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={temperature}
                  placeholder={t.agents.settingsInherit}
                  onChange={(e) => setTemperature(e.target.value)}
                />
                <p className="text-muted-foreground text-xs">
                  {t.agents.settingsTemperatureHint}
                </p>
              </div>

              <div className="space-y-1.5">
                <span className="text-foreground block text-xs font-medium">
                  {t.agents.settingsMaxTokens}
                </span>
                <Input
                  type="number"
                  min={1}
                  max={MAX_AGENT_OUTPUT_TOKENS}
                  step={1}
                  value={maxTokens}
                  placeholder={t.agents.settingsMaxTokensPlaceholder}
                  onChange={(e) => setMaxTokens(e.target.value)}
                />
              </div>

              {supportsThinking && (
                <div className="space-y-1.5">
                  <span className="text-foreground block text-xs font-medium">
                    {t.agents.settingsThinking}
                  </span>
                  <Select
                    value={thinking}
                    onValueChange={(value) =>
                      setThinking(value as typeof thinking)
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={INHERIT_VALUE}>
                        {t.agents.settingsInherit}
                      </SelectItem>
                      <SelectItem value="on">
                        {t.agents.settingsThinkingOn}
                      </SelectItem>
                      <SelectItem value="off">
                        {t.agents.settingsThinkingOff}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {supportsReasoningEffort && (
                <div className="space-y-1.5">
                  <span className="text-foreground block text-xs font-medium">
                    {t.agents.settingsReasoningEffort}
                  </span>
                  <Select
                    value={reasoningEffort}
                    onValueChange={setReasoningEffort}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={INHERIT_VALUE}>
                        {t.agents.settingsInherit}
                      </SelectItem>
                      {REASONING_EFFORTS.map((effort) => (
                        <SelectItem key={effort} value={effort}>
                          {effort}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </SettingsSection>

          {/* Skills */}
          <SettingsSection
            icon={<WrenchIcon className="size-4" />}
            title="技能"
            description={`${selectedSkills.size} 个已启用`}
            open={sectionOpen.skills}
            onToggle={() =>
              setSectionOpen((s) => ({ ...s, skills: !s.skills }))
            }
          >
            {skillsLoading ? (
              <p className="text-muted-foreground text-xs">加载中...</p>
            ) : sortedSkills.length === 0 ? (
              <p className="text-muted-foreground text-xs">暂无可用技能</p>
            ) : (
              <div className="max-h-48 space-y-1 overflow-y-auto">
                {sortedSkills.map((skill) => {
                  const checked = selectedSkills.has(skill.name);
                  return (
                    <label
                      key={skill.name}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors",
                        checked
                          ? "bg-primary/10 text-primary hover:bg-primary/15"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <span
                        className={cn(
                          "grid size-4 shrink-0 place-items-center rounded border",
                          checked
                            ? "bg-primary border-primary text-primary-foreground"
                            : "border-border bg-background",
                        )}
                      >
                        {checked && <CheckIcon className="size-3" />}
                      </span>
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={checked}
                        onChange={() => toggleSkill(skill.name)}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {skill.display_name ?? skill.name}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </SettingsSection>

          {/* Personal MCP servers */}
          <SettingsSection
            icon={<PlugIcon className="size-4" />}
            title="个性化 MCP"
            description={`${selectedMcpServers.size} 个已绑定`}
            open={sectionOpen.mcp}
            onToggle={() => setSectionOpen((s) => ({ ...s, mcp: !s.mcp }))}
          >
            {mcpLoading ? (
              <p className="text-muted-foreground text-xs">加载中...</p>
            ) : sortedMcpServers.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                暂无已启用的 MCP 服务，请先在系统 MCP 配置中启用服务。
              </p>
            ) : (
              <div className="max-h-48 space-y-1 overflow-y-auto">
                {sortedMcpServers.map(([serverName, server]) => {
                  const checked = selectedMcpServers.has(serverName);
                  return (
                    <label
                      key={serverName}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors",
                        checked
                          ? "bg-primary/10 text-primary hover:bg-primary/15"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <span
                        className={cn(
                          "grid size-4 shrink-0 place-items-center rounded border",
                          checked
                            ? "bg-primary border-primary text-primary-foreground"
                            : "border-border bg-background",
                        )}
                      >
                        {checked && <CheckIcon className="size-3" />}
                      </span>
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={checked}
                        onChange={() => toggleMcpServer(serverName)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{serverName}</span>
                        {server.description && (
                          <span className="text-muted-foreground block truncate text-[11px]">
                            {server.description}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </SettingsSection>

          {/* Sub-agents parsed from SOUL.md */}
          <SettingsSection
            icon={<BotIcon className="size-4" />}
            title="子智能体"
            description={`${parsedSubAgents.length} 个已配置`}
            open={sectionOpen.subAgents}
            onToggle={() =>
              setSectionOpen((s) => ({ ...s, subAgents: !s.subAgents }))
            }
          >
            {parsedSubAgents.length === 0 ? (
              <div className="border-border text-muted-foreground rounded-md border border-dashed px-3 py-4 text-center text-xs">
                当前专家没有配置子智能体
              </div>
            ) : (
              <div className="space-y-2">
                {parsedSubAgents.map((subAgent) => (
                  <div
                    key={subAgent.name}
                    className="border-border bg-background rounded-md border p-3"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <BotIcon className="text-primary size-4 shrink-0" />
                      <span className="text-foreground min-w-0 truncate text-sm font-medium">
                        {subAgent.displayName}
                      </span>
                      <span className="text-muted-foreground ml-auto shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px]">
                        {subAgent.name}
                      </span>
                    </div>
                    {subAgent.tools.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {subAgent.tools.map((tool) => (
                          <span
                            key={tool}
                            className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px]"
                          >
                            {tool}
                          </span>
                        ))}
                      </div>
                    )}
                    {subAgent.prompt && (
                      <p className="text-muted-foreground mt-2 line-clamp-2 text-[11px] leading-4">
                        {subAgent.prompt}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </SettingsSection>

          <SettingsSection
            icon={<HistoryIcon className="size-4" />}
            title="版本历史"
            description={`${versions.length} 个版本快照`}
            open={sectionOpen.versions}
            onToggle={() => {
              const next = !sectionOpen.versions;
              setSectionOpen((s) => ({ ...s, versions: next }));
              if (next) void loadVersions();
            }}
          >
            <div className="space-y-2">
              <div className="flex gap-2">
                <Input
                  value={versionMessage}
                  placeholder="版本说明（可选）"
                  onChange={(event) => setVersionMessage(event.target.value)}
                />
                <Button
                  size="sm"
                  disabled={versionAction}
                  onClick={() => void handleCreateVersion()}
                >
                  <HistoryIcon className="mr-1 size-3.5" /> 创建
                </Button>
              </div>
              {versionsLoading ? (
                <p className="text-muted-foreground text-xs">加载中...</p>
              ) : versions.length === 0 ? (
                <p className="text-muted-foreground text-xs">暂无版本快照</p>
              ) : (
                <div className="divide-y border-y">
                  {versions.map((version) => (
                    <div
                      key={version.version_id}
                      className="flex items-center gap-2 py-2"
                    >
                      <HistoryIcon className="text-muted-foreground size-3.5 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium">
                          {version.message || version.version_id}
                        </p>
                        <p className="text-muted-foreground mt-0.5 text-[10px]">
                          {new Date(version.created_at).toLocaleString()}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={versionAction}
                        onClick={() =>
                          void handleRestoreVersion(version.version_id)
                        }
                      >
                        <RotateCcwIcon className="mr-1 size-3.5" /> 恢复
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </SettingsSection>

          <SettingsSection
            icon={<PlayIcon className="size-4" />}
            title="调试"
            description="校验配置并测试专家响应"
            open={sectionOpen.debug}
            onToggle={() => setSectionOpen((s) => ({ ...s, debug: !s.debug }))}
          >
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={debugLoading}
                  onClick={() => void handleValidate()}
                >
                  <CheckCircle2Icon className="mr-1 size-3.5" /> 校验配置
                </Button>
                {validation && (
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] font-medium",
                      validation.valid
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-red-100 text-red-700",
                    )}
                  >
                    {validation.valid ? "校验通过" : "校验失败"}
                  </span>
                )}
              </div>
              {validation && (
                <div className="divide-y border-y">
                  {validation.checks.map((check) => (
                    <div
                      key={check.check}
                      className="flex gap-2 py-1.5 text-xs"
                    >
                      {check.status === "error" ? (
                        <XCircleIcon className="text-destructive mt-0.5 size-3.5 shrink-0" />
                      ) : (
                        <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
                      )}
                      <span>{check.message}</span>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                className="border-input bg-background text-foreground placeholder:text-muted-foreground min-h-18 w-full rounded-md border px-3 py-2 text-xs"
                value={testPrompt}
                placeholder="输入测试提示词"
                onChange={(event) => setTestPrompt(event.target.value)}
              />
              <Button
                size="sm"
                disabled={debugLoading || !testPrompt.trim()}
                onClick={() => void handleTest()}
              >
                {debugLoading ? (
                  <Loader2Icon className="mr-1 size-3.5 animate-spin" />
                ) : (
                  <PlayIcon className="mr-1 size-3.5" />
                )}
                运行测试
              </Button>
              {testResult && (
                <div className="bg-background rounded-md border p-3">
                  <p className="text-foreground text-xs leading-5 whitespace-pre-wrap">
                    {testResult.response}
                  </p>
                  <p className="text-muted-foreground mt-2 text-[10px]">
                    {testResult.metadata.model_used} ·{" "}
                    {testResult.metadata.tokens_used} tokens ·{" "}
                    {testResult.metadata.latency_ms} ms
                  </p>
                </div>
              )}
            </div>
          </SettingsSection>

          <SettingsSection
            icon={<ActivityIcon className="size-4" />}
            title="使用统计"
            description="调用统计与最近运行记录"
            open={sectionOpen.activity}
            onToggle={() => {
              const next = !sectionOpen.activity;
              setSectionOpen((s) => ({ ...s, activity: next }));
              if (next) void loadActivity();
            }}
          >
            {activityLoading ? (
              <p className="text-muted-foreground text-xs">加载中...</p>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  <StatMetric label="调用" value={stats.total_calls} />
                  <StatMetric label="成功" value={stats.success_count} />
                  <StatMetric label="失败" value={stats.error_count} />
                  <StatMetric
                    label="平均耗时"
                    value={`${stats.avg_latency_ms}ms`}
                  />
                  <StatMetric label="Tokens" value={stats.total_tokens} />
                </div>
                {logs.length === 0 ? (
                  <p className="text-muted-foreground text-xs">暂无运行记录</p>
                ) : (
                  <div className="divide-y border-y">
                    {logs.map((log, index) => (
                      <div
                        key={`${log.thread_id}-${index}`}
                        className="py-2 text-xs"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium">
                            {log.user_query || "（无输入）"}
                          </span>
                          <span
                            className={
                              log.status === "success"
                                ? "text-emerald-600"
                                : "text-destructive"
                            }
                          >
                            {log.status}
                          </span>
                        </div>
                        <p className="text-muted-foreground mt-1 truncate text-[10px]">
                          {log.timestamp ?? ""} · {log.tokens_used} tokens ·{" "}
                          {log.latency_ms} ms
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </SettingsSection>
        </div>

        <DialogFooter className="border-border bg-background shrink-0 border-t px-5 py-3.5">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={settingsSaving}
          >
            {t.common.cancel}
          </Button>
          <Button onClick={handleSave} disabled={settingsSaving}>
            {settingsSaving ? t.common.loading : t.common.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

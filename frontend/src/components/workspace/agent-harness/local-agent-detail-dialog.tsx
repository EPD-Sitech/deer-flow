"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  ActivityIcon,
  BrainIcon,
  BugIcon,
  CalendarClockIcon,
  CheckCircle2Icon,
  FileCode2Icon,
  HistoryIcon,
  Loader2Icon,
  MessageCircleQuestionIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  PackageIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
  SaveIcon,
  Trash2Icon,
  UploadIcon,
  XCircleIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { Agent } from "@/core/agents";
import { useI18n } from "@/core/i18n/hooks";

import {
  createAgentVersion,
  getAgentFiles,
  getAgentLogs,
  getAgentMemory,
  getAgentStats,
  importSubAgentPackage,
  listAgentVersions,
  restoreAgentVersion,
  testAgent,
  updateAgentFiles,
  updateAgentMemory,
  validateAgent,
  type AgentFiles,
  type AgentLog,
  type AgentStats,
  type AgentTestResult,
  type AgentVersion,
  type AgentScope,
  type ValidationResult,
} from "./agent-management-api";
import {
  MAX_AGENT_GUIDE_QUESTIONS,
  validateAgentGuideQuestions,
  type AgentGuideQuestion,
} from "./guide-questions";
import { LocalAgentSchedulePanel } from "./local-agent-schedule-panel";

interface LocalAgentDetailDialogProps {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: DetailTab;
  scope?: AgentScope;
  readOnly?: boolean;
  canEditGuideQuestions?: boolean;
}

type DetailTab =
  | "files"
  | "guideQuestions"
  | "memory"
  | "versions"
  | "debug"
  | "activity"
  | "subagents"
  | "schedules";

const EMPTY_STATS: AgentStats = {
  total_calls: 0,
  success_count: 0,
  error_count: 0,
  avg_latency_ms: 0,
  total_tokens: 0,
};

export function LocalAgentDetailDialog({
  agent,
  open,
  onOpenChange,
  initialTab = "files",
  scope = "user",
  readOnly = false,
  canEditGuideQuestions = false,
}: LocalAgentDetailDialogProps) {
  const { locale } = useI18n();
  const queryClient = useQueryClient();
  const zh = locale.startsWith("zh");
  const [tab, setTab] = useState<DetailTab>(initialTab);
  const [files, setFiles] = useState<AgentFiles | null>(null);
  const [configYaml, setConfigYaml] = useState("");
  const [soul, setSoul] = useState("");
  const [filesLoading, setFilesLoading] = useState(false);
  const [savingFiles, setSavingFiles] = useState(false);
  const [filesDirty, setFilesDirty] = useState(false);
  const [guideQuestions, setGuideQuestionsState] = useState<
    Array<AgentGuideQuestion & { id: string }>
  >([]);
  const [guideConfigError, setGuideConfigError] = useState<string | null>(null);

  const [memoryJson, setMemoryJson] = useState("");
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryLoaded, setMemoryLoaded] = useState(false);
  const [savingMemory, setSavingMemory] = useState(false);

  const [versions, setVersions] = useState<AgentVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionMessage, setVersionMessage] = useState("");
  const [versionAction, setVersionAction] = useState(false);

  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [testPrompt, setTestPrompt] = useState(
    zh ? "请介绍你自己" : "Introduce yourself",
  );
  const [testResult, setTestResult] = useState<AgentTestResult | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);

  const [stats, setStats] = useState<AgentStats>(EMPTY_STATS);
  const [logs, setLogs] = useState<AgentLog[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);

  const subAgentInput = useRef<HTMLInputElement>(null);
  const [subAgentFile, setSubAgentFile] = useState<File | null>(null);
  const [subAgentLoading, setSubAgentLoading] = useState(false);

  const loadFiles = useCallback(async () => {
    setFilesLoading(true);
    try {
      const result = await getAgentFiles(agent.name, scope);
      setFiles(result);
      setConfigYaml(result.config_yaml);
      setGuideQuestionsState(
        (result.guide_questions ?? []).map((item) => ({
          ...item,
          id: crypto.randomUUID(),
        })),
      );
      setGuideConfigError(null);
      setSoul(result.soul);
      setFilesDirty(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setFilesLoading(false);
    }
  }, [agent.name, scope]);

  const loadVersions = useCallback(async () => {
    setVersionsLoading(true);
    try {
      setVersions(await listAgentVersions(agent.name, scope));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setVersionsLoading(false);
    }
  }, [agent.name, scope]);

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setMemoryLoaded(false);
    setValidation(null);
    setTestResult(null);
    void loadFiles();
  }, [initialTab, loadFiles, open]);

  useEffect(() => {
    if (!open || tab !== "memory" || memoryLoaded) return;
    setMemoryLoading(true);
    void getAgentMemory(agent.name, scope)
      .then((memory) => {
        setMemoryJson(JSON.stringify(memory ?? {}, null, 2));
        setMemoryLoaded(true);
      })
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setMemoryLoading(false));
  }, [agent.name, memoryLoaded, open, scope, tab]);

  useEffect(() => {
    if (!open || tab !== "versions") return;
    void loadVersions();
  }, [loadVersions, open, tab]);

  useEffect(() => {
    if (!open || tab !== "activity") return;
    setActivityLoading(true);
    void Promise.all([
      getAgentStats(agent.name, scope),
      getAgentLogs(agent.name, scope),
    ])
      .then(([nextStats, nextLogs]) => {
        setStats(nextStats);
        setLogs(nextLogs);
      })
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error)),
      )
      .finally(() => setActivityLoading(false));
  }, [agent.name, open, scope, tab]);

  async function handleSaveFiles() {
    setSavingFiles(true);
    try {
      const questionError = validateAgentGuideQuestions(guideQuestions);
      if (questionError) throw new Error(questionError);
      await createAgentVersion(
        agent.name,
        zh ? "详情编辑前自动快照" : "Snapshot before detail edit",
        scope,
      );
      const result = await updateAgentFiles(
        agent.name,
        {
          config_yaml: configYaml,
          soul,
          guide_questions: canEditGuideQuestions
            ? guideQuestions.map(({ id: _id, ...question }) => question)
            : undefined,
        },
        scope,
      );
      setFiles(result);
      setConfigYaml(result.config_yaml);
      setSoul(result.soul);
      setFilesDirty(false);
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      toast.success(zh ? "智能体文件已保存" : "Agent files saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingFiles(false);
    }
  }

  function syncGuideQuestions(
    next: Array<AgentGuideQuestion & { id: string }>,
  ) {
    setGuideQuestionsState(next);
    if (canEditGuideQuestions) setFilesDirty(true);
  }

  async function handleSaveMemory() {
    setSavingMemory(true);
    try {
      const parsed = JSON.parse(memoryJson) as Record<string, unknown>;
      await updateAgentMemory(agent.name, parsed, scope);
      toast.success(zh ? "记忆已保存" : "Memory saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingMemory(false);
    }
  }

  async function handleCreateVersion() {
    setVersionAction(true);
    try {
      await createAgentVersion(agent.name, versionMessage.trim(), scope);
      setVersionMessage("");
      await loadVersions();
      toast.success(zh ? "版本快照已创建" : "Version created");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setVersionAction(false);
    }
  }

  async function handleRestoreVersion(versionId: string) {
    if (
      !window.confirm(
        zh
          ? "恢复到这个版本？当前状态会自动创建快照。"
          : "Restore this version?",
      )
    )
      return;
    setVersionAction(true);
    try {
      await restoreAgentVersion(agent.name, versionId, scope);
      await Promise.all([loadFiles(), loadVersions()]);
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      toast.success(zh ? "版本已恢复" : "Version restored");
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

  async function handleSubAgentImport() {
    if (!subAgentFile) return;
    setSubAgentLoading(true);
    try {
      const result = await importSubAgentPackage(
        agent.name,
        subAgentFile,
        scope,
      );
      const imported =
        result.installed_skills.length + result.merged_sub_agents.length;
      toast.success(
        zh
          ? `导入完成，共新增 ${imported} 项`
          : `Import complete: ${imported} item(s) added`,
      );
      if (result.errors.length > 0) {
        toast.error(
          result.errors.map((item) => `${item.name}: ${item.error}`).join(", "),
        );
      }
      setSubAgentFile(null);
      await loadFiles();
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSubAgentLoading(false);
    }
  }

  const tabs = [
    {
      value: "files",
      label: zh ? "配置与角色" : "Config & soul",
      icon: FileCode2Icon,
    },
    {
      value: "guideQuestions",
      label: zh ? "引导问题" : "Guide questions",
      icon: MessageCircleQuestionIcon,
    },
    { value: "memory", label: zh ? "记忆" : "Memory", icon: BrainIcon },
    { value: "versions", label: zh ? "版本" : "Versions", icon: HistoryIcon },
    { value: "debug", label: zh ? "调试" : "Debug", icon: BugIcon },
    {
      value: "activity",
      label: zh ? "运行记录" : "Activity",
      icon: ActivityIcon,
    },
    {
      value: "subagents",
      label: zh ? "子智能体包" : "Sub-agent package",
      icon: PackageIcon,
    },
    {
      value: "schedules",
      label: zh ? "定时任务" : "Schedules",
      icon: CalendarClockIcon,
    },
  ] as const;
  const visibleTabs = readOnly ? tabs.slice(0, 2) : tabs;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[88vh] w-[96vw] max-w-[96vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl">
        <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12">
          <div className="flex min-w-0 items-center gap-3">
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate">
                {zh ? "智能体详情" : "Agent details"}: {agent.name}
              </DialogTitle>
              <DialogDescription className="mt-1 truncate">
                {agent.description ||
                  (zh
                    ? readOnly
                      ? "查看智能体配置与角色说明。"
                      : "管理本地智能体的完整配置和运行能力。"
                    : readOnly
                      ? "View the agent configuration and role definition."
                      : "Manage the local agent configuration and runtime features.")}
              </DialogDescription>
            </div>
            {!readOnly &&
              (tab === "files" || tab === "guideQuestions") &&
              filesDirty && (
              <Button
                onClick={() => void handleSaveFiles()}
                disabled={savingFiles}
              >
                {savingFiles ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <SaveIcon className="size-4" />
                )}
                {zh ? "保存" : "Save"}
              </Button>
            )}
          </div>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as DetailTab)}
          className="min-h-0 flex-1 gap-0"
        >
          <div className="shrink-0 overflow-x-auto border-b px-4 [scrollbar-width:none]">
            <TabsList variant="line" className="h-11 w-max">
              {visibleTabs.map(({ value, label, icon: Icon }) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className="px-3 text-xs sm:text-sm"
                >
                  <Icon className="size-4" />
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="p-5">
              <TabsContent value="files" className="m-0">
                {filesLoading || !files ? (
                  <LoadingState />
                ) : (
                  <div className="grid gap-5 lg:grid-cols-2">
                    <EditorField
                      id="agent-config-yaml"
                      label="config.yaml"
                      description={
                        zh
                          ? "完整智能体配置，name 必须与当前智能体一致。"
                          : "Full agent configuration. The name must match this agent."
                      }
                      value={configYaml}
                      readOnly={readOnly}
                      onChange={(value) => {
                        setConfigYaml(value);
                        setFilesDirty(true);
                      }}
                    />
                    <EditorField
                      id="agent-soul"
                      label="SOUL.md"
                      description={
                        zh
                          ? "智能体的角色、行为边界和工作方式。"
                          : "The agent's role, behavior, and working style."
                      }
                      value={soul}
                      readOnly={readOnly}
                      onChange={(value) => {
                        setSoul(value);
                        setFilesDirty(true);
                      }}
                    />
                  </div>
                )}
              </TabsContent>

              <TabsContent value="guideQuestions" className="m-0 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <SectionHeading
                    title={zh ? "新会话引导问题" : "New chat guide questions"}
                    description={
                      zh
                        ? canEditGuideQuestions
                          ? "配置新会话中展示的快捷问题，最多 6 条。"
                          : "仅管理员可以修改引导问题。"
                        : canEditGuideQuestions
                          ? "Configure up to six starter questions for new chats."
                          : "Only administrators can modify guide questions."
                    }
                  />
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-muted-foreground text-xs">
                      {guideQuestions.length}/{MAX_AGENT_GUIDE_QUESTIONS}
                    </span>
                    {canEditGuideQuestions && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          !!guideConfigError ||
                          guideQuestions.length >= MAX_AGENT_GUIDE_QUESTIONS
                        }
                        onClick={() =>
                          syncGuideQuestions([
                            ...guideQuestions,
                            {
                              id: crypto.randomUUID(),
                              question: "",
                              prompt: "",
                            },
                          ])
                        }
                      >
                        <PlusIcon className="size-4" />
                        {zh ? "新增" : "Add"}
                      </Button>
                    )}
                  </div>
                </div>

                {guideConfigError ? (
                  <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-sm">
                    {guideConfigError}
                  </div>
                ) : filesLoading ? (
                  <LoadingState />
                ) : guideQuestions.length === 0 ? (
                  <EmptyState
                    text={zh ? "暂无引导问题" : "No guide questions"}
                  />
                ) : (
                  <div className="space-y-3">
                    {guideQuestions.map((item, index) => (
                      <div key={item.id} className="rounded-lg border p-3">
                        <div className="flex items-start gap-3">
                          <span className="bg-muted flex size-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold">
                            {index + 1}
                          </span>
                          <div className="min-w-0 flex-1 space-y-3">
                            <div className="space-y-1.5">
                              <label className="text-xs font-medium">
                                {zh ? "问题文案" : "Question"}
                              </label>
                              <Input
                                value={item.question}
                                readOnly={!canEditGuideQuestions}
                                placeholder={
                                  zh
                                    ? "例如：帮我分析这份材料"
                                    : "For example: Analyze this material"
                                }
                                onChange={(event) =>
                                  syncGuideQuestions(
                                    guideQuestions.map((question) =>
                                      question.id === item.id
                                        ? {
                                            ...question,
                                            question: event.target.value,
                                          }
                                        : question,
                                    ),
                                  )
                                }
                              />
                            </div>
                            <div className="space-y-1.5">
                              <label className="text-xs font-medium">
                                {zh ? "发送内容" : "Prompt"}
                              </label>
                              <Textarea
                                value={item.prompt ?? ""}
                                readOnly={!canEditGuideQuestions}
                                className="min-h-20"
                                placeholder={
                                  zh
                                    ? "留空时发送问题文案"
                                    : "Leave empty to send the question"
                                }
                                onChange={(event) =>
                                  syncGuideQuestions(
                                    guideQuestions.map((question) =>
                                      question.id === item.id
                                        ? {
                                            ...question,
                                            prompt: event.target.value,
                                          }
                                        : question,
                                    ),
                                  )
                                }
                              />
                            </div>
                          </div>
                          {canEditGuideQuestions && (
                            <div className="flex shrink-0 flex-col gap-1">
                              <Button
                                size="icon"
                                variant="ghost"
                                title={zh ? "上移" : "Move up"}
                                disabled={index === 0}
                                onClick={() => {
                                  const next = [...guideQuestions];
                                  [next[index - 1], next[index]] = [
                                    next[index]!,
                                    next[index - 1]!,
                                  ];
                                  syncGuideQuestions(next);
                                }}
                              >
                                <ArrowUpIcon className="size-4" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                title={zh ? "下移" : "Move down"}
                                disabled={index === guideQuestions.length - 1}
                                onClick={() => {
                                  const next = [...guideQuestions];
                                  [next[index], next[index + 1]] = [
                                    next[index + 1]!,
                                    next[index]!,
                                  ];
                                  syncGuideQuestions(next);
                                }}
                              >
                                <ArrowDownIcon className="size-4" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="text-destructive"
                                title={zh ? "删除" : "Delete"}
                                onClick={() =>
                                  syncGuideQuestions(
                                    guideQuestions.filter(
                                      (question) => question.id !== item.id,
                                    ),
                                  )
                                }
                              >
                                <Trash2Icon className="size-4" />
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="memory" className="m-0 space-y-4">
                <SectionHeading
                  title={zh ? "智能体记忆" : "Agent memory"}
                  description={
                    zh
                      ? "以 JSON 形式查看和编辑该智能体的用户级记忆。"
                      : "View and edit user-scoped agent memory as JSON."
                  }
                />
                {memoryLoading ? (
                  <LoadingState />
                ) : (
                  <>
                    <Textarea
                      aria-label={zh ? "智能体记忆 JSON" : "Agent memory JSON"}
                      className="min-h-[420px] resize-y font-mono text-xs"
                      value={memoryJson}
                      onChange={(event) => setMemoryJson(event.target.value)}
                      spellCheck={false}
                    />
                    <div className="flex justify-end">
                      <Button
                        onClick={() => void handleSaveMemory()}
                        disabled={savingMemory || !memoryLoaded}
                      >
                        {savingMemory ? (
                          <Loader2Icon className="size-4 animate-spin" />
                        ) : (
                          <SaveIcon className="size-4" />
                        )}
                        {zh ? "保存记忆" : "Save memory"}
                      </Button>
                    </div>
                  </>
                )}
              </TabsContent>

              <TabsContent value="versions" className="m-0 space-y-5">
                <SectionHeading
                  title={zh ? "版本历史" : "Version history"}
                  description={
                    zh
                      ? "创建配置快照，或恢复到之前的配置与 SOUL。"
                      : "Snapshot or restore configuration and SOUL."
                  }
                />
                <div className="flex gap-2">
                  <Input
                    value={versionMessage}
                    onChange={(event) => setVersionMessage(event.target.value)}
                    placeholder={
                      zh ? "版本说明（可选）" : "Version message (optional)"
                    }
                  />
                  <Button
                    onClick={() => void handleCreateVersion()}
                    disabled={versionAction}
                  >
                    <HistoryIcon className="size-4" />
                    {zh ? "创建快照" : "Create"}
                  </Button>
                </div>
                {versionsLoading ? (
                  <LoadingState />
                ) : versions.length === 0 ? (
                  <EmptyState text={zh ? "暂无版本快照" : "No versions"} />
                ) : (
                  <div className="divide-y border-y">
                    {versions.map((version) => (
                      <div
                        key={version.version_id}
                        className="flex items-center gap-3 py-3"
                      >
                        <HistoryIcon className="text-muted-foreground size-4 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {version.message || version.version_id}
                          </p>
                          <p className="text-muted-foreground mt-1 text-xs">
                            {new Date(version.created_at).toLocaleString()}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={versionAction}
                          onClick={() =>
                            void handleRestoreVersion(version.version_id)
                          }
                        >
                          <RotateCcwIcon className="size-4" />
                          {zh ? "恢复" : "Restore"}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="debug" className="m-0 space-y-6">
                <SectionHeading
                  title={zh ? "校验与测试" : "Validate and test"}
                  description={
                    zh
                      ? "检查配置完整性，并直接调用模型验证角色效果。"
                      : "Validate configuration and run a direct model test."
                  }
                />
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="outline"
                    onClick={() => void handleValidate()}
                    disabled={debugLoading}
                  >
                    <CheckCircle2Icon className="size-4" />
                    {zh ? "校验配置" : "Validate"}
                  </Button>
                  {validation && (
                    <Badge
                      variant={validation.valid ? "secondary" : "destructive"}
                    >
                      {validation.valid
                        ? zh
                          ? "校验通过"
                          : "Valid"
                        : zh
                          ? "校验失败"
                          : "Invalid"}
                    </Badge>
                  )}
                </div>
                {validation && (
                  <div className="divide-y border-y">
                    {validation.checks.map((check) => (
                      <div
                        key={check.check}
                        className="flex items-start gap-2 py-2 text-sm"
                      >
                        {check.status === "error" ? (
                          <XCircleIcon className="text-destructive mt-0.5 size-4" />
                        ) : (
                          <CheckCircle2Icon className="mt-0.5 size-4 text-emerald-600" />
                        )}
                        <span>{check.message}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="space-y-3 border-t pt-5">
                  <Textarea
                    value={testPrompt}
                    onChange={(event) => setTestPrompt(event.target.value)}
                    rows={3}
                    aria-label={zh ? "测试提示词" : "Test prompt"}
                  />
                  <Button
                    onClick={() => void handleTest()}
                    disabled={debugLoading || !testPrompt.trim()}
                  >
                    {debugLoading ? (
                      <Loader2Icon className="size-4 animate-spin" />
                    ) : (
                      <PlayIcon className="size-4" />
                    )}
                    {zh ? "运行测试" : "Run test"}
                  </Button>
                  {testResult && (
                    <div className="bg-muted/30 rounded-lg border p-4">
                      <p className="text-sm leading-6 whitespace-pre-wrap">
                        {testResult.response}
                      </p>
                      <p className="text-muted-foreground mt-3 text-xs">
                        {testResult.metadata.model_used} ·{" "}
                        {testResult.metadata.tokens_used} tokens ·{" "}
                        {testResult.metadata.latency_ms} ms
                      </p>
                    </div>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="activity" className="m-0 space-y-5">
                <SectionHeading
                  title={zh ? "统计与运行日志" : "Statistics and logs"}
                  description={
                    zh
                      ? "查看该智能体关联会话的调用情况。"
                      : "Inspect usage across this agent's conversations."
                  }
                />
                {activityLoading ? (
                  <LoadingState />
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                      <Metric
                        label={zh ? "调用" : "Calls"}
                        value={stats.total_calls}
                      />
                      <Metric
                        label={zh ? "成功" : "Success"}
                        value={stats.success_count}
                      />
                      <Metric
                        label={zh ? "失败" : "Errors"}
                        value={stats.error_count}
                      />
                      <Metric
                        label={zh ? "平均耗时" : "Avg latency"}
                        value={`${stats.avg_latency_ms} ms`}
                      />
                      <Metric label="Tokens" value={stats.total_tokens} />
                    </div>
                    {logs.length === 0 ? (
                      <EmptyState text={zh ? "暂无运行日志" : "No run logs"} />
                    ) : (
                      <div className="divide-y border-y">
                        {logs.map((log, index) => (
                          <div
                            key={`${log.thread_id}-${index}`}
                            className="py-3"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <p className="truncate text-sm font-medium">
                                {log.user_query || log.thread_id}
                              </p>
                              <Badge variant="outline">{log.status}</Badge>
                            </div>
                            <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">
                              {log.error ?? log.response_summary}
                            </p>
                            <p className="text-muted-foreground mt-1 text-[11px]">
                              {log.timestamp
                                ? new Date(log.timestamp).toLocaleString()
                                : ""}{" "}
                              · {log.latency_ms} ms · {log.tokens_used} tokens
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </TabsContent>

              <TabsContent value="subagents" className="m-0 space-y-5">
                <SectionHeading
                  title={zh ? "导入子智能体包" : "Import sub-agent package"}
                  description={
                    zh
                      ? "从 ZIP 包安装技能，并把子智能体定义合并到当前智能体。"
                      : "Install skills and merge sub-agent definitions from a ZIP package."
                  }
                />
                <button
                  type="button"
                  className="hover:bg-muted/30 flex min-h-48 w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-6"
                  onClick={() => subAgentInput.current?.click()}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    setSubAgentFile(event.dataTransfer.files[0] ?? null);
                  }}
                >
                  <PackageIcon className="text-muted-foreground size-8" />
                  <span className="max-w-full truncate text-sm font-medium">
                    {subAgentFile?.name ??
                      (zh
                        ? "选择或拖入子智能体 ZIP 包"
                        : "Choose or drop a sub-agent ZIP")}
                  </span>
                  <input
                    ref={subAgentInput}
                    type="file"
                    accept=".zip,application/zip"
                    className="hidden"
                    onChange={(event) =>
                      setSubAgentFile(event.target.files?.[0] ?? null)
                    }
                  />
                </button>
                <div className="flex justify-end">
                  <Button
                    onClick={() => void handleSubAgentImport()}
                    disabled={!subAgentFile || subAgentLoading}
                  >
                    {subAgentLoading ? (
                      <Loader2Icon className="size-4 animate-spin" />
                    ) : (
                      <UploadIcon className="size-4" />
                    )}
                    {zh ? "导入包" : "Import package"}
                  </Button>
                </div>
              </TabsContent>

              <TabsContent value="schedules" className="m-0">
                <LocalAgentSchedulePanel
                  agentName={agent.name}
                  scope={scope}
                  zh={zh}
                />
              </TabsContent>
            </div>
          </ScrollArea>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function LoadingState() {
  return (
    <div className="text-muted-foreground flex h-40 items-center justify-center">
      <Loader2Icon className="size-5 animate-spin" />
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="text-muted-foreground flex h-28 items-center justify-center border-y text-sm">
      {text}
    </div>
  );
}

function SectionHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div>
      <h3 className="font-medium">{title}</h3>
      <p className="text-muted-foreground mt-1 text-xs">{description}</p>
    </div>
  );
}

function EditorField({
  id,
  label,
  description,
  value,
  onChange,
  readOnly = false,
}: {
  id: string;
  label: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <label htmlFor={id} className="text-sm font-semibold">
        {label}
      </label>
      <p className="text-muted-foreground min-h-8 text-xs leading-5">
        {description}
      </p>
      <Textarea
        id={id}
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value)}
        className={`min-h-[470px] font-mono text-xs leading-5 ${readOnly ? "resize-none bg-muted/20" : "resize-y"}`}
        spellCheck={false}
      />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-muted/25 rounded-lg border p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

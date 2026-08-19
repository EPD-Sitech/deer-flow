"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  BrainIcon,
  CalendarClockIcon,
  FileCode2Icon,
  Loader2Icon,
  MessageCircleQuestionIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  PackageIcon,
  PlusIcon,
  SaveIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

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
import type {
  Agent,
  AgentWelcomeSuggestion,
} from "@/core/agents";
import { useI18n } from "@/core/i18n/hooks";

import {
  createAgentVersion,
  getAgentFiles,
  getAgentMemory,
  importSubAgentPackage,
  updateAgentFiles,
  updateAgentMemory,
  type AgentFiles,
  type AgentScope,
} from "./agent-management-api";
import {
  MAX_AGENT_GUIDE_QUESTIONS,
  validateAgentGuideQuestions,
  type AgentGuideQuestion,
} from "./guide-questions";
import { LocalAgentSchedulePanel } from "./local-agent-schedule-panel";
import { WelcomeSuggestionsEditor } from "./welcome-suggestions-editor";

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
  | "subagents"
  | "schedules";

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
  const [welcomeSuggestions, setWelcomeSuggestions] = useState<
    AgentWelcomeSuggestion[] | null | undefined
  >(undefined);

  const [memoryJson, setMemoryJson] = useState("");
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryLoaded, setMemoryLoaded] = useState(false);
  const [savingMemory, setSavingMemory] = useState(false);

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
      setWelcomeSuggestions(result.welcome_suggestions);
      setSoul(result.soul);
      setFilesDirty(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setFilesLoading(false);
    }
  }, [agent.name, scope]);

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setMemoryLoaded(false);
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
          welcome_suggestions: canEditGuideQuestions
            ? welcomeSuggestions
            : undefined,
        },
        scope,
      );
      setFiles(result);
      setConfigYaml(result.config_yaml);
      setWelcomeSuggestions(result.welcome_suggestions);
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

                <div className="border-border bg-muted/20 rounded-lg border p-4">
                  <WelcomeSuggestionsEditor
                    key={`${agent.name}:${open}:${files?.name ?? "loading"}`}
                    value={welcomeSuggestions}
                    readOnly={readOnly || !canEditGuideQuestions}
                    onChange={(next) => {
                      setWelcomeSuggestions(next);
                      if (canEditGuideQuestions && !readOnly) setFilesDirty(true);
                    }}
                  />
                </div>
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


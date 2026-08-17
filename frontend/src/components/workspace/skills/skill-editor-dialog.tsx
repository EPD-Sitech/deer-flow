"use client";

import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { languages } from "@codemirror/language-data";
import { basicLightInit } from "@uiw/codemirror-theme-basic";
import { monokaiInit } from "@uiw/codemirror-theme-monokai";
import CodeMirror from "@uiw/react-codemirror";
import {
  ArrowLeftIcon,
  ClockIcon,
  FileTextIcon,
  FolderIcon,
  HistoryIcon,
  LoaderIcon,
  PlayIcon,
  PlusIcon,
  SaveIcon,
  SparklesIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useDebugRunSkill,
  useDeleteSkillFile,
  useRenameSkillFile,
  useRestoreSkillVersion,
  useSaveSkillFile,
  useSkillFileContent,
  useSkillFiles,
  useSkillVersions,
} from "@/core/skills/extended";
import type { SkillDebugRunResponse } from "@/core/skills/extended";
import type { Skill } from "@/core/skills/type";
import { cn } from "@/lib/utils";

import { EvolutionPanel } from "./evolution-panel";

const darkTheme = monokaiInit({
  settings: {
    background: "transparent",
    gutterBackground: "transparent",
    gutterForeground: "#555",
    gutterActiveForeground: "#fff",
    fontSize: "14px",
  },
});

const lightTheme = basicLightInit({
  settings: { background: "transparent", fontSize: "14px" },
});

interface SkillDetailDialogProps {
  skill: Skill;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type View = "editor" | "versions" | "evolution";

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function SkillEditorDialog({
  skill,
  open,
  onOpenChange,
}: SkillDetailDialogProps) {
  const router = useRouter();
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [editedContent, setEditedContent] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<View>("editor");
  const [debugPrompt, setDebugPrompt] = useState("");
  const [debugOutput, setDebugOutput] = useState<SkillDebugRunResponse | null>(
    null,
  );
  const [showDebugPanel, setShowDebugPanel] = useState(false);

  const skillName = skill.name;

  // ── Resizable sidebar ──────────────────────────────────────────────────────
  const [sidebarWidth, setSidebarWidth] = useState(192);
  const sidebarStartX = useRef(0);
  const sidebarStartWidth = useRef(192);

  const handleSidebarResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    sidebarStartX.current = e.clientX;
    sidebarStartWidth.current = sidebarWidth;
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - sidebarStartX.current;
      const next = Math.min(Math.max(sidebarStartWidth.current + delta, 120), 480);
      setSidebarWidth(next);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [sidebarWidth]);

  // Queries
  const { data: filesData, isLoading: filesLoading } = useSkillFiles(
    open ? skillName : null,
  );
  const { data: fileContent, isLoading: contentLoading } = useSkillFileContent(
    open ? skillName : null,
    selectedFile,
  );
  const { data: versionsData } = useSkillVersions(
    open && currentView === "versions" ? skillName : null,
  );

  // Mutations
  const saveMutation = useSaveSkillFile();
  const restoreMutation = useRestoreSkillVersion();
  const deleteFileMutation = useDeleteSkillFile();
  const renameFileMutation = useRenameSkillFile();
  const debugMutation = useDebugRunSkill();

  const canEdit = filesData?.can_edit ?? false;
  const files = useMemo(() => filesData?.files ?? [], [filesData]);
  const versions = versionsData?.versions ?? [];

  const hasUnsavedChanges =
    editedContent !== null && editedContent !== (fileContent?.content ?? "");

  // Auto-select first file
  useEffect(() => {
    if (files.length > 0 && !selectedFile) {
      const skillMd = files.find((f) => f.path === "SKILL.md");
      setSelectedFile(skillMd?.path ?? files[0]!.path);
    }
  }, [files, selectedFile]);

  // Reset on dialog close
  useEffect(() => {
    if (!open) {
      setSelectedFile(null);
      setEditedContent(null);
      setCurrentView("editor");
      setDebugPrompt("");
      setDebugOutput(null);
      setShowDebugPanel(false);
    }
  }, [open]);

  // Reset edited content when selected file changes
  useEffect(() => {
    setEditedContent(null);
  }, [selectedFile]);

  const handleSave = useCallback(async () => {
    if (!skillName || !selectedFile || editedContent === null) return;
    try {
      const result = await saveMutation.mutateAsync({
        skillName,
        filePath: selectedFile,
        content: editedContent,
      });
      setEditedContent(null);
      toast.success(`已保存 ${selectedFile}，版本: ${result.version_id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败");
    }
  }, [skillName, selectedFile, editedContent, saveMutation]);

  const handleDebugRun = useCallback(async () => {
    if (!skillName) return;
    setDebugOutput(null);
    try {
      const result = await debugMutation.mutateAsync({
        skillName,
        prompt: debugPrompt || "请运行此技能并展示结果",
        timeout: 120,
      });
      setDebugOutput(result);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "运行失败");
    }
  }, [skillName, debugPrompt, debugMutation]);

  const handleRestore = useCallback(
    async (versionId: string) => {
      if (!skillName) return;
      if (!window.confirm(`确认回滚到版本 ${versionId} ？当前状态会先备份。`)) {
        return;
      }
      try {
        const result = await restoreMutation.mutateAsync({
          skillName,
          versionId,
        });
        toast.success(`已回滚到版本 ${result.restored_version}`);
        setCurrentView("editor");
        setSelectedFile(null);
        setEditedContent(null);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "回滚失败");
      }
    },
    [skillName, restoreMutation],
  );

  const handleCreateFile = useCallback(async () => {
    if (!skillName) return;
    const raw = window.prompt("新文件相对路径（例如 docs/example.md）");
    if (!raw) return;
    const rel = raw.trim().replace(/^\/+/, "");
    if (!rel || rel.includes("..")) {
      toast.error("无效的文件路径");
      return;
    }
    setSelectedFile(rel);
    setEditedContent(null);
    try {
      await saveMutation.mutateAsync({ skillName, filePath: rel, content: "" });
      toast.success(`已创建 ${rel}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "创建失败");
      setSelectedFile(null);
    }
  }, [skillName, saveMutation]);

  const handleRenameFile = useCallback(
    async (filePath: string) => {
      if (!skillName) return;
      const next = window.prompt("新文件名（相对于技能根目录）", filePath);
      if (!next || next.trim() === filePath) return;
      const target = next.trim().replace(/^\/+/, "");
      try {
        const result = await renameFileMutation.mutateAsync({
          skillName,
          filePath,
          newPath: target,
        });
        toast.success(`已重命名为 ${result.path}`);
        if (selectedFile === filePath) {
          setSelectedFile(result.path);
          setEditedContent(null);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "重命名失败");
      }
    },
    [skillName, renameFileMutation, selectedFile],
  );

  const handleDeleteFile = useCallback(
    async (filePath: string) => {
      if (!skillName) return;
      if (!window.confirm(`确认删除文件 ${filePath} ？`)) return;
      try {
        await deleteFileMutation.mutateAsync({ skillName, filePath });
        toast.success(`已删除 ${filePath}`);
        if (selectedFile === filePath) {
          setSelectedFile(null);
          setEditedContent(null);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "删除失败");
      }
    },
    [skillName, deleteFileMutation, selectedFile],
  );

  const { resolvedTheme } = useTheme();
  const cmTheme = resolvedTheme === "dark" ? darkTheme : lightTheme;
  const cmExtensions = useMemo(
    () => [
      css(),
      html(),
      javascript({}),
      json(),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      python(),
    ],
    [],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[90vh] w-[95vw] max-w-[2400px] flex-col gap-0 overflow-hidden rounded-2xl border-[#d8e4ee] bg-white p-0 sm:max-w-none dark:border-slate-700 dark:bg-slate-950"
      >
        {/* Header */}
        <DialogHeader className="flex-shrink-0 border-b border-[#edf2f7] px-6 py-4 dark:border-slate-800">
          <div className="flex items-center justify-between gap-3">
            <DialogTitle className="flex min-w-0 items-center gap-2 text-lg font-semibold text-[#173a5b] dark:text-slate-100">
              <FolderIcon className="size-5 shrink-0 text-sky-500" />
              <span className="truncate">{skill.display_name ?? skill.name}</span>
              <Badge variant="outline" className="text-xs">
                {filesData?.scope ?? skill.scope}
              </Badge>
              {canEdit ? (
                <Badge className="bg-green-50 text-green-700 text-xs dark:bg-green-950/60 dark:text-green-300">
                  可编辑
                </Badge>
              ) : (
                filesData && (
                  <Badge className="bg-muted text-muted-foreground text-xs">
                    只读
                  </Badge>
                )
              )}
            </DialogTitle>
            <div className="flex shrink-0 items-center gap-2">
              {currentView === "versions" && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setCurrentView("editor")}
                >
                  <ArrowLeftIcon className="mr-1 size-4" /> 返回编辑
                </Button>
              )}
              {currentView === "evolution" && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setCurrentView("editor")}
                >
                  <ArrowLeftIcon className="mr-1 size-4" /> 返回编辑
                </Button>
              )}
              {canEdit && currentView === "editor" && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setCurrentView("versions")}
                >
                  <HistoryIcon className="mr-1 size-4" /> 版本历史
                </Button>
              )}
              {canEdit && currentView === "editor" && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setCurrentView("evolution")}
                >
                  <SparklesIcon className="mr-1 size-4" /> AI 演进
                </Button>
              )}
              {canEdit && currentView === "editor" && (
                <Button
                  size="sm"
                  variant={showDebugPanel ? "secondary" : "outline"}
                  onClick={() => setShowDebugPanel(!showDebugPanel)}
                >
                  <PlayIcon className="mr-1 size-4" /> 调试
                </Button>
              )}
              {canEdit && hasUnsavedChanges && (
                <Button
                  size="sm"
                  disabled={saveMutation.isPending}
                  onClick={() => void handleSave()}
                >
                  {saveMutation.isPending ? (
                    <LoaderIcon className="mr-1 size-4 animate-spin" />
                  ) : (
                    <SaveIcon className="mr-1 size-4" />
                  )}
                  保存
                </Button>
              )}
              <Button
                size="sm"
                className="bg-[linear-gradient(145deg,#2587ea,#419bff)] px-3 text-xs text-white shadow-[0_7px_16px_rgba(37,130,234,0.24)] hover:opacity-95"
                onClick={() => {
                  onOpenChange(false);
                  void router.push(
                    `/workspace/chats/new?skill=${encodeURIComponent(skill.name)}`,
                  );
                }}
              >
                去试试
              </Button>
              <button
                type="button"
                className="text-muted-foreground hover:bg-accent hover:text-foreground grid size-7 shrink-0 cursor-pointer place-items-center rounded-[7px] text-lg leading-none transition-colors"
                aria-label="关闭"
                onClick={() => onOpenChange(false)}
              >
                ×
              </button>
            </div>
          </div>
        </DialogHeader>

        {/* Body */}
        <div className="flex min-h-0 flex-1">
          {/* File sidebar */}
          <div
            className="border-border/60 flex shrink-0 flex-col border-r"
            style={{ width: sidebarWidth }}
          >
            <div className="text-muted-foreground flex h-9 items-center justify-between px-3 text-[11px] font-semibold">
              文件
              {canEdit && (
                <button
                  type="button"
                  title="新建文件"
                  className="hover:bg-accent hover:text-foreground grid size-5 cursor-pointer place-items-center rounded"
                  onClick={() => void handleCreateFile()}
                >
                  <PlusIcon className="size-3.5" />
                </button>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
              {filesLoading ? (
                <div className="text-muted-foreground flex h-16 items-center justify-center text-xs">
                  加载中...
                </div>
              ) : (
                files.map((file) => {
                  const active = selectedFile === file.path;
                  return (
                    <div
                      key={file.path}
                      className={cn(
                        "group flex cursor-pointer items-center gap-1.5 rounded-[7px] px-2 py-1.5 text-[11px] transition-colors",
                        active
                          ? "bg-[#eaf3fd] text-[#1671c5] dark:bg-sky-950/50 dark:text-sky-300"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                      onClick={() => setSelectedFile(file.path)}
                    >
                      <FileTextIcon className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{file.path}</span>
                      {canEdit && (
                        <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                          <button
                            type="button"
                            title="重命名"
                            className="hover:bg-accent grid size-4 cursor-pointer place-items-center rounded"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleRenameFile(file.path);
                            }}
                          >
                            <Undo2Icon className="size-3 -scale-x-100" />
                          </button>
                          <button
                            type="button"
                            title="删除"
                            className="hover:bg-destructive/10 hover:text-destructive grid size-4 cursor-pointer place-items-center rounded"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleDeleteFile(file.path);
                            }}
                          >
                            <Trash2Icon className="size-3" />
                          </button>
                        </span>
                      )}
                    </div>
                  );
                })
              )}
            </div>
            <div
              className="hover:bg-primary/30 w-1 shrink-0 cursor-col-resize transition-colors"
              onMouseDown={handleSidebarResizeStart}
            />
          </div>

          {/* Editor / versions */}
          <div className="min-w-0 flex-1 overflow-hidden">
            {currentView === "versions" ? (
              <div className="h-full overflow-y-auto bg-white p-5 dark:bg-slate-950">
                <h3 className="text-muted-foreground mb-3 text-xs font-semibold">
                  版本历史（保存/重命名/删除时自动生成，保留最近 20 个）
                </h3>
                {versions.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    暂无版本记录
                  </p>
                ) : (
                  <div className="space-y-2">
                    {versions.map((version) => (
                      <div
                        key={version.version_id}
                        className="border-border flex items-center justify-between gap-3 rounded-lg border bg-white px-3.5 py-2.5 dark:bg-slate-900"
                      >
                        <div className="min-w-0">
                          <p className="text-foreground text-xs font-medium">
                            {version.version_id}
                          </p>
                          <p className="text-muted-foreground mt-0.5 text-[11px]">
                            {formatTimestamp(version.timestamp)} ·{" "}
                            {version.files_changed.join(", ") || "（无文件）"}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-destructive shrink-0"
                          disabled={restoreMutation.isPending}
                          onClick={() => void handleRestore(version.version_id)}
                        >
                          回滚
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : currentView === "evolution" ? (
              <div className="h-full overflow-hidden">
                <EvolutionPanel skillName={skill.name} canEdit={canEdit} />
              </div>
            ) : (
              <div className="flex h-full flex-col">
                {selectedFile ? (
                  <>
                    <div className="border-border/60 flex h-9 items-center justify-between border-b px-4">
                      <span className="text-muted-foreground text-[11px]">
                        {selectedFile}
                      </span>
                      {hasUnsavedChanges && (
                        <span className="text-amber-600 text-[11px] font-medium dark:text-amber-400">
                          未保存
                        </span>
                      )}
                    </div>
                    <div className="min-h-0 flex-1 overflow-auto">
                      {contentLoading ? (
                        <div className="text-muted-foreground flex h-32 items-center justify-center text-sm">
                          <LoaderIcon className="mr-2 size-4 animate-spin" />
                          加载中...
                        </div>
                      ) : (
                        <CodeMirror
                          value={editedContent ?? fileContent?.content ?? ""}
                          height="100%"
                          theme={cmTheme}
                          extensions={cmExtensions}
                          editable={canEdit}
                          onChange={(value) => setEditedContent(value)}
                        />
                      )}
                    </div>
                  </>
                ) : (
                  <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
                    {files.length === 0 ? "技能目录为空" : "选择左侧文件查看内容"}
                  </div>
                )}

                {/* Debug panel */}
                {showDebugPanel && (
                  <div className="flex-shrink-0 border-t bg-muted/20">
                    <div className="max-h-80 space-y-3 overflow-y-auto p-4">
                      <div className="flex items-start gap-2">
                        <textarea
                          className="bg-background text-foreground placeholder:text-muted-foreground focus:ring-ring flex-1 rounded-md border px-3 py-2 text-sm resize-none focus:ring-1 focus:outline-none"
                          rows={2}
                          placeholder="输入测试提示词，例如: 分析一下当前项目的代码结构"
                          value={debugPrompt}
                          onChange={(e) => setDebugPrompt(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                              void handleDebugRun();
                            }
                          }}
                        />
                        <Button
                          size="sm"
                          className="mt-0.5"
                          disabled={debugMutation.isPending}
                          onClick={() => void handleDebugRun()}
                        >
                          {debugMutation.isPending ? (
                            <LoaderIcon className="mr-1 size-4 animate-spin" />
                          ) : (
                            <PlayIcon className="mr-1 size-4" />
                          )}
                          {debugMutation.isPending ? "运行中..." : "运行"}
                        </Button>
                      </div>

                      {debugMutation.isPending && (
                        <div className="text-muted-foreground flex items-center gap-2 py-4 text-sm">
                          <LoaderIcon className="size-4 animate-spin" />
                          Agent 正在执行技能，请稍候...
                        </div>
                      )}

                      {debugOutput && (
                        <div className="space-y-2">
                          <div className="text-muted-foreground flex items-center gap-3 text-xs">
                            <span>
                              状态:{" "}
                              <span
                                className={
                                  debugOutput.success
                                    ? "font-bold text-green-600"
                                    : "font-bold text-red-600"
                                }
                              >
                                {debugOutput.success ? "成功" : "失败"}
                              </span>
                            </span>
                            <span>
                              <ClockIcon className="mr-0.5 inline size-3" />
                              {(debugOutput.duration_ms / 1000).toFixed(1)}s
                            </span>
                            <span>{debugOutput.messages.length} 条消息</span>
                          </div>

                          {debugOutput.error && (
                            <pre className="border-red-200 text-red-800 dark:text-red-300 rounded-md border bg-red-50 p-3 font-mono text-xs whitespace-pre-wrap dark:bg-red-950/30">
                              {debugOutput.error}
                            </pre>
                          )}

                          <div className="space-y-1.5">
                            {debugOutput.messages
                              .filter(
                                (m) => m.content || (m.tool_calls?.length ?? 0) > 0,
                              )
                              .map((msg, i) => (
                                <div
                                  key={i}
                                  className="border-border rounded-md border p-2.5 text-xs"
                                >
                                  <div className="mb-1 flex items-center gap-2">
                                    <span
                                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                                        msg.role === "human"
                                          ? "bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-300"
                                          : msg.role === "tool"
                                            ? "bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-300"
                                            : "bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-300"
                                      }`}
                                    >
                                      {msg.role === "human"
                                        ? "用户"
                                        : msg.role === "tool"
                                          ? `工具: ${msg.name ?? ""}`
                                          : "助手"}
                                    </span>
                                    {msg.status && msg.status !== "ok" && (
                                      <span className="bg-destructive/10 text-destructive rounded-full px-2 py-0.5 text-[10px]">
                                        {msg.status}
                                      </span>
                                    )}
                                  </div>
                                  {msg.tool_calls && msg.tool_calls.length > 0 && (
                                    <div className="mb-1 space-y-1">
                                      {msg.tool_calls.map((tc, j) => (
                                        <div
                                          key={j}
                                          className="text-muted-foreground rounded bg-muted/50 px-2 py-1 font-mono"
                                        >
                                          <span className="text-sky-600 dark:text-sky-400">
                                            {tc.name}
                                          </span>
                                          <span className="ml-1 text-muted-foreground/60">
                                            ({Object.keys(tc.args).join(", ")})
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                  {msg.content && (
                                    <pre className="text-foreground/80 max-h-40 overflow-auto whitespace-pre-wrap">
                                      {msg.content.length > 2000
                                        ? `${msg.content.slice(0, 2000)}\n... (已截断)`
                                        : msg.content}
                                    </pre>
                                  )}
                                </div>
                              ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

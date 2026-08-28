"use client";

import {
  ArrowUpFromLineIcon,
  ChevronDownIcon,
  Code2Icon,
  DownloadIcon,
  EyeIcon,
  ExternalLinkIcon,
  LoaderIcon,
  MessagesSquareIcon,
  SearchIcon,
  StarIcon,
  XIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { loadArtifactContent } from "@/core/artifacts/loader";
import { appendHtmlPreviewBaseHref } from "@/core/artifacts/preview";
import { urlOfArtifact } from "@/core/artifacts/utils";
import { useAuth } from "@/core/auth/AuthProvider";
import {
  useMaterialActions,
  useMaterialCapabilities,
  useMaterials,
} from "@/core/materials/hooks";
import type { Material } from "@/core/materials/types";
import { SafeStreamdown } from "@/core/streamdown/components";
import {
  canBrowserPreviewFile,
  checkCodeFile,
  getFileExtensionDisplayName,
  getFileIcon,
  getFileName,
} from "@/core/utils/files";
import { cn } from "@/lib/utils";

import { artifactMarkdownPlugins } from "../artifacts/markdown-preview-plugins";

const iconMap: Record<string, string> = {
  doc: "/images/file/office-doc.png",
  sheet: "/images/file/office-els.png",
  slide: "/images/file/office-ppt.png",
  pdf: "/images/file/office-pdf.png",
  image: "/images/file/image.png",
  video: "/images/file/video.png",
  audio: "/images/file/mp3.png",
  md: "/images/file/office-txt.png",
  code: "/images/file/code.png",
  web: "/images/file/code.png",
  other: "/images/file/file.png",
};

const extensionIconMap: Record<string, string> = {
  ".doc": "/images/file/office-doc.png",
  ".docx": "/images/file/office-doc.png",
  ".pdf": "/images/file/office-pdf.png",
  ".xls": "/images/file/office-els.png",
  ".xlsx": "/images/file/office-els.png",
  ".numbers": "/images/file/office-NUMBERS.png",
  ".ppt": "/images/file/office-ppt.png",
  ".pptx": "/images/file/office-ppt.png",
  ".txt": "/images/file/office-txt.png",
  ".md": "/images/file/office-txt.png",
  ".png": "/images/file/image-PNG.png",
  ".jpg": "/images/file/image-jpeg.png",
  ".jpeg": "/images/file/image-jpeg.png",
  ".gif": "/images/file/image-gif.png",
  ".mp3": "/images/file/mp3.png",
  ".mp4": "/images/file/mp4.png",
  ".js": "/images/file/js.png",
  ".css": "/images/file/css.png",
  ".zip": "/images/file/zip.png",
  ".rar": "/images/file/rar.png",
  ".apk": "/images/file/apk.png",
  ".ipa": "/images/file/ipa.png",
};

const typeLabels: Record<string, string> = {
  all: "全部类型",
  doc: "文档",
  sheet: "表格",
  slide: "幻灯片",
  pdf: "PDF",
  image: "图片",
  video: "视频",
  audio: "音频",
  web: "网站",
  md: "MD",
  code: "代码",
  other: "其他",
};

function formatSize(bytes: number) {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function MaterialIcon({ item }: { item: Material }) {
  const extension = item.name.includes(".")
    ? `.${item.name.split(".").pop()?.toLowerCase()}`
    : "";
  return (
    <img
      src={extensionIconMap[extension] ?? iconMap[item.type] ?? iconMap.other}
      alt=""
      className="size-5 shrink-0 object-contain"
    />
  );
}

function Preview({ item, onClose }: { item: Material; onClose: () => void }) {
  const url = urlOfArtifact({
    filepath: item.path,
    threadId: item.thread_id,
  });
  const { isCodeFile, language } = useMemo(
    () => checkCodeFile(item.path),
    [item.path],
  );
  const supportsTextPreview = language === "html" || language === "markdown";
  const canPreviewInBrowser = canBrowserPreviewFile(item.path);
  const [viewMode, setViewMode] = useState<"code" | "preview">(
    supportsTextPreview ? "preview" : "code",
  );
  const [content, setContent] = useState("");
  const [isLoading, setIsLoading] = useState(isCodeFile);
  const [loadError, setLoadError] = useState(false);
  const [htmlPreviewURL, setHtmlPreviewURL] = useState<string>();

  useEffect(() => {
    setViewMode(supportsTextPreview ? "preview" : "code");
  }, [item.path, supportsTextPreview]);

  useEffect(() => {
    if (!isCodeFile || item.status === "missing") {
      setContent("");
      setIsLoading(false);
      setLoadError(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setLoadError(false);
    void loadArtifactContent({
      filepath: item.path,
      threadId: item.thread_id,
    })
      .then((result) => {
        if (!cancelled) setContent(result.content);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isCodeFile, item.path, item.status, item.thread_id]);

  useEffect(() => {
    if (language !== "html" || !content) {
      setHtmlPreviewURL(undefined);
      return;
    }
    const objectURL = URL.createObjectURL(
      new Blob([appendHtmlPreviewBaseHref(content, url)], {
        type: "text/html;charset=utf-8",
      }),
    );
    setHtmlPreviewURL(objectURL);
    return () => URL.revokeObjectURL(objectURL);
  }, [content, language, url]);

  return (
    <div className="bg-background text-foreground flex h-full flex-col">
      <div className="bg-muted/50 flex items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <MaterialIcon item={item} />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium" title={item.name}>
              {item.name}
            </h2>
            <p className="text-muted-foreground text-xs">
              {getFileExtensionDisplayName(item.path)} file ·{" "}
              {formatSize(item.size)}
            </p>
          </div>
        </div>
        {supportsTextPreview && !isLoading && !loadError && (
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={viewMode}
            onValueChange={(value) =>
              value && setViewMode(value as "code" | "preview")
            }
          >
            <ToggleGroupItem value="code" aria-label="代码视图">
              <Code2Icon />
            </ToggleGroupItem>
            <ToggleGroupItem value="preview" aria-label="预览视图">
              <EyeIcon />
            </ToggleGroupItem>
          </ToggleGroup>
        )}
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" asChild>
            <Link
              href={`/workspace/chats/${item.thread_id}`}
              aria-label="打开源会话"
            >
              <ExternalLinkIcon className="size-4" />
            </Link>
          </Button>
          <Button variant="ghost" size="icon-sm" asChild>
            <a
              href={urlOfArtifact({
                filepath: item.path,
                threadId: item.thread_id,
                download: true,
              })}
              download
              aria-label="下载"
            >
              <DownloadIcon className="size-4" />
            </a>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="关闭预览"
          >
            <XIcon className="size-4" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {item.status === "missing" ? (
          <PreviewFallback item={item} message="文件已失效或不存在" />
        ) : loadError ? (
          <PreviewFallback item={item} message="文件预览加载失败" />
        ) : isLoading ? (
          <div className="text-muted-foreground flex size-full items-center justify-center gap-2 text-sm">
            <LoaderIcon className="size-4 animate-spin" />
            正在加载预览…
          </div>
        ) : isCodeFile && language === "markdown" && viewMode === "preview" ? (
          <div className="size-full overflow-auto px-4 py-3">
            <SafeStreamdown className="min-w-0" {...artifactMarkdownPlugins}>
              {content}
            </SafeStreamdown>
          </div>
        ) : isCodeFile && language === "html" && viewMode === "preview" ? (
          <iframe
            title={item.name}
            className="size-full"
            sandbox="allow-scripts allow-forms"
            src={htmlPreviewURL}
          />
        ) : isCodeFile ? (
          <pre className="size-full overflow-auto p-4 font-mono text-sm whitespace-pre-wrap">
            {content}
          </pre>
        ) : canPreviewInBrowser ? (
          <iframe
            title={item.name}
            className="size-full"
            sandbox=""
            src={url}
          />
        ) : (
          <PreviewFallback
            item={item}
            message="此文件类型无法在浏览器中预览。"
          />
        )}
      </div>
    </div>
  );
}

function PreviewFallback({
  item,
  message,
}: {
  item: Material;
  message: string;
}) {
  return (
    <div className="flex size-full items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <div className="text-muted-foreground">
          {getFileIcon(item.path, "size-12")}
        </div>
        <div className="space-y-1">
          <div className="font-medium break-all">{getFileName(item.path)}</div>
          <div className="text-muted-foreground text-sm">
            {getFileExtensionDisplayName(item.path)} file
          </div>
        </div>
        <p className="text-muted-foreground text-sm">{message}</p>
        <Button asChild>
          <a
            href={urlOfArtifact({
              filepath: item.path,
              threadId: item.thread_id,
              download: true,
            })}
            download
          >
            <DownloadIcon className="size-4" />
            下载
          </a>
        </Button>
      </div>
    </div>
  );
}

export function MaterialsCenter() {
  const { user } = useAuth();
  const [query, setQuery] = useState("");
  const [type, setType] = useState("all");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Material | null>(null);
  const { data, isLoading, error } = useMaterials({
    q: query,
    type,
    favoritesOnly,
  });
  const { data: capabilities } = useMaterialCapabilities();
  const { favorite, upload } = useMaterialActions();
  const groups = useMemo(() => {
    const map = new Map<string, Material[]>();
    for (const item of data?.items ?? [])
      map.set(item.thread_id, [...(map.get(item.thread_id) ?? []), item]);
    return [...map.entries()].map(([threadId, items]) => ({
      threadId,
      title: items[0]?.thread_title ?? "未命名会话",
      items,
    }));
  }, [data?.items]);
  const canUpload = Boolean(
    capabilities?.can_upload && user?.system_role === "admin",
  );

  const toggleFavorite = (item: Material) =>
    favorite.mutate(
      { threadId: item.thread_id, path: item.path, favorite: !item.favorite },
      { onError: (e) => toast.error(e.message) },
    );
  const uploadItem = (item: Material) =>
    upload.mutate(
      {
        threadId: item.thread_id,
        path: item.path,
      },
      {
        onSuccess: () => toast.success("成功上传文件到知识库"),
        onError: (e) => toast.error(e.message),
      },
    );

  return (
    <div className="bg-background text-foreground flex size-full flex-col">
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold">资料中心</h1>
          <p className="text-muted-foreground mt-0.5 text-sm">
            按会话管理 Agent 明确呈现的文档、表格与产出物，便于追溯与复用
          </p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
        <div className="mx-auto max-w-[1440px]">
          <div className="bg-background relative mb-4 flex flex-wrap items-center gap-3 rounded-lg border p-3 shadow-xs">
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="h-8 w-32 text-xs">
                <SelectValue placeholder="选择类型" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(typeLabels).map(([key, label]) => (
                  <SelectItem key={key} value={key} className="text-xs">
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label className="relative w-full sm:w-60">
              <SearchIcon className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索文件"
                className="h-8 pl-8 text-xs"
              />
            </label>
            <label className="text-muted-foreground inline-flex cursor-pointer items-center gap-1.5 px-2 text-xs">
              <input
                type="checkbox"
                checked={favoritesOnly}
                onChange={(event) => setFavoritesOnly(event.target.checked)}
                className="accent-primary size-3.5"
              />
              我的收藏
            </label>
            <span className="text-muted-foreground ml-auto px-1 text-xs whitespace-nowrap">
              {groups.length} 个会话 · {data?.total ?? 0} 个文件
            </span>
          </div>
          {error && (
            <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-lg border p-4 text-sm">
              资料加载失败，请刷新重试。
            </div>
          )}
          {isLoading ? (
            <div className="text-muted-foreground rounded-lg border p-10 text-center text-sm">
              正在加载资料…
            </div>
          ) : groups.length === 0 ? (
            <div className="text-muted-foreground rounded-lg border border-dashed p-14 text-center text-sm">
              没有找到匹配的资料，请调整搜索或筛选条件。
            </div>
          ) : (
            <div className="bg-background overflow-x-auto rounded-lg border shadow-xs">
              <div className="text-foreground bg-muted/30 materials-grid hidden min-w-[900px] items-center gap-3 border-b px-5 py-3 text-sm font-semibold md:grid">
                <span />
                <span>名称</span>
                <span>类型</span>
                <span>更新时间</span>
                <span>大小</span>
                <span>操作</span>
              </div>
              {groups.map((group) => {
                const isCollapsed = collapsed[group.threadId];
                return (
                  <section
                    key={group.threadId}
                    className="border-border border-b last:border-0"
                  >
                    <div className="bg-muted/20 flex items-center gap-2 px-4 py-3.5">
                      <button
                        type="button"
                        onClick={() =>
                          setCollapsed((current) => ({
                            ...current,
                            [group.threadId]: !current[group.threadId],
                          }))
                        }
                        className="text-muted-foreground hover:bg-accent grid size-6 place-items-center rounded-md"
                        aria-label={isCollapsed ? "展开会话" : "折叠会话"}
                      >
                        <ChevronDownIcon
                          className={cn(
                            "size-4 transition-transform",
                            isCollapsed && "-rotate-90",
                          )}
                        />
                      </button>
                      <MessagesSquareIcon className="text-muted-foreground size-4 shrink-0" />
                      <Link
                        href={`/workspace/chats/${group.threadId}`}
                        className="text-foreground min-w-0 truncate text-base font-semibold hover:underline"
                      >
                        {group.title}
                      </Link>
                      <span className="text-muted-foreground ml-auto shrink-0 text-xs">
                        {group.items.length} 个文件
                      </span>
                    </div>
                    {!isCollapsed && (
                      <div>
                        {group.items.map((item) => (
                          <div
                            key={item.id}
                            className="materials-grid hover:bg-muted/30 grid items-center gap-3 border-t border-dashed px-5 py-2.5 transition"
                          >
                            <span className="relative left-7">
                              <MaterialIcon item={item} />
                            </span>
                            <button
                              type="button"
                              onClick={() => setSelected(item)}
                              className="text-foreground min-w-0 truncate text-left text-sm hover:underline"
                              title={item.name}
                            >
                              {item.name}
                            </button>
                            <span className="bg-primary/10 text-primary hidden rounded-md px-2 py-1 text-center text-[11px] md:inline-block">
                              {typeLabels[item.type] ?? "其他"}
                            </span>
                            <span className="text-muted-foreground hidden text-xs md:block">
                              {formatDate(item.updated_at)}
                            </span>
                            <span className="text-muted-foreground hidden text-xs md:block">
                              {formatSize(item.size)}
                            </span>
                            <div className="flex items-center justify-start gap-0.5">
                              <Button
                                variant="ghost"
                                size="icon"
                                className={cn(
                                  "size-7",
                                  item.favorite && "text-amber-500",
                                )}
                                onClick={() => toggleFavorite(item)}
                                aria-label={item.favorite ? "取消收藏" : "收藏"}
                              >
                                {item.favorite ? (
                                  <StarIcon className="size-4 fill-current" />
                                ) : (
                                  <StarIcon className="size-4" />
                                )}
                              </Button>
                              {canUpload &&
                                item.name.toLowerCase().endsWith(".md") && (
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="text-muted-foreground size-7"
                                    disabled={upload.isPending}
                                    onClick={() => uploadItem(item)}
                                    aria-label="上传到知识库"
                                    title="上传到知识库"
                                  >
                                    {upload.isPending ? (
                                      <LoaderIcon className="size-4 animate-spin" />
                                    ) : (
                                      <ArrowUpFromLineIcon className="size-4" />
                                    )}
                                  </Button>
                                )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <Sheet
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <SheetContent
          side="right"
          className="w-[calc(100vw-1rem)] max-w-none gap-0 p-0 sm:max-w-none md:w-[40vw] [&>button]:hidden"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{selected?.name ?? "资料预览"}</SheetTitle>
          </SheetHeader>
          {selected && (
            <Preview item={selected} onClose={() => setSelected(null)} />
          )}
        </SheetContent>
      </Sheet>
      <style jsx>{`
        .materials-grid {
          grid-template-columns: 36px minmax(0, 1fr) 28px 28px;
        }

        @media (min-width: 768px) {
          .materials-grid {
            grid-template-columns:
              36px minmax(0, 1fr)
              80px 125px 80px 112px;
            min-width: 900px;
          }
        }
      `}</style>
    </div>
  );
}

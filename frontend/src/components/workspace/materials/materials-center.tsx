"use client";

import {
  ArrowUpFromLineIcon,
  ChevronDownIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  LoaderIcon,
  SearchIcon,
  StarIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { urlOfArtifact } from "@/core/artifacts/utils";
import { useAuth } from "@/core/auth/AuthProvider";
import {
  useMaterialActions,
  useMaterialCapabilities,
  useMaterials,
} from "@/core/materials/hooks";
import type { Material } from "@/core/materials/types";
import { cn } from "@/lib/utils";

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
      className="size-7 shrink-0 object-contain"
    />
  );
}

function previewURLOf(item: Material) {
  const artifactURL = new URL(
    urlOfArtifact({ filepath: item.path, threadId: item.thread_id }),
    window.location.origin,
  );
  return item.preview_url
    ? new URL(item.preview_url, artifactURL.origin).toString()
    : artifactURL.toString();
}

function Preview({ item }: { item: Material }) {
  const url = previewURLOf(item);
  const isImage = item.type === "image";
  const isVideo = item.type === "video";
  const isAudio = item.type === "audio";
  useEffect(() => {
    console.info(
      "[资料中心] 文件预览 URL:",
      new URL(url, window.location.origin).toString(),
    );
  }, [url]);
  return (
    <div className="flex h-full flex-col bg-[#f7fafd]">
      <div className="flex items-start gap-3 border-b border-[#e4edf5] bg-linear-to-br from-[#f7fbff] to-[#edf6ff] p-5">
        <MaterialIcon item={item} />
        <div className="min-w-0 flex-1 pr-6">
          <h2 className="text-base font-semibold break-all text-[#173b5e]">
            {item.name}
          </h2>
          <p className="mt-1 text-xs text-[#73869a]">
            {typeLabels[item.type] ?? "其他"} · {formatSize(item.size)}
          </p>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-5">
        {item.status === "missing" ? (
          <div className="rounded-lg border border-dashed border-[#cbd9e7] bg-white p-8 text-center text-sm text-[#7a8da0]">
            文件已失效或不存在
          </div>
        ) : isImage ? (
          <img
            src={url}
            alt={item.name}
            className="mx-auto max-h-[65vh] max-w-full rounded-lg border bg-white object-contain shadow-sm"
          />
        ) : isVideo ? (
          <video
            src={url}
            controls
            className="mx-auto max-h-[65vh] max-w-full rounded-lg bg-slate-950"
          />
        ) : isAudio ? (
          <audio src={url} controls className="mt-10 w-full" />
        ) : (
          <iframe
            title={item.name}
            src={url}
            className="h-[65vh] w-full rounded-lg border bg-white"
          />
        )}
      </div>
      <div className="flex items-center justify-between border-t border-[#e4edf5] bg-white p-3">
        <Link
          href={`/workspace/chats/${item.thread_id}`}
          className="inline-flex items-center gap-1.5 text-xs text-[#1671c5] hover:underline"
        >
          <ExternalLinkIcon className="size-3.5" />
          打开源会话
        </Link>
        <a
          href={urlOfArtifact({
            filepath: item.path,
            threadId: item.thread_id,
            download: true,
          })}
          download
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#2582ea] px-3 text-xs font-medium text-white hover:bg-[#1671c5]"
        >
          <DownloadIcon className="size-3.5" />
          下载
        </a>
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
        url: previewURLOf(item),
      },
      {
        onSuccess: () => toast.success("成功上传文件到知识库"),
        onError: (e) => toast.error(e.message),
      },
    );

  return (
    <div className="min-h-full bg-[#f3f7fc] px-4 py-5 text-[#1e293b] sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1440px]">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-[#12395f] sm:text-[29px]">
              资料中心
            </h1>
            <p className="mt-1 text-xs text-[#728499]">
              按会话管理 Agent 明确呈现的文档、表格与产出物，便于追溯与复用
            </p>
          </div>
        </div>
        <div className="relative mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-[#e4edf5] bg-white p-2.5 shadow-sm">
          <div className="flex max-w-full gap-1 overflow-x-auto pb-0.5">
            {Object.entries(typeLabels).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setType(key)}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs whitespace-nowrap transition",
                  type === key
                    ? "bg-[#ebf4ff] font-semibold text-[#1671c5]"
                    : "text-[#5d7185] hover:bg-[#f0f6fb]",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="relative ml-auto w-full sm:w-60">
            <SearchIcon className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[#8093a6]" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索文件"
              className="h-8 border-[#d3e1ee] pl-8 text-xs"
            />
          </label>
          <label className="inline-flex cursor-pointer items-center gap-1.5 px-2 text-xs text-[#5d7185]">
            <input
              type="checkbox"
              checked={favoritesOnly}
              onChange={(event) => setFavoritesOnly(event.target.checked)}
              className="size-3.5 accent-[#419bff]"
            />
            我的收藏
          </label>
          <span className="ml-auto px-1 text-xs whitespace-nowrap text-[#8a9aac]">
            {groups.length} 个会话 · {data?.total ?? 0} 个文件
          </span>
        </div>
        {error && (
          <div className="rounded-xl border border-red-100 bg-red-50 p-4 text-sm text-red-600">
            资料加载失败，请刷新重试。
          </div>
        )}
        {isLoading ? (
          <div className="rounded-xl border border-[#e4edf5] bg-white p-10 text-center text-sm text-[#7a8da0]">
            正在加载资料…
          </div>
        ) : groups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[#cbd9e7] bg-white p-14 text-center text-sm text-[#7a8da0]">
            没有找到匹配的资料，请调整搜索或筛选条件。
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-[#e4edf5] bg-white shadow-sm">
            <div className="materials-grid hidden min-w-[900px] items-center gap-3 border-b border-[#eef2f7] bg-[#fafcfe] px-5 py-3 text-xs font-semibold text-[#2c4a66] md:grid">
              <span />
              <span>名称</span>
              <span>类型</span>
              <span>更新人</span>
              <span>更新时间</span>
              <span>大小</span>
              <span>操作</span>
            </div>
            {groups.map((group) => {
              const isCollapsed = collapsed[group.threadId];
              return (
                <section
                  key={group.threadId}
                  className="border-b border-[#f1f5f9] last:border-0"
                >
                  <div className="flex items-center gap-2 bg-linear-to-b from-[#fafcfe] to-[#f7fafd] px-4 py-3.5">
                    <button
                      type="button"
                      onClick={() =>
                        setCollapsed((current) => ({
                          ...current,
                          [group.threadId]: !current[group.threadId],
                        }))
                      }
                      className="grid size-6 place-items-center rounded-md text-[#94a8bb] hover:bg-[#eaf2fa]"
                      aria-label={isCollapsed ? "展开会话" : "折叠会话"}
                    >
                      <ChevronDownIcon
                        className={cn(
                          "size-4 transition-transform",
                          isCollapsed && "-rotate-90",
                        )}
                      />
                    </button>
                    <FolderOpenIcon className="size-5 text-[#7b9ab5]" />
                    <Link
                      href={`/workspace/chats/${group.threadId}`}
                      className="min-w-0 truncate text-base font-bold text-[#12395f] hover:text-[#1671c5] hover:underline"
                    >
                      {group.title}
                    </Link>
                    <span className="ml-auto shrink-0 text-xs text-[#8a9aac]">
                      {group.items.length} 个文件
                    </span>
                  </div>
                  {!isCollapsed && (
                    <div>
                      {group.items.map((item) => (
                        <div
                          key={item.id}
                          className="materials-grid grid items-center gap-3 border-t border-dashed border-[#f1f5f9] px-5 py-2.5 transition hover:bg-[#fafcfe]"
                        >
                          <MaterialIcon item={item} />
                          <button
                            type="button"
                            onClick={() => setSelected(item)}
                            className="min-w-0 truncate text-left text-sm text-[#2c4a66] hover:text-[#1671c5] hover:underline"
                            title={item.name}
                          >
                            {item.name}
                          </button>
                          <span className="hidden rounded-md bg-[#ebf4ff] px-2 py-1 text-center text-[11px] text-[#2582ea] md:inline-block">
                            {typeLabels[item.type] ?? "其他"}
                          </span>
                          <span className="hidden truncate text-xs text-[#7a8da0] md:block">
                            {item.updated_by}
                          </span>
                          <span className="hidden text-xs text-[#7a8da0] md:block">
                            {formatDate(item.updated_at)}
                          </span>
                          <span className="hidden text-xs text-[#7a8da0] md:block">
                            {formatSize(item.size)}
                          </span>
                          <div className="flex items-center justify-start gap-0.5">
                            <Button
                              variant="ghost"
                              size="icon"
                              className={cn(
                                "size-7",
                                item.favorite && "text-[#f5a623]",
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
                            {canUpload && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-7 text-[#5d7185]"
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
      <Sheet
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
      >
        <SheetContent
          side="right"
          className="w-full border-[#dce7f2] p-0 sm:max-w-[480px]"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{selected?.name ?? "资料预览"}</SheetTitle>
          </SheetHeader>
          {selected && <Preview item={selected} />}
        </SheetContent>
      </Sheet>
      <style jsx>{`
        .materials-grid {
          grid-template-columns: 28px minmax(0, 1fr) 28px 28px;
        }

        @media (min-width: 768px) {
          .materials-grid {
            grid-template-columns:
              36px minmax(0, 1fr)
              80px 110px 125px 80px 112px;
            min-width: 900px;
          }
        }
      `}</style>
    </div>
  );
}

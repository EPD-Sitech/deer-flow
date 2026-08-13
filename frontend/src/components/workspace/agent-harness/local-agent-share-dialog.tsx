"use client";

import { CopyIcon, LinkIcon, Loader2Icon } from "lucide-react";
import { useEffect, useState } from "react";
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
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/core/i18n/hooks";

import {
  getAgentShare,
  updateAgentShare,
  type AgentScope,
  type AgentShare,
} from "./agent-management-api";

interface LocalAgentShareDialogProps {
  agentName: string;
  scope?: AgentScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function LocalAgentShareDialog({
  agentName,
  scope = "user",
  open,
  onOpenChange,
}: LocalAgentShareDialogProps) {
  const { locale } = useI18n();
  const zh = locale.startsWith("zh");
  const [share, setShare] = useState<AgentShare | null>(null);
  const [slug, setSlug] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void getAgentShare(agentName, scope)
      .then((result) => {
        if (!active) return;
        setShare(result);
        setSlug(result.public_slug ?? "");
      })
      .catch((error) => {
        if (active)
          toast.error(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [agentName, scope]);

  const requestedSlug = slug.trim();
  const publicName = requestedSlug.length > 0 ? requestedSlug : (share?.public_name ?? agentName);
  const publicPath = `/public/agent/${encodeURIComponent(publicName)}`;
  const publicOrigin =
    typeof window === "undefined" ? "" : window.location.origin;
  const publicUrl = `${publicOrigin}${publicPath}`;

  async function save(enabled = share?.enabled ?? false) {
    setSaving(true);
    try {
      const updated = await updateAgentShare(
        agentName,
        {
          enabled,
          public_slug: slug.trim() || null,
        },
        scope,
      );
      setShare(updated);
      setSlug(updated.public_slug ?? "");
      toast.success(zh ? "分享设置已保存" : "Sharing settings saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(publicUrl);
      toast.success(zh ? "链接已复制" : "Link copied");
    } catch {
      toast.error(
        zh
          ? "复制失败，请手动复制链接"
          : "Copy failed. Select the link manually.",
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] overflow-hidden sm:max-w-lg">
        <DialogHeader className="min-w-0">
          <DialogTitle>{zh ? "分享公开链接" : "Share public link"}</DialogTitle>
          <DialogDescription>
            {zh
              ? "启用后，任何获得链接的人都能无需登录与此智能体对话。"
              : "Anyone with the link can chat with this agent without signing in."}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="text-muted-foreground flex h-32 items-center justify-center gap-2 text-sm">
            <Loader2Icon className="size-4 animate-spin" />
            {zh ? "正在读取分享设置" : "Loading sharing settings"}
          </div>
        ) : (
          <div className="min-w-0 space-y-5 py-2">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {zh ? "公开访问" : "Public access"}
                </p>
                <p className="text-muted-foreground mt-1 text-xs">
                  {share?.enabled
                    ? zh
                      ? "公开链接当前有效"
                      : "The public link is active"
                    : zh
                      ? "公开链接当前未启用"
                      : "The public link is disabled"}
                </p>
              </div>
              <Switch
                checked={share?.enabled ?? false}
                disabled={saving}
                aria-label={zh ? "公开访问" : "Public access"}
                onCheckedChange={(enabled) => void save(enabled)}
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor={`share-slug-${agentName}`}
                className="text-sm font-medium"
              >
                {zh ? "链接别名" : "Link alias"}
              </label>
              <div className="flex min-w-0 gap-2">
                <Input
                  id={`share-slug-${agentName}`}
                  value={slug}
                  maxLength={64}
                  placeholder={agentName}
                  className="min-w-0 font-mono"
                  onChange={(event) =>
                    setSlug(event.target.value.replace(/[^a-zA-Z0-9_-]/g, ""))
                  }
                />
                <Button
                  className="shrink-0"
                  variant="outline"
                  disabled={saving}
                  onClick={() => void save()}
                >
                  {zh ? "保存" : "Save"}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">
                {zh
                  ? "仅支持字母、数字、连字符和下划线；中文名称留空时会生成稳定别名。"
                  : "Use letters, numbers, hyphens, or underscores. Localized names receive a stable alias when blank."}
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">
                {zh ? "公开链接" : "Public link"}
              </p>
              <div className="flex min-w-0 gap-2">
                <div className="bg-muted flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-md border px-3">
                  <LinkIcon className="text-muted-foreground size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">
                    {publicUrl}
                  </span>
                </div>
                <Button
                  className="shrink-0"
                  size="icon"
                  title={zh ? "复制链接" : "Copy link"}
                  disabled={!share?.enabled}
                  onClick={() => void copyLink()}
                >
                  <CopyIcon className="size-4" />
                </Button>
              </div>
            </div>
          </div>
        )}

        <DialogFooter className="min-w-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {zh ? "关闭" : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

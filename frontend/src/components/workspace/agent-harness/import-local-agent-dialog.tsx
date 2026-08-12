"use client";

import { useQueryClient } from "@tanstack/react-query";
import { FileArchiveIcon, UploadIcon } from "lucide-react";
import { useRef, useState } from "react";
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
import { useI18n } from "@/core/i18n/hooks";

import { importAgent } from "./agent-management-api";

interface ImportLocalAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImportLocalAgentDialog({
  open,
  onOpenChange,
}: ImportLocalAgentDialogProps) {
  const { locale } = useI18n();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [nameOverride, setNameOverride] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [loading, setLoading] = useState(false);
  const zh = locale.startsWith("zh");

  function reset() {
    setFile(null);
    setNameOverride("");
    setOverwrite(false);
  }

  async function handleImport() {
    if (!file) return;
    setLoading(true);
    try {
      const result = await importAgent(file, {
        nameOverride: nameOverride.trim() || undefined,
        overwrite,
      });
      if (result.imported.length > 0) {
        toast.success(
          zh
            ? `已导入 ${result.imported.length} 个智能体`
            : `Imported ${result.imported.length} agent(s)`,
        );
      }
      if (result.errors.length > 0) {
        toast.error(result.errors.map((item) => item.error).join(", "));
      }
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      reset();
      onOpenChange(false);
    } catch (error) {
      const requestError = error as Error & { status?: number };
      if (requestError.status === 409 && !overwrite) setOverwrite(true);
      toast.error(requestError.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !loading) reset();
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {zh ? "导入本地智能体" : "Import local agent"}
          </DialogTitle>
          <DialogDescription>
            {zh
              ? "支持 ai-agent-harness 导出的 ZIP 或 Markdown 智能体包。"
              : "Supports ZIP and Markdown packages exported by ai-agent-harness."}
          </DialogDescription>
        </DialogHeader>

        <button
          type="button"
          className="hover:bg-muted/40 flex min-h-40 w-full cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 text-center transition-colors"
          onClick={() => fileInput.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            setFile(event.dataTransfer.files[0] ?? null);
          }}
        >
          {file ? (
            <FileArchiveIcon className="text-primary size-8" />
          ) : (
            <UploadIcon className="text-muted-foreground size-8" />
          )}
          <span className="max-w-full truncate text-sm font-medium">
            {file
              ? file.name
              : zh
                ? "点击选择或拖入文件"
                : "Choose or drop a file"}
          </span>
          <span className="text-muted-foreground text-xs">.zip / .md</span>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,.md,application/zip,text/markdown"
            className="hidden"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </button>

        <div className="space-y-2">
          <label htmlFor="agent-name-override" className="text-sm font-medium">
            {zh ? "重命名（可选）" : "Rename (optional)"}
          </label>
          <Input
            id="agent-name-override"
            value={nameOverride}
            onChange={(event) => setNameOverride(event.target.value)}
            placeholder="my-agent"
          />
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(event) => setOverwrite(event.target.checked)}
            className="size-4"
          />
          {zh
            ? "同名时覆盖现有智能体"
            : "Overwrite an agent with the same name"}
        </label>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            {zh ? "取消" : "Cancel"}
          </Button>
          <Button
            onClick={() => void handleImport()}
            disabled={!file || loading}
          >
            <UploadIcon className="size-4" />
            {loading ? (zh ? "导入中" : "Importing") : zh ? "导入" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

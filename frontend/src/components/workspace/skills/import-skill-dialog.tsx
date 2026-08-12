"use client";

import { UploadIcon } from "lucide-react";
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
import { useImportSkillPackage } from "@/core/skills/extended";

interface ImportSkillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const MAX_PACKAGE_SIZE = 2 * 1024 * 1024;

export function ImportSkillDialog({
  open,
  onOpenChange,
}: ImportSkillDialogProps) {
  const importSkillPackage = useImportSkillPackage();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  function handleFileSelected(selected: File) {
    setValidationError(null);
    if (!/\.(zip|skill)$/i.test(selected.name)) {
      setValidationError("仅支持 .zip / .skill 格式的技能包");
      setFile(null);
      return;
    }
    if (selected.size > MAX_PACKAGE_SIZE) {
      setValidationError("技能包大小不能超过 2MB");
      setFile(null);
      return;
    }
    setFile(selected);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (selected) handleFileSelected(selected);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const dropped = e.dataTransfer.files[0];
    if (dropped) handleFileSelected(dropped);
  }

  async function handleImport() {
    if (!file) return;
    try {
      const result = await importSkillPackage.mutateAsync(file);
      toast.success(`技能「${result.skill_name}」导入成功`);
      handleClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  function handleClose() {
    onOpenChange(false);
    setFile(null);
    setValidationError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) handleClose();
        else onOpenChange(true);
      }}
    >
      <DialogContent className="border-[color:var(--gp-border)] glass-panel">
        <DialogHeader>
          <DialogTitle>导入技能</DialogTitle>
          <DialogDescription>
            上传本地的 .zip / .skill 技能包，导入到个人技能库。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Drop zone */}
          <div
            className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-sky-200 bg-sky-50/50 px-6 py-8 transition-colors hover:border-sky-300 hover:bg-[var(--gp-surface-from)]"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
          >
            <UploadIcon className="h-8 w-8 text-sky-400" />
            <p className="text-sm font-medium text-text-secondary">
              {file ? file.name : "选择或拖拽技能包到此处"}
            </p>
            <p className="text-xs text-text-muted">.zip, .skill</p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,.skill"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>

          {validationError && (
            <p className="text-sm break-words whitespace-pre-wrap text-red-600">
              {validationError}
            </p>
          )}

          <p className="text-xs text-text-muted">
            导入后会进行安全扫描，并自动为技能生成中文名称与描述。
          </p>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            className="border-sky-200 bg-[var(--gp-surface-from)] text-text hover:bg-[var(--gp-surface-from)] hover:text-text"
            onClick={handleClose}
            disabled={importSkillPackage.isPending}
          >
            取消
          </Button>
          <Button
            className="bg-[linear-gradient(135deg,#2f6bff_0%,#63b4ff_100%)] text-white"
            onClick={handleImport}
            disabled={importSkillPackage.isPending || !file}
          >
            {importSkillPackage.isPending ? "导入中..." : "导入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

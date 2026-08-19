"use client";

import {
  ArrowDownIcon,
  ArrowUpIcon,
  LightbulbIcon,
  MicroscopeIcon,
  PenLineIcon,
  PlusIcon,
  ShapesIcon,
  SparklesIcon,
  Trash2Icon,
  GraduationCapIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  AgentWelcomeSuggestion,
  AgentWelcomeSuggestionIcon,
} from "@/core/agents";
import { cn } from "@/lib/utils";

const MAX_WELCOME_SUGGESTIONS = 6;
const ICON_OPTIONS: Array<{
  value: AgentWelcomeSuggestionIcon;
  label: string;
}> = [
  { value: "sparkles", label: "惊喜" },
  { value: "pen", label: "写作" },
  { value: "microscope", label: "研究" },
  { value: "shapes", label: "收集" },
  { value: "graduation-cap", label: "学习" },
  { value: "lightbulb", label: "灵感" },
];

type Mode = "default" | "hidden" | "custom";
type EditableItem = AgentWelcomeSuggestion & { id: string };

interface WelcomeSuggestionsEditorProps {
  value?: AgentWelcomeSuggestion[] | null;
  readOnly?: boolean;
  onChange: (value: AgentWelcomeSuggestion[] | null) => void;
}

export function WelcomeSuggestionsEditor({
  value,
  readOnly = false,
  onChange,
}: WelcomeSuggestionsEditorProps) {
  const initialMode: Mode =
    value == null ? "default" : value.length === 0 ? "hidden" : "custom";
  const [mode, setMode] = useState<Mode>(initialMode);
  const [items, setItems] = useState<EditableItem[]>(() =>
    (value ?? []).map((item) => ({ ...item, id: crypto.randomUUID() })),
  );

  const description = useMemo(() => {
    if (mode === "default") return "使用系统默认选项";
    if (mode === "hidden") return "已隐藏";
    return `${items.length} 个自定义选项`;
  }, [items.length, mode]);

  function changeMode(next: Mode) {
    setMode(next);
    onChange(next === "default" ? null : next === "hidden" ? [] : items.map(stripId));
  }

  function updateItem(id: string, patch: Partial<AgentWelcomeSuggestion>) {
    const next = items.map((item) => (item.id === id ? { ...item, ...patch } : item));
    setItems(next);
    onChange(next.map(stripId));
  }

  function moveItem(index: number, offset: -1 | 1) {
    const target = index + offset;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target]!, next[index]!];
    setItems(next);
    onChange(next.map(stripId));
  }

  function addItem() {
    if (items.length >= MAX_WELCOME_SUGGESTIONS) return;
    const next = [
      ...items,
      {
        id: crypto.randomUUID(),
        label: "新选项",
        prompt: "请描述你的需求：[]",
        icon: "lightbulb" as const,
      },
    ];
    setItems(next);
    setMode("custom");
    onChange(next.map(stripId));
  }

  function removeItem(id: string) {
    const next = items.filter((item) => item.id !== id);
    setItems(next);
    onChange(next.map(stripId));
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">欢迎快捷选项</p>
          <p className="text-muted-foreground text-xs">{description}</p>
        </div>
        {!readOnly && (
          <span className="text-muted-foreground text-[10px]">最多 6 条</span>
        )}
      </div>
      <div className="grid grid-cols-3 gap-1 rounded-md bg-muted p-1">
        {(
          [
            ["default", "使用默认"],
            ["hidden", "隐藏"],
            ["custom", "自定义"],
          ] as const
        ).map(([nextMode, label]) => (
          <button
            key={nextMode}
            type="button"
            disabled={readOnly}
            aria-pressed={mode === nextMode}
            onClick={() => changeMode(nextMode)}
            className={cn(
              "rounded px-2 py-1.5 text-xs font-medium transition-all",
              mode === nextMode
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
              readOnly && "cursor-not-allowed opacity-60",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "default" && (
        <p className="text-muted-foreground text-[11px]">
          使用系统预置的“小惊喜、写作、研究”等欢迎选项。
        </p>
      )}
      {mode === "hidden" && (
        <p className="text-muted-foreground text-[11px]">
          专家欢迎态不显示快捷选项。
        </p>
      )}
      {mode === "custom" && (
        <div className="space-y-2">
          {items.map((item, index) => (
            <div key={item.id} className="border-border bg-background space-y-2 rounded-md border p-2.5">
              <div className="flex items-center gap-2">
                <Input
                  value={item.label}
                  readOnly={readOnly}
                  placeholder="显示名称"
                  className="h-8 text-xs"
                  onChange={(event) => updateItem(item.id, { label: event.target.value })}
                />
                <select
                  value={item.icon}
                  disabled={readOnly}
                  aria-label="快捷选项图标"
                  className="border-input bg-background text-foreground h-8 rounded-md border px-2 text-xs"
                  onChange={(event) =>
                    updateItem(item.id, {
                      icon: event.target.value as AgentWelcomeSuggestionIcon,
                    })
                  }
                >
                  {ICON_OPTIONS.map((icon) => (
                    <option key={icon.value} value={icon.value}>{icon.label}</option>
                  ))}
                </select>
                <Button type="button" size="icon" variant="ghost" className="size-8 shrink-0" disabled={readOnly || index === 0} onClick={() => moveItem(index, -1)} aria-label="上移">
                  <ArrowUpIcon className="size-3.5" />
                </Button>
                <Button type="button" size="icon" variant="ghost" className="size-8 shrink-0" disabled={readOnly || index === items.length - 1} onClick={() => moveItem(index, 1)} aria-label="下移">
                  <ArrowDownIcon className="size-3.5" />
                </Button>
                <Button type="button" size="icon" variant="ghost" className="text-destructive hover:text-destructive size-8 shrink-0" disabled={readOnly} onClick={() => removeItem(item.id)} aria-label="删除">
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
              <Input
                value={item.prompt}
                readOnly={readOnly}
                placeholder="点击后填入输入框的提示词，可使用 [] 作为占位符"
                className="h-8 text-xs"
                onChange={(event) => updateItem(item.id, { prompt: event.target.value })}
              />
            </div>
          ))}
          {!readOnly && (
            <Button type="button" variant="outline" size="sm" className="w-full text-xs" disabled={items.length >= MAX_WELCOME_SUGGESTIONS} onClick={addItem}>
              <PlusIcon className="mr-1 size-3.5" /> 添加快捷选项（{items.length}/{MAX_WELCOME_SUGGESTIONS}）
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function stripId({ id: _id, ...item }: EditableItem): AgentWelcomeSuggestion {
  return item;
}

export const WELCOME_SUGGESTION_ICON_MAP = {
  sparkles: SparklesIcon,
  pen: PenLineIcon,
  microscope: MicroscopeIcon,
  shapes: ShapesIcon,
  "graduation-cap": GraduationCapIcon,
  lightbulb: LightbulbIcon,
};

"use client";

import {
  CalendarClockIcon,
  Loader2Icon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";

import {
  createAgentSchedule,
  deleteAgentSchedule,
  listAgentSchedules,
  triggerAgentSchedule,
  type AgentScope,
  type AgentSchedule,
} from "./agent-management-api";

interface LocalAgentSchedulePanelProps {
  agentName: string;
  scope?: AgentScope;
  zh: boolean;
}

export function LocalAgentSchedulePanel({
  agentName,
  scope = "user",
  zh,
}: LocalAgentSchedulePanelProps) {
  const [schedules, setSchedules] = useState<AgentSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [scheduleType, setScheduleType] = useState<"daily" | "cron">("daily");
  const [time, setTime] = useState("09:00");
  const [cron, setCron] = useState("0 9 * * *");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setSchedules(await listAgentSchedules(agentName, scope));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [agentName, scope]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate() {
    if (!prompt.trim()) return;
    setSubmitting(true);
    try {
      await createAgentSchedule(
        agentName,
        {
          title: title.trim(),
          prompt: prompt.trim(),
          schedule: {
            type: scheduleType,
            timezone: "Asia/Shanghai",
            ...(scheduleType === "daily"
              ? { time }
              : { cron_expr: cron.trim() }),
          },
          enabled: true,
        },
        scope,
      );
      toast.success(zh ? "定时任务已创建" : "Schedule created");
      setTitle("");
      setPrompt("");
      setShowForm(false);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string) {
    if (
      !window.confirm(zh ? "确认删除这个定时任务？" : "Delete this schedule?")
    ) {
      return;
    }
    try {
      await deleteAgentSchedule(agentName, id, scope);
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleTrigger(id: string) {
    try {
      await triggerAgentSchedule(agentName, id, scope);
      toast.success(zh ? "任务已触发" : "Schedule triggered");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-medium">{zh ? "定时任务" : "Schedules"}</h3>
          <p className="text-muted-foreground mt-1 text-xs">
            {zh
              ? "按计划自动向当前智能体提交任务。"
              : "Run prompts through this agent on a schedule."}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setShowForm((value) => !value)}
        >
          <PlusIcon className="size-4" />
          {zh ? "新建任务" : "New schedule"}
        </Button>
      </div>

      {showForm && (
        <div className="bg-muted/25 space-y-4 rounded-lg border p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="schedule-title" className="text-sm font-medium">
                {zh ? "名称" : "Title"}
              </label>
              <Input
                id="schedule-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={zh ? "日报生成" : "Daily report"}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">
                {zh ? "计划" : "Schedule"}
              </label>
              <div className="flex gap-2">
                <Select
                  value={scheduleType}
                  onValueChange={(value) =>
                    setScheduleType(value as "daily" | "cron")
                  }
                >
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily">
                      {zh ? "每天" : "Daily"}
                    </SelectItem>
                    <SelectItem value="cron">Cron</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  aria-label={
                    scheduleType === "daily"
                      ? zh
                        ? "执行时间"
                        : "Run time"
                      : "Cron"
                  }
                  type={scheduleType === "daily" ? "time" : "text"}
                  value={scheduleType === "daily" ? time : cron}
                  onChange={(event) =>
                    scheduleType === "daily"
                      ? setTime(event.target.value)
                      : setCron(event.target.value)
                  }
                />
              </div>
            </div>
          </div>
          <div className="space-y-2">
            <label htmlFor="schedule-prompt" className="text-sm font-medium">
              {zh ? "任务提示词" : "Prompt"}
            </label>
            <Textarea
              id="schedule-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={4}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowForm(false)}>
              {zh ? "取消" : "Cancel"}
            </Button>
            <Button
              onClick={() => void handleCreate()}
              disabled={!prompt.trim() || submitting}
            >
              {submitting && <Loader2Icon className="size-4 animate-spin" />}
              {zh ? "创建" : "Create"}
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-muted-foreground flex h-28 items-center justify-center">
          <Loader2Icon className="size-5 animate-spin" />
        </div>
      ) : schedules.length === 0 ? (
        <div className="text-muted-foreground flex h-28 flex-col items-center justify-center gap-2 border-y text-sm">
          <CalendarClockIcon className="size-5" />
          {zh ? "暂无定时任务" : "No schedules"}
        </div>
      ) : (
        <div className="divide-y border-y">
          {schedules.map((schedule) => (
            <div key={schedule.id} className="flex items-center gap-3 py-3">
              <CalendarClockIcon className="text-muted-foreground size-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{schedule.title}</p>
                <p className="text-muted-foreground mt-1 truncate text-xs">
                  {schedule.schedule_type} · {schedule.timezone}
                  {schedule.next_run_at
                    ? ` · ${new Date(schedule.next_run_at).toLocaleString()}`
                    : ""}
                </p>
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                title={zh ? "立即运行" : "Run now"}
                onClick={() => void handleTrigger(schedule.id)}
              >
                <PlayIcon className="size-4" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                title={zh ? "删除" : "Delete"}
                onClick={() => void handleDelete(schedule.id)}
              >
                <Trash2Icon className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

"use client";

import { BarChart3Icon, RefreshCwIcon } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  WorkspaceBody,
  WorkspaceContainer,
  WorkspaceHeader,
} from "@/components/workspace/workspace-container";
import {
  useOperationsDashboard,
  useOperationsDashboardDetails,
  type NamedMetric,
  type OperationsRange,
} from "@/core/operations";
import { cn } from "@/lib/utils";

const RANGES: Array<{ label: string; value: OperationsRange }> = [
  { label: "今日", value: 1 },
  { label: "近7天", value: 7 },
  { label: "近30天", value: 30 },
  { label: "近90天", value: 90 },
];

function formatNumber(value: number | null | undefined): string {
  const n = value ?? 0;
  if (Math.abs(n) >= 100_000_000) return `${(n / 100_000_000).toFixed(2)}亿`;
  if (Math.abs(n) >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
  return new Intl.NumberFormat("zh-CN").format(n);
}

function formatCurrency(value: number | null, currency: string | null): string {
  if (value === null) return "暂无";
  const prefix =
    currency === "CNY" || currency === "RMB"
      ? "¥"
      : currency
        ? `${currency} `
        : "";
  return `${prefix}${formatNumber(Math.round(value))}`;
}

function formatUpdated(value: string | undefined): string {
  if (!value) return "暂无数据";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function linePath(
  values: number[],
  width: number,
  height: number,
  scaleMax = Math.max(...values, 1),
): string {
  if (!values.length) return "";
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values.map((value, index) => ({
    x: index * step,
    y: height - (value / scaleMax) * (height - 8) - 4,
  }));
  if (points.length === 1) return `M${points[0]!.x},${points[0]!.y}`;

  // Catmull-Rom style control points keep the chart smooth without hiding the
  // actual data points or requiring a charting dependency for this lightweight SVG.
  let path = `M${points[0]!.x.toFixed(1)},${points[0]!.y.toFixed(1)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index]!;
    const next = points[index + 1]!;
    const previous = points[index - 1] ?? current;
    const following = points[index + 2] ?? next;
    const c1x = current.x + (next.x - previous.x) / 6;
    const c1y = current.y + (next.y - previous.y) / 6;
    const c2x = next.x - (following.x - current.x) / 6;
    const c2y = next.y - (following.y - current.y) / 6;
    path += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${next.x.toFixed(1)},${next.y.toFixed(1)}`;
  }
  return path;
}

function areaPath(
  values: number[],
  width: number,
  height: number,
  scaleMax: number,
): string {
  const line = linePath(values, width, height, scaleMax);
  if (!line) return "";
  return `${line} L${width},${height} L0,${height} Z`;
}

function SeriesChart({
  labels,
  series,
  emptyMessage,
}: {
  labels: string[];
  series: Array<{ name: string; values: number[]; color: string }>;
  emptyMessage?: string;
}) {
  const chartId = useId().replace(/:/g, "");
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const width = 720;
  const height = 180;
  const plotLeft = 34;
  const plotWidth = width - plotLeft;
  const max = Math.max(...series.flatMap((item) => item.values), 1);
  const ticks = [0, Math.round(max / 2), max];
  const hasData = series.some((item) => item.values.some((value) => value > 0));
  const pointX = (index: number) =>
    plotLeft +
    (labels.length > 1 ? (index * plotWidth) / (labels.length - 1) : 0);
  const pointY = (value: number) => height - (value / max) * (height - 8) - 4;
  const tooltipWidth = 188;
  const tooltipHeight = 30 + series.length * 20;
  const hoverX = hoverIndex === null ? null : pointX(hoverIndex);
  const tooltipX =
    hoverX === null
      ? 0
      : Math.min(width - tooltipWidth, Math.max(plotLeft, hoverX + 12));

  return (
    <div className="flex min-h-56 flex-col gap-2">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {series.map((item) => (
          <span
            key={item.name}
            className="text-muted-foreground flex items-center gap-1"
          >
            <span
              className="size-2 rounded-full shadow-[0_1px_3px_rgba(31,35,41,0.18)]"
              style={{ background: item.color }}
            />
            {item.name}
          </span>
        ))}
      </div>
      {!hasData && emptyMessage ? (
        <div className="text-muted-foreground flex h-48 items-center justify-center text-sm">
          {emptyMessage}
        </div>
      ) : (
        <svg
          className="h-48 w-full cursor-crosshair overflow-visible"
          viewBox={`0 0 ${width} ${height + 24}`}
          role="img"
          aria-label="趋势统计图"
          onMouseMove={(event) => {
            if (!labels.length) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            const viewBoxX =
              ((event.clientX - bounds.left) / bounds.width) * width;
            const relativeX = Math.min(
              plotWidth,
              Math.max(0, viewBoxX - plotLeft),
            );
            const index =
              labels.length > 1
                ? Math.round((relativeX / plotWidth) * (labels.length - 1))
                : 0;
            setHoverIndex(index);
          }}
          onMouseLeave={() => setHoverIndex(null)}
        >
          <defs>
            <filter
              id={`operations-line-shadow-${chartId}`}
              x="-20%"
              y="-20%"
              width="140%"
              height="160%"
            >
              <feDropShadow
                dx="0"
                dy="3"
                stdDeviation="3"
                floodColor="#1f2329"
                floodOpacity="0.14"
              />
            </filter>
            {series.map((item) => (
              <linearGradient
                key={item.name}
                id={`operations-fill-${chartId}-${item.name.replace(/[^a-zA-Z0-9]/g, "-")}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor={item.color} stopOpacity="0.22" />
                <stop
                  offset="100%"
                  stopColor={item.color}
                  stopOpacity="0.015"
                />
              </linearGradient>
            ))}
          </defs>
          {ticks.map((tick, index) => {
            const y = height - (tick / max) * (height - 8) - 4;
            return (
              <g key={`${tick}-${index}`}>
                <line
                  x1="34"
                  x2={width}
                  y1={y}
                  y2={y}
                  className="stroke-border/70"
                  strokeDasharray="4 5"
                />
                <text
                  x="0"
                  y={Math.max(10, y - 4)}
                  className="fill-muted-foreground text-[10px]"
                >
                  {formatNumber(tick)}
                </text>
              </g>
            );
          })}
          {series.map((item) => (
            <g key={item.name}>
              <path
                d={areaPath(item.values, plotWidth, height, max)}
                fill={`url(#operations-fill-${chartId}-${item.name.replace(/[^a-zA-Z0-9]/g, "-")})`}
                stroke="none"
                transform={`translate(${plotLeft} 0)`}
              />
              <path
                d={linePath(item.values, plotWidth, height, max)}
                fill="none"
                stroke={item.color}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2.5"
                filter={`url(#operations-line-shadow-${chartId})`}
                transform={`translate(${plotLeft} 0)`}
              />
            </g>
          ))}
          {labels.map((label, index) => {
            if (
              labels.length > 14 &&
              index % Math.ceil(labels.length / 8) !== 0
            )
              return null;
            const x = pointX(index);
            return (
              <text
                key={`${label}-${index}`}
                x={x}
                y={height + 16}
                textAnchor="middle"
                className="fill-muted-foreground text-[10px]"
              >
                {label}
              </text>
            );
          })}
          {hoverIndex !== null && hoverX !== null && (
            <g pointerEvents="none">
              <line
                x1={hoverX}
                x2={hoverX}
                y1="4"
                y2={height}
                className="stroke-foreground/35"
                strokeDasharray="3 3"
              />
              {series.map((item) => {
                const value = item.values[hoverIndex] ?? 0;
                return (
                  <circle
                    key={item.name}
                    cx={hoverX}
                    cy={pointY(value)}
                    r="4"
                    fill={item.color}
                    className="stroke-background"
                    strokeWidth="2"
                  />
                );
              })}
              <g transform={`translate(${tooltipX} 8)`}>
                <rect
                  width={tooltipWidth}
                  height={tooltipHeight}
                  rx="6"
                  className="fill-background stroke-border"
                  filter={`url(#operations-line-shadow-${chartId})`}
                />
                <text
                  x="12"
                  y="19"
                  className="fill-foreground text-[11px] font-semibold"
                >
                  {labels[hoverIndex]}
                </text>
                {series.map((item, index) => (
                  <g
                    key={item.name}
                    transform={`translate(0 ${30 + index * 20})`}
                  >
                    <circle cx="14" cy="0" r="3" fill={item.color} />
                    <text
                      x="23"
                      y="4"
                      className="fill-muted-foreground text-[10px]"
                    >
                      {item.name}
                    </text>
                    <text
                      x={tooltipWidth - 12}
                      y="4"
                      textAnchor="end"
                      className="fill-foreground text-[10px] font-semibold tabular-nums"
                    >
                      {formatNumber(item.values[hoverIndex] ?? 0)}
                    </text>
                  </g>
                ))}
              </g>
            </g>
          )}
        </svg>
      )}
    </div>
  );
}

function MetricTile({
  label,
  value,
  color,
  loading = false,
  delta,
}: {
  label: string;
  value: string;
  color: string;
  loading?: boolean;
  delta?: number | null;
}) {
  const hasDelta = typeof delta === "number";
  return (
    <div className="bg-background dark:border-border relative overflow-hidden rounded-[10px] border border-[#e8ecf1] p-3 shadow-[0_1px_3px_rgba(31,35,41,0.06),0_4px_12px_rgba(31,35,41,0.04)] transition-shadow hover:shadow-[0_4px_14px_rgba(31,35,41,0.1)]">
      <div
        className="absolute inset-y-0 left-0 w-1"
        style={{ background: color }}
      />
      <div className="text-muted-foreground text-xs">{label}</div>
      <div
        className={cn(
          "mt-1 truncate text-2xl font-semibold tabular-nums",
          loading && "bg-muted h-8 w-20 animate-pulse rounded text-transparent",
        )}
      >
        {loading ? "0" : value}
      </div>
      <div
        className={cn(
          "text-muted-foreground mt-1 text-[11px] tabular-nums",
          hasDelta && delta > 0 && "text-emerald-600",
          hasDelta && delta < 0 && "text-red-500",
        )}
      >
        {loading
          ? "正在统计"
          : hasDelta
            ? `${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta).toFixed(1)}% 环比`
            : "暂无环比"}
      </div>
    </div>
  );
}

function Panel({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "bg-background dark:border-border rounded-[10px] border border-[#e8ecf1] p-4 shadow-[0_1px_3px_rgba(31,35,41,0.06),0_4px_12px_rgba(31,35,41,0.04)] dark:shadow-[0_2px_10px_rgba(0,0,0,0.18)]",
        className,
      )}
    >
      <div className="mb-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && (
          <p className="text-muted-foreground mt-1 text-xs">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

function RankList({
  data,
  tone = "blue",
  emptyMessage = "暂无数据",
}: {
  data: NamedMetric[];
  tone?: "blue" | "green" | "purple";
  emptyMessage?: string;
}) {
  const max = Math.max(...data.map((item) => item.value), 1);
  const color =
    tone === "green"
      ? "bg-emerald-500"
      : tone === "purple"
        ? "bg-violet-500"
        : "bg-blue-600";
  if (!data.length) {
    return (
      <div className="text-muted-foreground flex h-44 items-center justify-center text-sm">
        {emptyMessage}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {data.slice(0, 8).map((item, index) => (
        <div
          key={`${item.name}-${index}`}
          className="grid grid-cols-[28px_minmax(0,104px)_1fr_72px] items-center gap-2 text-xs"
        >
          <span
            className={cn(
              "flex size-5 items-center justify-center rounded text-[11px]",
              index < 3 ? color : "bg-muted text-muted-foreground",
              index < 3 && "text-white",
            )}
          >
            {index + 1}
          </span>
          <span className="truncate">{item.name}</span>
          <span className="bg-muted h-2 overflow-hidden rounded">
            <span
              className={cn("block h-full rounded", color)}
              style={{ width: `${Math.max(3, (item.value / max) * 100)}%` }}
            />
          </span>
          <span className="text-muted-foreground text-right tabular-nums">
            {formatNumber(item.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="dark:bg-muted/60 rounded-[8px] bg-[#f8fafc] px-2.5 py-2">
      <div className="text-muted-foreground truncate text-xs">{label}</div>
      <div className="mt-1 text-[17px] font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="grid min-h-44 grid-cols-4 gap-2">
      {Array.from({ length: 8 }, (_, index) => (
        <div
          key={index}
          className="dark:bg-muted/40 animate-pulse rounded-[8px] bg-[#f8fafc] px-2.5 py-2"
        >
          <div className="bg-muted h-3 w-16 rounded" />
          <div className="bg-muted mt-2 h-5 w-12 rounded" />
        </div>
      ))}
    </div>
  );
}

export function OperationsDashboardPage() {
  const [range, setRange] = useState<OperationsRange>(7);
  const [activeMode, setActiveMode] = useState<"login" | "session">("login");
  const [costMode, setCostMode] = useState<"token" | "fee">("token");
  const [userCostMode, setUserCostMode] = useState<"token" | "fee">("token");
  const query = useOperationsDashboard(range);
  const detailsQuery = useOperationsDashboardDetails(range);
  const data = query.data;
  const details = detailsQuery.data;

  useEffect(() => {
    document.title = "平台运营数据看板 - DeerFlow";
  }, []);

  const feeTopUsers = useMemo(() => {
    if (!data?.totals.total_tokens || !data.totals.total_cost) return [];
    const costPerToken = data.totals.total_cost / data.totals.total_tokens;
    return data.top_users_tokens.map((item) => ({
      name: item.name,
      value: item.value * costPerToken,
    }));
  }, [data]);

  const feeSeries = useMemo(() => {
    if (!data) return [];
    if (data.series.token_cost.some((value) => value > 0)) {
      return data.series.token_cost;
    }
    const totalTokens = data.series.token_total.reduce(
      (sum, value) => sum + value,
      0,
    );
    if (
      data.totals.total_cost === null ||
      data.totals.currency === null ||
      !totalTokens
    ) {
      return data.series.token_cost;
    }
    return data.series.token_total.map(
      (value) => (value / totalTokens) * data.totals.total_cost!,
    );
  }, [data]);

  const kpis: Array<
    [string, string, string, boolean, number | null | undefined]
  > = data
    ? [
        [
          "用户总数",
          formatNumber(data.totals.total_users),
          "#2563eb",
          false,
          data.comparisons.total_users,
        ],
        [
          "用户登录次数",
          formatNumber(data.totals.total_logins),
          "#10b981",
          false,
          data.comparisons.total_logins,
        ],
        [
          "会话总数",
          formatNumber(data.totals.total_sessions),
          "#06b6d4",
          false,
          data.comparisons.total_sessions,
        ],
        [
          "生成资产总数",
          formatNumber(details?.total_artifacts),
          "#2563eb",
          details === undefined,
          details?.comparisons.total_artifacts ??
            data.comparisons.total_artifacts,
        ],
        [
          "智能体总数",
          formatNumber(details?.total_agents),
          "#f59e0b",
          details === undefined,
          details?.comparisons.total_agents ?? data.comparisons.total_agents,
        ],
        [
          "技能总数",
          formatNumber(details?.total_skills),
          "#f59e0b",
          details === undefined,
          details?.comparisons.total_skills ?? data.comparisons.total_skills,
        ],
        [
          "总消耗Token量",
          formatNumber(data.totals.total_tokens),
          "#7c3aed",
          false,
          data.comparisons.total_tokens,
        ],
        [
          "算力费用",
          formatCurrency(data.totals.total_cost, data.totals.currency),
          "#7c3aed",
          false,
          data.comparisons.total_cost,
        ],
      ]
    : [];

  return (
    <WorkspaceContainer>
      <WorkspaceHeader />
      <WorkspaceBody>
        <main className="mx-auto flex w-full max-w-[1500px] flex-col gap-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <BarChart3Icon className="size-5 text-blue-600" />
              <div>
                <h1 className="text-lg font-semibold">平台运营数据看板</h1>
                <p className="text-muted-foreground text-xs">
                  数据更新于 {formatUpdated(data?.meta.data_until)}
                </p>
              </div>
            </div>
            <div className="bg-background flex rounded-lg border p-1">
              {RANGES.map((item) => (
                <Button
                  key={item.value}
                  size="sm"
                  variant={range === item.value ? "default" : "ghost"}
                  onClick={() => setRange(item.value)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          </div>

          {query.isError && (
            <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-lg border p-4 text-sm">
              {query.error.message}
            </div>
          )}

          {!data && !query.isError && (
            <div className="text-muted-foreground flex h-80 items-center justify-center gap-2 text-sm">
              <RefreshCwIcon className="size-4 animate-spin" />
              正在加载运营数据
            </div>
          )}

          {data && (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
                {kpis.map(([label, value, color, loading, delta]) => (
                  <MetricTile
                    key={label}
                    label={label}
                    value={value}
                    color={color}
                    loading={loading}
                    delta={delta}
                  />
                ))}
              </div>

              <div className="grid gap-4 xl:grid-cols-4">
                <Panel
                  title="用户规模与活跃趋势"
                  description="注册用户 / 游客用户来自运营事件，活跃用户来自期间内运行用户"
                  className="xl:col-span-4"
                >
                  <SeriesChart
                    labels={data.series.labels}
                    series={[
                      {
                        name: "注册登录",
                        values: data.series.login_registered,
                        color: "#2563eb",
                      },
                      {
                        name: "游客登录",
                        values: data.series.login_guest,
                        color: "#10b981",
                      },
                      {
                        name: "活跃用户",
                        values: data.series.active_users,
                        color: "#f97316",
                      },
                    ]}
                  />
                </Panel>

                <Panel
                  title="登录与会话"
                  description="登录来自 operation_events，会话来自 runs"
                  className="xl:col-span-2"
                >
                  <SeriesChart
                    labels={data.series.labels}
                    series={[
                      {
                        name: "注册用户登录",
                        values: data.series.login_registered,
                        color: "#2563eb",
                      },
                      {
                        name: "游客用户登录",
                        values: data.series.login_guest,
                        color: "#10b981",
                      },
                      {
                        name: "会话数",
                        values: data.series.sessions_registered.map(
                          (v, i) => v + (data.series.sessions_guest[i] ?? 0),
                        ),
                        color: "#06b6d4",
                      },
                    ]}
                  />
                </Panel>

                <Panel
                  title="用户活跃 TOP8"
                  description={
                    activeMode === "login"
                      ? "期间内各用户登录次数排行"
                      : "期间内各用户会话数排行"
                  }
                  className="xl:col-span-2"
                >
                  <div className="bg-muted mb-3 flex rounded-md p-1">
                    <Button
                      size="sm"
                      variant={activeMode === "login" ? "default" : "ghost"}
                      onClick={() => setActiveMode("login")}
                    >
                      按登录次数
                    </Button>
                    <Button
                      size="sm"
                      variant={activeMode === "session" ? "default" : "ghost"}
                      onClick={() => setActiveMode("session")}
                    >
                      按会话数
                    </Button>
                  </div>
                  <RankList
                    data={
                      activeMode === "login"
                        ? data.top_users_login
                        : data.top_users_sessions
                    }
                    emptyMessage={
                      activeMode === "login"
                        ? "暂无登录事件数据"
                        : "暂无会话数据"
                    }
                  />
                </Panel>

                <Panel
                  title="智能体/技能使用趋势"
                  description="智能体按运行次数统计，技能包含显式激活和实际技能文件读取"
                  className="xl:col-span-4"
                >
                  <SeriesChart
                    labels={data.series.labels}
                    series={[
                      {
                        name: "智能体使用次数",
                        values: data.series.sessions_registered.map(
                          (v, i) => v + (data.series.sessions_guest[i] ?? 0),
                        ),
                        color: "#2563eb",
                      },
                      {
                        name: "技能使用次数",
                        values: data.series.skill_activations,
                        color: "#10b981",
                      },
                      {
                        name: "工具调用次数",
                        values: data.series.tool_calls,
                        color: "#f97316",
                      },
                    ]}
                  />
                </Panel>

                <Panel
                  title="智能体使用 TOP8"
                  description="期间内各智能体运行次数"
                  className="xl:col-span-2"
                >
                  <RankList data={data.top_agents} />
                </Panel>

                <Panel
                  title="技能使用 TOP8"
                  description="期间内显式激活及实际技能文件读取次数"
                  className="xl:col-span-2"
                >
                  <RankList data={data.top_skills} tone="green" />
                </Panel>

                <Panel
                  title="工具调用 TOP8"
                  description="期间内各工具实际调用次数"
                  className="xl:col-span-2"
                >
                  <RankList data={data.top_tools} tone="purple" />
                </Panel>

                <Panel
                  title="算力消耗趋势"
                  description={
                    costMode === "token"
                      ? "输入 / 输出 / 总 Token 量"
                      : "按已配置模型价格估算"
                  }
                  className="xl:col-span-4"
                >
                  <div className="bg-muted mb-3 flex rounded-md p-1">
                    <Button
                      size="sm"
                      variant={costMode === "token" ? "default" : "ghost"}
                      onClick={() => setCostMode("token")}
                    >
                      按Token
                    </Button>
                    <Button
                      size="sm"
                      variant={costMode === "fee" ? "default" : "ghost"}
                      onClick={() => setCostMode("fee")}
                    >
                      按费用
                    </Button>
                  </div>
                  <SeriesChart
                    labels={data.series.labels}
                    series={
                      costMode === "token"
                        ? [
                            {
                              name: "总消耗Token",
                              values: data.series.token_total,
                              color: "#ef4444",
                            },
                            {
                              name: "输入Token",
                              values: data.series.token_input,
                              color: "#7c3aed",
                            },
                            {
                              name: "输出Token",
                              values: data.series.token_output,
                              color: "#06b6d4",
                            },
                          ]
                        : [
                            {
                              name: "算力费用",
                              values: feeSeries,
                              color: "#7c3aed",
                            },
                          ]
                    }
                    emptyMessage={
                      costMode === "fee"
                        ? data.totals.currency === null
                          ? "暂无费用数据，请先配置模型价格"
                          : "暂无费用数据"
                        : "暂无Token数据"
                    }
                  />
                </Panel>

                <Panel
                  title="按用户分组消耗 TOP8"
                  description={
                    userCostMode === "token"
                      ? "各用户期间内 Token 消耗总量"
                      : "按总费用/总Token折算"
                  }
                  className="xl:col-span-2"
                >
                  <div className="bg-muted mb-3 flex rounded-md p-1">
                    <Button
                      size="sm"
                      variant={userCostMode === "token" ? "default" : "ghost"}
                      onClick={() => setUserCostMode("token")}
                    >
                      按Token
                    </Button>
                    <Button
                      size="sm"
                      variant={userCostMode === "fee" ? "default" : "ghost"}
                      onClick={() => setUserCostMode("fee")}
                    >
                      按费用
                    </Button>
                  </div>
                  <RankList
                    data={
                      userCostMode === "token"
                        ? data.top_users_tokens
                        : feeTopUsers
                    }
                    tone="purple"
                  />
                </Panel>

                <Panel
                  title="资产存量与调用"
                  description="存量指标来自配置、数据库和线程文件目录"
                  className="xl:col-span-2"
                >
                  {detailsQuery.isLoading ? (
                    <DetailSkeleton />
                  ) : detailsQuery.isError ? (
                    <div className="text-destructive flex min-h-44 items-center justify-center text-sm">
                      资产统计加载失败
                    </div>
                  ) : (
                    <div className="grid grid-cols-4 gap-2">
                      <MiniMetric
                        label="知识库总数"
                        value={formatNumber(details?.knowledge_bases_total)}
                      />
                      <MiniMetric
                        label="知识库文档数"
                        value={formatNumber(details?.knowledge_documents_total)}
                      />
                      <MiniMetric
                        label="工具总数"
                        value={formatNumber(data.totals.total_tools)}
                      />
                      <MiniMetric
                        label="工具调用次数"
                        value={formatNumber(data.totals.total_tool_calls)}
                      />
                      <MiniMetric
                        label="配置模型总数"
                        value={formatNumber(data.totals.configured_models)}
                      />
                      <MiniMetric
                        label="MCP启用数"
                        value={`${formatNumber(details?.mcp_enabled)}/${formatNumber(details?.mcp_total)}`}
                      />
                      <MiniMetric
                        label="技能使用次数"
                        value={formatNumber(
                          data.totals.total_skill_activations,
                        )}
                      />
                      <MiniMetric
                        label="用户反馈总数"
                        value={formatNumber(data.totals.feedback_total)}
                      />
                    </div>
                  )}
                </Panel>
              </div>
            </>
          )}
        </main>
      </WorkspaceBody>
    </WorkspaceContainer>
  );
}

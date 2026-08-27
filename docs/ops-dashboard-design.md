# DeerFlow 运营看板设计方案（架构设计交付）

> **版本**：v1.0（初稿，评审用）
> **日期**：2026-08-27
> **范围**：面向 DeerFlow AI 超级代理平台的**平台层运营看板**——覆盖任务运行、Token/成本、渠道消息、调度任务、资源与稳定性等维度的可观测性与运营指标可视化。
> **定位**：本文档从**架构设计**的角度交付，作为后续详细设计（DD）、编码和验收的输入，不下发具体页面像素级规格。

---

## 1. 背景与目标

### 1.1 背景

DeerFlow 是一套 LangGraph 全栈 AI 超级代理系统：后端（Gateway API + harness 运行时）承载沙箱执行、持久记忆、子代理委派、MCP / 技能扩展与多 IM 渠道接入；前端为 Next.js 对话界面；Nginx 作为统一入口；并已具备 Langfuse / LangSmith 双 provider 追踪、事件存储（event-store）、调度任务框架等能力。

当前系统在**单个会话/帖子**粒度具备较强的可观测性（流式事件、`task_*` 事件、tracing），但在**平台整体运营视角**缺少一个统一、可量化的运营看板：管理者/运营人员无法快速回答"系统今天跑了多少任务、消耗多少 Token、花了多少钱、各渠道消息量如何、有没有异常"等问题。

### 1.2 目标

- **OM-1 汇总可见**：一眼看清核心运营指标（任务量、Token、成本、活跃线程、消息量）。
- **OM-2 趋势分析**：支持日/周/月维度的趋势与对比。
- **OM-3 成本归因**：按模型、渠道、任务类型归因 Token 与成本，支撑容量与预算决策。
- **OM-4 稳定性监控**：任务成功率/失败率、错误分布、慢任务、并发占用，支撑 SRE 值班。
- **OM-5 低侵入**：建立在既有事件存储与 tracing 之上，不改变核心运行路径。

### 1.3 非目标（本期不做）

- 不替代 Langfuse / LangSmith 的**单次调用级**调试追踪。
- 不做用户登录/权限体系（复用现有 Gateway 鉴权）。
- 不做实时秒级（<1min）监控告警的大规模告警系统（可后续扩展）。

---

## 2. 方案总体架构

运营看板作为**独立、可选启用的模块**嵌入 DeerFlow，遵循"只读聚合、旁路采集、不侵入运行路径"的原则。整体分四层：

```
┌─────────────────────────────────────────────────────────────────┐
│                         前端展示层 Frontend                        │
│   Next.js 运营页面: 汇总卡片 / 趋势图 / 成本矩阵 / 稳定性面板        │
└───────────────▲─────────────────────────────────────────────────┘
                │ REST / GET-only 查询（复用 Gateway 鉴权）
┌───────────────┴─────────────────────────────────────────────────┐
│                       接口/查询层 API Layer                        │
│   Gateway 新增 read-only routers: /api/ops/*                      │
└───────────────▲─────────────────────────────────────────────────┘
                │ 结构化查询（时间桶、维度聚合）
┌───────────────┴─────────────────────────────────────────────────┐
│                     聚合/分析层 Aggregate Layer                    │
│   OpsAggregator: 时间桶化 + 维度下钻 + 缓存（Redis / 内存 TTL）     │
└───────────────▲─────────────────────────────────────────────────┘
                │ 读：事件快照 / 指标表
┌───────────────┴─────────────────────────────────────────────────┐
│                     数据/存储层 Storage Layer                      │
│   PostgreSQL: ops_metrics 指标表(物化滚动) + 既有 run_events 事件流 │
└─────────────────────────────────────────────────────────────────┘
        ▲                                     ▲
        │ 旁路写（异步、批量）                 │ 既有事件流
┌───────┴───────────────┐          ┌──────────┴──────────────┐
│   采集层 Collector     │          │ 运行时 hooks / tracing  │
│   (可选独立进程)       │          │ RunManager 生命周期事件  │
└───────────────────────┘          └─────────────────────────┘
```

### 2.1 分层职责

| 层 | 组件 | 职责 | 技术 |
|---|---|---|---|
| 采集层 | `OpsCollector` | 接收运行生命周期事件，抽取值指标，旁路写入指标存储 | 事件订阅 / 可选 Celery / 自研批量 worker |
| 存储层 | `ops_metrics` 系列表 + `run_events` | 物化的时间桶指标 + 明细事件 | PostgreSQL（复用现有 DB） |
| 聚合层 | `OpsAggregator` | 时间桶聚合、维度下钻、结果缓存与增量刷新 | Python service / 物化视图 + TTL 缓存 |
| 接口层 | `ops` routers | 只读 REST API 暴露聚合结果 | FastAPI（复用 Gateway） |
| 展示层 | 运营页面 | 卡片/图表/列表渲染 | Next.js + 现有 UI 组件库 |

### 2.2 设计原则

1. **旁路采集（Sidecar）**：采集与聚合不阻塞也不改动核心 Agent 运行路径，失败不影响主链路。
2. **物化先行（Materialize-first）**：高频指标按时间桶预先聚合落表，查询命中物化结果，避免对明细事件做全表扫描。
3. **只读 API**：`/api/ops/*` 全部为 GET，聚合层只读，杜绝写路径风险。
4. **可选启用**：`config.yaml -> ops.enabled` 缺省关闭；未启用时该模块不加载、零开销。
5. **复用既有设施**：时间/事件语义与 `run_events`、tracing 对齐，不重复造轮子。

---

## 3. 数据流设计

### 3.1 主数据链路

```
[Run 生命周期事件]──(1)──▶ OpsCollector (旁路)
                              │ (2) 向量化提取: duration, tokens, cost, status, model, channel, task, error_type
                              ▼
                        ┌───────────────┐
                        │  raw_event   │  (可选明细, 保留窗口 N 天)
                        └──────┬────────┘
                               │ (3) 按分钟桶聚合 upsert
                               ▼
                        ┌──────────────────────────┐
                        │ ops_metric_bucket_1m      │  最小粒度桶
                        └──────────┬───────────────┘
                                   │ (4) 递归/定时 Rollup
                                   ▼
                        ┌──────────────────────────┐
                        │ ops_metric_bucket_1h      │
                        └──────────┬───────────────┘
                                   │
                                   ▼
                        ┌──────────────────────────┐
                        │ ops_metric_bucket_1d      │
                        └──────────────────────────┘
                                   │ (5) 聚合层查询 + 缓存
                                   ▼
                        ┌──────────────────────────┐
                        │ /api/ops/*  (只读 REST)   │
                        └──────────────────────────┘
```

### 3.2 事件来源（数据输入）

| 来源 | 说明 | 捕获指标 |
|---|---|---|
| RunManager 运行生命周期 | 每次 run 的 开始/结束/超时/取消 | duration、status、token 用量、错误类型 |
| 模型工厂 tracing 回调查看 | Langfuse / LangSmith provider 的成本估算 | token 分模型、估算成本 |
| 子代理执行器 | 后台子代理 | task_id、子代理数、各自 token |
| 渠道接入层 | Feishu / Slack / Telegram / DingTalk / 网页 | 消息量、渠道分布、来源 thread |
| 调度任务服务 | 定时任务 run | 调度命中率、skip 原因、排队时长 |

### 3.3 数据输出（API 形态）

统一返回时间桶数组 + 维度聚合，契约示例：

```json
{
  "granularity": "1h",
  "range": { "start": "2026-08-26T00:00:00Z", "end": "2026-08-27T00:00:00Z" },
  "metrics": ["run_count", "token_total", "cost_est", "success_rate", "latency_p95"],
  "series": [
    { "bucket": "2026-08-26T08:00:00Z",
      "run_count": 120, "token_total": 1843200,
      "cost_est": 3.21, "success_rate": 0.96, "latency_p95": 45.2 }
  ],
  "dimensions": { "model": { "gpt-4o": { "run_count": 70, "token_total": 1200000 } } }
}
```

---

## 4. 指标定义与数据模型

### 4.1 核心指标（KPI）

| 维度 | 指标 | 单位 | 计算口径 |
|---|---|---|---|
| 运行 | `run_count` | 次 | 时间桶内 run 总数 |
| 运行 | `success_rate` | % | 成功 run / 总 run |
| 运行 | `fail_count` / `error_type_top` | 次 / - | 失败 run 及其错误类型 Top |
| 运行 | `latency_p50/p95/p99` | s | run 时长分位数 |
| 运行 | `active_runs` / 并发峰值 | 个 | 同时运行的 run（关联调度预算） |
| Token | `token_total` | 个 | 输入+输出 token 合计 |
| Token | `token_by(model|channel)` | 个 | 按模型/渠道拆分 |
| 成本 | `cost_est` | 元/美元 | 基于 provider 定价模型估算 |
| 渠道 | `msg_count` / 活跃会话 | 条 / 个 | 各 IM 渠道消息量 |
| 调度 | `scheduled_run_count` / `skip_count` | 次 | 定时任务命中/跳过 |
| 子代理 | `subagent_count` | 个 | 委派的子代理数 |

### 4.2 数据模型（DDL 概要）

**明细（可选，短期保留窗口）**

```sql
CREATE TABLE IF NOT EXISTS ops_raw_event (
  id            BIGSERIAL PRIMARY KEY,
  run_id        TEXT NOT NULL,
  event_ts      TIMESTAMPTZ NOT NULL,
  kind          TEXT NOT NULL,            -- run/msg/scheduled/subagent
  model         TEXT,
  channel       TEXT,
  task_id       TEXT,
  status        TEXT,
  duration_ms   BIGINT,
  token_in      BIGINT, token_out   BIGINT,
  cost_est      NUMERIC(12,6),
  error_type    TEXT,
  meta          JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_ops_raw_event_ts  ON ops_raw_event (event_ts);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_ops_raw_event_run ON ops_raw_event (run_id);
```

**物化桶（最小粒度 1 分钟）**

```sql
CREATE TABLE IF NOT EXISTS ops_metric_bucket_1m (
  bucket_ts   TIMESTAMPTZ NOT NULL,
  model       TEXT NOT NULL DEFAULT 'all',
  channel     TEXT NOT NULL DEFAULT 'all',
  kind        TEXT NOT NULL DEFAULT 'all',
  run_count   BIGINT DEFAULT 0,
  success_count BIGINT DEFAULT 0,
  fail_count  BIGINT DEFAULT 0,
  token_in    BIGINT DEFAULT 0, token_out BIGINT DEFAULT 0,
  cost_est    NUMERIC(14,6) DEFAULT 0,
  latency_sum BIGINT DEFAULT 0,            -- 用于均值
  lat_p50     DOUBLE PRECISION, lat_p95 DOUBLE PRECISION, lat_p99 DOUBLE PRECISION,
  PRIMARY KEY (bucket_ts, model, channel, kind)
);
CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_ops_bucket_1m_ts ON ops_metric_bucket_1m (bucket_ts);
```

> 1h / 1d 桶表同构，通过**定时 Rollup** 从低粒度桶递归合并且按序清理低层，避免无限膨胀。

**物化视图策略（可选）**：对跨维度下钻频繁的组合（如 `model × day`），用 PostgreSQL 物化视图 + `REFRESH CONCURRENTLY` 增量刷新，聚合层命中即可。

---

## 5. 聚合层设计（OpsAggregator）

### 5.1 职责

- **时间桶聚合**：把 1m 桶递归 Rollup 到 1h / 1d 桶。
- **维度下钻**：按 `model / channel / kind / task` 组合查询。
- **分位数计算**：p50/p95/p99 从明细或预置 t-digest 汇总中求取。
- **结果缓存**：命中高频查询的 TTL 缓存（如 5 分钟），降低重复聚合压力。

### 5.2 Rollup 调度

- **触发方式**：`OpsAggregator` 提供 `rollup(to_granularity)`，由：
  1. 采集层写入时按需增量触发（近实时），或
  2. `scheduler` 定时（每 5 分钟 Rollup 1h、每小时 Rollup 1d）兜底。
- **幂等性**：Rollup 采用 `UPSERT ... WHERE bucket 已存在则累加`，重复执行结果一致，可安全重启恢复。
- **保留策略**：1m 桶保留 7 天、1h 桶保留 90 天、1d 桶长期保留；由定时清理任务执行。

### 5.3 缓存

- 使用既有缓存设施（如已有 Redis 则用 Redis，否则进程内 TTL dict）。
- Key = `ops:{gran}:{range}:{dimensions}`，Value = 序列化聚合结果。
- 失效策略：TTL 到期或显式 invalidation。

---

## 6. 看板界面与图表设计

前端运营页面位于 `/workspace/ops`（沿用现有 workspace 布局与鉴权），包含四个面板：

### 6.1 汇总卡片（顶部 Overview）
- 今日/本周/本月：运行总数、成功率、Token 消耗、估算成本、活跃会话。
- 与上一周期的环比（↑/↓）。

### 6.2 趋势分析（Time-series）
- 运行量、成功率、Token、成本、P95 延迟的时间序列折线/面积图。
- 粒度切换：1h / 1d / 1w；区间选择。
- 参照线（昨日同期、预算阈值）。

### 6.3 成本与归因（Cost Attribution）
- 按 **模型 × 渠道** 的矩形树图/热力图。
- Token 输入/输出拆分柱状图。
- 调度任务成本 Top、子代理成本 Top。

### 6.4 稳定性面板（Stability / SRE）
- 错误分布饼图（错误类型 Top N）。
- 慢任务列表（P95 以上）、失败任务明细（窗口内）。
- 并发运行曲线 vs 调度预算水位。

> 图表复用现有前端 UI 组件库（若已引入图表库则复用，否则引入轻量图表库如 Recharts / ECharts）。

---

## 7. 技术选型与部署集成

### 7.1 组件选型

| 领域 | 选型 | 理由 |
|---|---|---|
| 存储 | PostgreSQL（复用现有 DB） | 无新增基础设施；物化桶 + 物化视图支持聚合 |
| 采集 | Python worker（复用 harness 事件订阅） | 与现有技术栈一致，无需引入新语言 |
| 聚合 | Python service / 物化视图 | 贴合并行调度预算语义 |
| 缓存 | 复用既有（Redis 优先，否则内存 TTL） | 最小化新增依赖 |
| 图表 | 前端既有组件库 / Recharts、ECharts | 快速落地、符合前端规范 |
| 鉴权 | 复用 Gateway 现有鉴权 | 只读 API 走既有可信主体校验 |

### 7.2 配置（config.yaml 新增）

```yaml
ops:
  enabled: false            # 缺省关闭，开启才加载模块
  raw_retention_days: 7
  bucket_retention:
    m1: 7      # days
    h1: 90
    d1: 365
  rollup_interval_s: 300
  cache_ttl_s: 300
  cost_model:                # 各 provider 定价，用于 cost_est 估算
    anthropic/claude-sonnet-4: { in: 3.0, out: 15.0 }   # 每 M token 美元
```

### 7.3 部署形态

- `ops.enabled=true` 时，采集 worker 随 Gateway 进程以**独立可旁路**方式启动；多实例部署时通过 DB 行长租约保证单点采集，避免重复计数。
- 前端页面按需路由挂载，无新增服务端口。
- 不新增 Docker 服务；补齐 `docker/` 与 `Makefile` 的启动/停止编排（进程由根生命周期管理）。

---

## 8. 非功能设计

### 8.1 性能
- 查询命中物化桶 + TTL 缓存，P95 请求 < 200ms。
- 写入走批量 upsert（采集侧攒批），主链路延迟影响 < 1ms。
- 物化表按时间分区，清理走 DROP PARTITION。

### 8.2 可靠性
- 采集失败仅丢统计、不影响运行；旁路进程崩溃可自愈重启。
- Rollup 幂等，重启不产生重复累计。

### 8.3 安全
- 只读 API 复用 Gateway 鉴权与授权（含 trusted-principal 校验）。
- 不做直连 DB 暴露，全部经 `OpsAggregator`。
- 成本估算为内部估算，不接入外部计费精确值。

### 8.4 可扩展性
- 指标通过 `kind` 维度扩展（run/msg/scheduled/subagent 已内置枚举，可增）。
- 桶粒度可配置；后续可平滑引入告警模块（基于聚合结果设阈值）与导出（CSV/订阅报表）。

---

## 9. 实施路线图

| 阶段 | 内容 | 交付物 | 里程碑验收 |
|---|---|---|---|
| **P0 采集+存储** | `OpsCollector`、`ops_raw_event`/桶表 DDL、运行生命周期事件接入 | 采集可落表 | 跑通 run → 1m 桶数据 |
| **P1 聚合+API** | `OpsAggregator` Rollup、只读 `/api/ops/*` | 聚合 API 可用 | 查询 1h/1d 聚合正确 |
| **P2 看板页面** | 四面板 UI 接 API | 运营页面可浏览 | 汇总/趋势/成本/稳定性可见 |
| **P3 加固+上线** | 缓存、保留清理、鉴权、测试、文档 | 可上线 | 通过既有 test/lint，更新 AGENTS.md/README |

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 采集成为主链路瓶颈 | 拖慢 run | 旁路进程 + 攒批异步写 + 独立的连接池 |
| 物化桶膨胀 | 存储/查询变慢 | 时间分区 + 分层保留 + 递归清理 |
| 成本估算不准 | 决策偏差 | 显式定价模型可配，标注"估算值" |
| 多实例重复计数 | 指标虚高 | DB 行长租约单点采集 + 幂等 upsert |
| 权限误暴露 | 数据泄漏 | 复用 trusted-principal 鉴权 + 只读诉求强制 |

---

## 11. 附录

### 11.1 待确认事项
- [ ] 成本估算的**计量货币与精度**（元 vs 美元、每 M token）。
- [ ] 运营看板面向的**角色**（平台管理员 / 运营 / SRE）及各自关注面板。
- [ ] 是否需要**告警**与**定期报表导出**（本期规划外，可作为 P4）。
- [ ] 前端图表组件库选型（复用现有 / Recharts / ECharts）。

### 11.2 关联既有能力
- `docs/plans/2026-04-01-langfuse-tracing.md`：多 provider tracing，成本估算数据源之一。
- `run_events`（DB backend）与 `RunManager` 生命周期：事件流来源。
- `scheduler` 框架：调度任务 run 的统计来源与 Rollup 定时器。
- 授权（pluggable-authorization）：只读 API 鉴权复用。

---

*本文档为架构层面的设计交付，详细接口定义、表结构与页面原型将在 D0/D1 评审后输出。*

# Nines-N3.1 流式 Token 重复计数修复文档

## 概述

本文档记录 oneai 中转模型（以 `Nines-N3.1` 为代表）在流式调用中 token 被重复累加、导致单次运行 token 总量被放大数百倍的修复方案，以及历史脏数据的修复办法。

**状态**: ✅ 已修复（代码 + 历史数据修复脚本均已落地）
**日期**: 2026-08-27
**影响版本**: 所有经 oneai 中转、且在每个流式 chunk 中重复回显 `usage` 的模型

---

## 问题描述

### 现象

- 运营看板 / 用户维度统计中，单个用户（如 SSO 用户 `zhongpq`）的 `Nines-N3.1` token 消耗被统计为数十亿级别（实测 3,796,757,840），而该用户实际用量（与 oneai 平台对账）仅为约 4,842,974，偏差约 **784 倍**。
- 单次运行（`runs` 表一行）的 `total_tokens` 可达到千万甚至上亿，远大于该次对话真实消耗的 token。

### 影响

- `runs.total_tokens` / `total_input_tokens` / `total_output_tokens` 及 `lead_agent_tokens` / `subagent_tokens` / `middleware_tokens` 全部被同步放大。
- `token_usage_by_model` JSON 中对应模型的 token 同样被放大。
- 运营看板的"按模型""按用户""按时间"聚合指标整体失真，无法用于成本与容量决策。

> 注意：oneai 平台自身的统计是**正确**的——它只读取最后一个 chunk 的 `usage`。问题出在 DeerFlow 侧对逐 chunk `usage` 的累加处理。

---

## 根本原因

### 链路拆解

1. **oneai 中继行为异常**：`https://oneai.teamshub.com/v1` 在流式响应里，**每一个 chunk 都回显了完整的 `usage` 对象**，而不是遵循 OpenAI 约定（仅最后一个 chunk 携带 `usage`）。
2. **langchain_core 拼接 chunk 时累加 usage**：`AIMessageChunk.__add__` 在合并流式 chunk 时，会调用 `add_usage` 把各 chunk 的 `usage_metadata` **相加**（`langchain_core/messages/ai.py` 中 `usage_metadata = add_usage(usage_metadata, other.usage_metadata)`）。因此一个流式输出 N 个 chunk 的 `AIMessage`，其 `usage_metadata` = `N × usage`。
3. **journal 读取已被累加的值**：DeerFlow 的 `runtime/journal.py` 在 `on_llm_end` 中读取 `message.usage_metadata`（按 `run_id` 去重，每个 run 只计一次），并写入 `runs` 表。它拿到的已经是 step 2 累加后的放大值，于是脏数据被持久化。

### 实测放大系数

以 `zhongpq` 为基准校准：

```
存储值 3,796,757,840 / oneai 正确值 4,842,974 ≈ 784
```

即该用户的 Nines 运行平均被放大约 **784 倍**（具体倍率随每次运行的 chunk 数浮动，通常数百倍）。

---

## 一次无效的修复尝试（记录以防重蹈覆辙）

最初尝试只重写 `ChatOpenAI._combine_llm_outputs`，让其在合并 `llm_output` 时取最后一个非空的 `token_usage` 而非求和。

**为什么无效**：

- `_combine_llm_outputs` 只影响 `llm_output` / `generation_info`（即 `response.llm_output` 与 `AIMessage` 的 `response_metadata`），**不影响** `AIMessage.usage_metadata`。
- 而 journal 读取的是 `message.usage_metadata` —— 这个值在 chunk 拼接阶段（step 2）就已经被 `add_usage` 放大，与 `_combine_llm_outputs` 这条路径无关。

结论：**必须在流式 chunk 层面拦截**，而不是在 `llm_output` 合并层面。

---

## 解决方案

### 核心思路

在**流式 chunk 转成 `ChatGenerationChunk` 的环节**拦截：只保留"第一个携带 `usage` 的 chunk"的 `usage_metadata`，把后续所有重复 chunk 的 `usage_metadata` 剥离为 `None`。这样 `AIMessageChunk.__add__` 在拼接时只会把 usage 加一次，最终 `AIMessage.usage_metadata` 即为正确值。

由于模型实例可能在同一次运行（lead agent + 子代理等）中被多次调用，需要在**每次流式调用开始时重置去重标志**，保证每次 LLM 调用各自只计一次。

### 设计原则

- ✅ 最小侵入：只改 oneai 中转模型的 chunk 转换行为，不动通用链路。
- ✅ 纵深防御：chunk 层剥离为主，`_combine_llm_outputs` 取末值作为兜底。
- ✅ 可测试：纯函数级别的 chunk 转换可被单测覆盖。
- ✅ 可回滚：通过配置 `use` 字段即可切回原始 `ChatOpenAI`。

---

## 详细代码改动

### 一、新增补丁类 `backend/packages/harness/deerflow/models/patched_oneai.py`

`PatchedChatONEAI(ChatOpenAI)` 在流式 chunk 层面去重 `usage_metadata`。

#### 1.1 每次流式调用重置去重标志

```python
def _reset_oneai_usage_seen(self) -> None:
    # 每次流式调用前重置；同一 run 内多次调用各自只计一次 usage
    self._oneai_usage_seen = False

def _stream(self, *args, **kwargs):
    self._reset_oneai_usage_seen()
    yield from super()._stream(*args, **kwargs)

async def _astream(self, *args, **kwargs):
    self._reset_oneai_usage_seen()
    async for chunk in super()._astream(*args, **kwargs):
        yield chunk
```

#### 1.2 chunk 转换时剥离重复 usage（核心修复）

```python
def _convert_chunk_to_generation_chunk(self, chunk, default_chunk_class, base_generation_info):
    generation_chunk = super()._convert_chunk_to_generation_chunk(
        chunk, default_chunk_class, base_generation_info
    )
    if generation_chunk is None:
        return None

    msg = generation_chunk.message
    usage = getattr(msg, "usage_metadata", None)
    if not usage:
        return generation_chunk

    if getattr(self, "_oneai_usage_seen", False):
        # 后续重复 chunk：剥离 usage，拼接时只加一次
        return ChatGenerationChunk(
            message=msg.model_copy(update={"usage_metadata": None}),
            generation_info=generation_chunk.generation_info,
        )

    self._oneai_usage_seen = True
    return generation_chunk
```

#### 1.3 纵深防御：`_combine_llm_outputs` 取末值

```python
def _combine_llm_outputs(self, llm_outputs):
    combined = super()._combine_llm_outputs(llm_outputs)
    last_usage = None
    for output in llm_outputs or []:
        if isinstance(output, dict):
            token_usage = output.get("token_usage")
            if isinstance(token_usage, dict) and token_usage:
                last_usage = token_usage
    if last_usage is not None:
        combined = {**combined, "token_usage": last_usage}
    return combined
```

**改动说明**：第 1.2 节是真正修复根因的部分；第 1.3 节仅作为兜底，确保即使走 `llm_output` 路径也不会出现求和。

---

### 二、接入补丁类 `backend/packages/harness/deerflow/runtime/transit.py`

将 oneai 中转模型使用的类从 `langchain_openai:ChatOpenAI` 改为补丁类：

```python
_TRANSIT_MODEL_USE = "deerflow.models.patched_oneai:PatchedChatONEAI"
```

所有经 oneai 中转、在 `config.yaml` 中 `use` 指向该类的模型都会自动获得修复后的行为。

---

### 三、单元测试 `backend/tests/test_patched_oneai.py`

覆盖关键行为（6 个用例全通过）：

- `test_first_chunk_keeps_usage`：首个带 usage 的 chunk 保留 `usage_metadata`。
- `test_duplicate_chunks_strip_usage`：后续重复 chunk 的 `usage_metadata` 被剥离为 `None`。
- `test_concatenated_usage_not_summed`：拼接后最终 `AIMessage` 的 `usage_metadata` 只计一次（不出现 3×120=360）。
- `test_usage_reset_between_streams`：新的流式调用（重新 `_astream`/`_stream`）会重新武装去重标志。
- `test_no_usage_passthrough`：无 usage 的 chunk 原样透传。
- `test_combine_llm_outputs_takes_last`：兜底路径取最后一个非空 `token_usage`。

---

### 四、历史脏数据修复脚本 `backend/scripts/fix_nines_token_inflation.py`

用于修复补丁生效前已写入 `deerflow.runs` 的膨胀行。

- **默认 dry-run**（只打印将要变更的内容，不写库）；`--apply` 才真正写库。
- **放大系数 `factor`**：默认 `784.0`（由 `zhongpq` 实测校准：3.796B / 4.842M ≈ 784）。
- **判定阈值 `threshold`**：`avg tokens/call = total_tokens / llm_call_count > 200_000` 视为膨胀行。正常模型每 call 约数万 token，bug 行每 call 达数百万，阈值可稳定区分。
- 对命中的行，将 `total_tokens` / `total_input_tokens` / `total_output_tokens` / `lead_agent_tokens` / `subagent_tokens` / `middleware_tokens` 以及 `token_usage_by_model` JSON 各字段统一除以 `factor`。

运行方式：

```bash
# 预览（不写库）
python scripts/fix_nines_token_inflation.py --dsn "$DATABASE_URL"

# 确认无误后写入
python scripts/fix_nines_token_inflation.py --dsn "$DATABASE_URL" --apply
```

---

## 历史数据修复（实际操作记录）

- 修复前：`zhongpq` 的 Nines 运行被累计至约 38 亿 token。
- 第一次清理后回落到约 485 万（与 oneai 对账值 4,842,974 偏差 < 0.2%）。
- 补丁重写（改为 chunk 层修复）后，网关在加载旧（无效）补丁期间又产生 1 条新的膨胀 run（1.14 亿 token，avg 674 万/call）。已用 `--apply` 单独清理。
- 最终 `zhongpq` Nines 总计约 557 万（略高于 484 万快照，因快照后又有正常使用），**全局已无 avg/call > 20 万 的残留膨胀 run**。

> 系数 784 为基于 `zhongpq` 的近似校准值。若需逐 run 的精确值，应以 oneai 计费 API 回拉为准；脚本的修复目标是让看板量级与趋势恢复合理，而非精确到个位。

---

## 部署与生效

补丁通过 `transit._TRANSIT_MODEL_USE` 接入，**必须重启网关**才能加载新的 `patched_oneai.py` 类对象。

⚠️ 常见坑：若网关重启发生在补丁**重写之前**，加载的是第一版（无效的 `_combine_llm_outputs` 方案），新产生的 Nines run 仍会膨胀。需确保重启时本地 `patched_oneai.py` 已是 chunk 层修复版本。

---

## 影响范围

### 后端

1. **新增文件**：`backend/packages/harness/deerflow/models/patched_oneai.py`（`PatchedChatONEAI`）。
2. **配置接入**：`transit.py` 的 `_TRANSIT_MODEL_USE` 指向补丁类。
3. **新增脚本**：`backend/scripts/fix_nines_token_inflation.py`（历史脏数据修复）。
4. **新增测试**：`backend/tests/test_patched_oneai.py`。

### 运行路径

- 仅影响 oneai 中转模型（`config.yaml` 中 `use` 指向 `deerflow.models.patched_oneai:PatchedChatONEAI` 的模型）。
- 非 oneai 模型（遵循 OpenAI 仅末 chunk 回显 usage 的约定）行为不变——因为对它们而言只有一个 chunk 带 usage，去重逻辑等价透传。

---

## 验证方法

### 1. 代码层

```bash
cd backend && python -m pytest tests/test_patched_oneai.py -q
```

### 2. 数据层（直连 `deerflow.runs`，schema `deerflow`）

```sql
-- 仍存在膨胀的 Nines run（应为 0 行）
SELECT run_id, total_tokens, llm_call_count,
       ROUND(total_tokens::numeric / NULLIF(llm_call_count, 0)) AS avg_per_call
FROM deerflow.runs
WHERE lower(model_name) LIKE '%nines%'
  AND (total_tokens::float / NULLIF(llm_call_count, 0)) > 200000;
```

- 期望结果：**0 行**。
- 正常 run 的 `avg_per_call` 应在数万量级（数千 ~ 十余万），不再出现数百万/call。

### 3. 运行层

重启网关后，跑一条 Nines 对话，确认新 run 的 `total_tokens` 在合理量级（与对话实际长度匹配），且运营看板对应用户/模型的 token 统计与 oneai 平台对账一致。

---

## 已知问题（非本次 bug，仅供参考）

### ⚠️ 偶发的 `output_tokens = 0`

全库 294 条有 LLM 调用的 run 中，约 3 条（<1%）出现 `total_output_tokens = 0` 但 `llm_call_count > 0` 的异常（如 `36ee0ccf`：input 257,859、output 0、3 次调用）。

- 这与本次的 784x 膨胀**不是同一问题**：膨胀 bug 的特征是 input+output 一起被放大到百万级/call，而此处 output 恒为 0。
- 更可能是上游中继对该 run 只回了 prompt 用量、未回 completion 用量，或 journal 录制逻辑的边缘情况。
- 由于缺乏 oneai 真实值做基准，未做盲修。如需处理，建议单独排查 journal 录制与 oneai 回包，不在本修复范围内。

---

## 回滚方案

若需回退本修复：

1. **切回原模型类**：将 `transit.py` 的
   `_TRANSIT_MODEL_USE = "deerflow.models.patched_oneai:PatchedChatONEAI"`
   改回 `"langchain_openai:ChatOpenAI"`，重启网关。
   - 风险：回滚后 Nines 新 run 会重新出现 784x 膨胀，需配合重新跑 `fix_nines_token_inflation.py --apply` 清理。
2. **删除新增文件**：`patched_oneai.py`、测试与修复脚本。
3. **历史数据**：脚本为幂等缩放（除以 factor）；若需还原比例，需依赖修复前的数据库备份，脚本本身不提供反向乘回。

---

## 总结

### 改动统计

- **新增文件**：
  - `backend/packages/harness/deerflow/models/patched_oneai.py`
  - `backend/scripts/fix_nines_token_inflation.py`
  - `backend/tests/test_patched_oneai.py`
- **修改文件**：
  - `backend/packages/harness/deerflow/runtime/transit.py`（1 行：`_TRANSIT_MODEL_USE` 指向补丁类）

### 核心改进

1. ✅ **根因修复**：在流式 chunk 层剥离重复 `usage_metadata`，拼接时只计一次。
2. ✅ **可验证**：6 个单测覆盖去重与拼接行为。
3. ✅ **可补救**：提供历史脏数据修复脚本（dry-run 安全、系数可配）。
4. ✅ **最小侵入**：仅 oneai 中转模型受影响，非 oneai 模型行为不变。
5. ✅ **可回滚**：改一处 `use` 配置即可切回原类。

### 注意事项

- ⚠️ 修复生效依赖**网关重启**加载新类；重启时机不对会仍跑旧（无效）补丁。
- ⚠️ 历史修复系数为基于 `zhongpq` 的近似值，精确值需以 oneai 计费为准。
- ⚠️ `output_tokens = 0` 偶发问题为独立问题，不在本修复范围。

---

**文档版本**: 1.0
**最后更新**: 2026-08-27
**维护者**: AI Assistant

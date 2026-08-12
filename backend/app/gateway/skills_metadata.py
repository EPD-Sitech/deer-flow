"""Skill business metadata (Chinese display name / description / category / tags).

Ported from the ai-agent-harness skills platform for the skills gallery
migration. The original stored metadata in a SQLite ``skill_metadata`` table;
this port uses a JSON file next to the existing ``_skill_states.json``:

    {base_dir}/users/{user_id}/skills/_skill_metadata.json

The dict is keyed by ``skill.name`` (deer-flow is single-user-deployment
oriented; the storage layer's shadow semantics already prevent a custom
skill and a public skill with the same name from being visible at once).

Everything here is backend-only; the frontend mirrors the category
definitions in ``frontend/src/core/skills/categories.ts``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import tempfile
from pathlib import Path
from typing import Any

from deerflow.config import paths as deerflow_paths
from deerflow.models import create_chat_model
from deerflow.runtime.user_context import get_effective_user_id
from deerflow.skills.types import SkillCategory

logger = logging.getLogger(__name__)

SKILL_CATEGORY_DEFINITIONS = [
    {"id": "customer_insight", "label": "客户洞察"},
    {"id": "industry_market", "label": "行业市场"},
    {"id": "product_factory", "label": "产品工厂"},
    {"id": "trading_assist", "label": "交易辅助"},
    {"id": "compliance_risk", "label": "合规风控"},
    {"id": "data_analysis", "label": "数据分析"},
    {"id": "operations_finance", "label": "运营财务"},
    {"id": "enterprise_office", "label": "企业办公"},
    {"id": "other", "label": "其他"},
]
SKILL_CATEGORY_LABELS = {item["id"]: item["label"] for item in SKILL_CATEGORY_DEFINITIONS}
SKILL_CATEGORY_IDS = set(SKILL_CATEGORY_LABELS)

METADATA_FILENAME = "_skill_metadata.json"

_METADATA_FIELDS = (
    "display_name",
    "description_zh",
    "safety_level",
    "capabilities",
    "recommended_scenarios",
    "category",
    "tags",
)


def _metadata_file_path(user_id: str | None = None) -> Path:
    """Path of the per-user skill metadata file."""
    user_id = user_id or get_effective_user_id()
    return deerflow_paths.get_paths().user_skills_dir(user_id) / METADATA_FILENAME


def load_skill_metadata(user_id: str | None = None) -> dict[str, dict[str, Any]]:
    """Load all skill metadata. Returns ``{skill_name: entry}``."""
    path = _metadata_file_path(user_id)
    if not path.exists():
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except (json.JSONDecodeError, OSError):
        logger.warning("Failed to read skill metadata file %s", path)
    return {}


def _write_skill_metadata(data: dict[str, dict[str, Any]], user_id: str | None = None) -> None:
    """Atomically persist the metadata dict (temp file + replace)."""
    path = _metadata_file_path(user_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, suffix=".json.tmp")
    try:
        with open(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        Path(tmp_name).replace(path)
    except Exception:
        try:
            Path(tmp_name).unlink(missing_ok=True)
        except OSError:
            pass
        raise


def get_skill_metadata_entry(skill_name: str, user_id: str | None = None) -> dict[str, Any] | None:
    return load_skill_metadata(user_id).get(skill_name)


def save_skill_metadata_entry(
    skill_name: str,
    entry: dict[str, Any],
    user_id: str | None = None,
) -> None:
    """Upsert one skill's metadata entry."""
    data = load_skill_metadata(user_id)
    data[skill_name] = entry
    _write_skill_metadata(data, user_id)


def delete_skill_metadata_entry(skill_name: str, user_id: str | None = None) -> None:
    data = load_skill_metadata(user_id)
    if skill_name in data:
        del data[skill_name]
        if data:
            _write_skill_metadata(data, user_id)
        else:
            # Nothing left — remove the file entirely.
            try:
                _metadata_file_path(user_id).unlink(missing_ok=True)
            except OSError:
                pass


def skill_to_response_dict(skill: Any) -> dict[str, Any]:
    """Build the full frontend-facing skill dict, merging stored metadata.

    Mirrors the harness ``SkillResponse`` shape: base fields plus optional
    business metadata (Chinese display name/description, category, tags).
    """
    entry = get_skill_metadata_entry(skill.name) or {}

    if skill.category == SkillCategory.CUSTOM:
        scope = "user"
    elif skill.category == SkillCategory.LEGACY:
        scope = "legacy"
    else:
        scope = "public"

    skill_category = normalize_skill_category(entry.get("category"))
    if skill_category == "other" and not entry.get("category"):
        skill_category = infer_skill_category(skill.name, skill.description)

    tags = normalize_skill_tags(entry.get("tags"))
    if not tags:
        try:
            content = skill.skill_file.read_text(encoding="utf-8")
            tags = extract_frontmatter_tags(content)
        except OSError:
            tags = []

    return {
        "name": skill.name,
        "description": skill.description,
        "license": skill.license,
        "category": str(skill.category),
        "skill_category": skill_category,
        "category_label": SKILL_CATEGORY_LABELS.get(skill_category, "其他"),
        "tags": tags,
        "enabled": skill.enabled,
        "editable": skill.category == SkillCategory.CUSTOM,
        "display_name": entry.get("display_name") or None,
        "description_zh": entry.get("description_zh") or None,
        "safety_level": entry.get("safety_level") or None,
        "capabilities": entry.get("capabilities") or None,
        "recommended_scenarios": entry.get("recommended_scenarios") or None,
        "scope": scope,
        "can_manage": skill.category == SkillCategory.CUSTOM,
    }


# ── Category / tag normalization ─────────────────────────────────────────────


def normalize_skill_category(value: Any) -> str:
    category = str(value or "").strip()
    if category in SKILL_CATEGORY_IDS:
        return category
    for item in SKILL_CATEGORY_DEFINITIONS:
        if category == item["label"]:
            return item["id"]
    return "other"


def normalize_skill_tags(value: Any) -> list[str]:
    if value is None:
        return []
    raw_tags: list[Any]
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            raw_tags = []
        else:
            try:
                loaded = json.loads(stripped)
                raw_tags = loaded if isinstance(loaded, list) else re.split(r"[,，、]", stripped)
            except Exception:
                raw_tags = re.split(r"[,，、]", stripped)
    elif isinstance(value, list):
        raw_tags = value
    else:
        raw_tags = []

    tags: list[str] = []
    seen: set[str] = set()
    for item in raw_tags:
        tag = str(item).strip()
        if not tag:
            continue
        tag = tag[:20]
        key = tag.lower()
        if key in seen:
            continue
        seen.add(key)
        tags.append(tag)
        if len(tags) >= 10:
            break
    return tags


def infer_skill_category(skill_name: str, description: str = "") -> str:
    """Heuristic category inference from the skill name + description."""
    text = f"{skill_name} {description}".lower()
    if any(token in text for token in ("customer", "client", "crm", "profile", "insight", "客户", "客群", "画像", "洞察")):
        return "customer_insight"
    if any(token in text for token in ("industry", "market", "trend", "research", "sector", "行业", "市场", "趋势", "研报")):
        return "industry_market"
    if any(token in text for token in ("product", "portfolio", "pricing", "offer", "产品", "工厂", "组合", "定价")):
        return "product_factory"
    if any(token in text for token in ("trade", "trading", "transaction", "order", "deal", "交易", "下单", "成交", "委托")):
        return "trading_assist"
    if any(token in text for token in ("compliance", "risk", "legal", "audit", "control", "合规", "风控", "风险", "审计")):
        return "compliance_risk"
    if any(token in text for token in ("operation", "ops", "finance", "budget", "cost", "运营", "财务", "经营", "预算")):
        return "operations_finance"
    if any(token in text for token in ("data", "dataset", "analysis", "analytics", "chart", "report", "数据", "分析", "报表")):
        return "data_analysis"
    if any(token in text for token in ("office", "document", "hr", "admin", "meeting", "办公", "文档", "人事", "行政")):
        return "enterprise_office"
    return "other"


def extract_frontmatter_tags(skill_content: str) -> list[str]:
    """Extract ``tags`` from the SKILL.md frontmatter, if present."""
    front_matter_match = re.match(r"^---\s*\n(.*?)\n---\s*\n", skill_content, re.DOTALL)
    if not front_matter_match:
        return []
    try:
        import yaml

        loaded = yaml.safe_load(front_matter_match.group(1))
    except Exception:
        return []
    if not isinstance(loaded, dict):
        return []
    return normalize_skill_tags(loaded.get("tags"))


# ── Metadata generation (LLM) ────────────────────────────────────────────────

_SKILL_CONTENT_MAX_CHARS = 3000
_CHINESE_CHAR_RE = re.compile(r"[\u4e00-\u9fff]")


def _is_mostly_chinese(text: str, threshold: float = 0.3) -> bool:
    if not text or not text.strip():
        return False
    chinese_count = len(_CHINESE_CHAR_RE.findall(text))
    total = len(text.strip())
    return (chinese_count / total) >= threshold if total > 0 else False


def _extract_skill_summary(skill_content: str) -> str:
    """Extract only the YAML frontmatter for fast metadata generation."""
    if skill_content.startswith("---"):
        end_idx = skill_content.find("---", 3)
        if end_idx != -1:
            return skill_content[: end_idx + 3]
    if len(skill_content) <= _SKILL_CONTENT_MAX_CHARS:
        return skill_content
    truncated = skill_content[:_SKILL_CONTENT_MAX_CHARS]
    last_newline = truncated.rfind("\n")
    if last_newline > _SKILL_CONTENT_MAX_CHARS // 2:
        truncated = truncated[:last_newline]
    return truncated


def _extract_frontmatter_fields(skill_content: str) -> dict[str, str]:
    """Extract simple ``key: value`` pairs from the frontmatter block."""
    if not skill_content.startswith("---"):
        return {}
    end_idx = skill_content.find("\n---", 3)
    if end_idx == -1:
        return {}
    frontmatter_str = skill_content[3:end_idx].strip()
    result: dict[str, str] = {}
    for line in frontmatter_str.splitlines():
        if not line or line.startswith("#") or ":" not in line:
            continue
        k, _, v = line.partition(":")
        key = k.strip()
        if not key:
            continue
        result[key] = v.strip().strip("\"'")
    return result


def try_extract_metadata_from_frontmatter(skill_name: str, skill_content: str) -> dict[str, str] | None:
    """Pre-fill fields when the frontmatter description is already Chinese."""
    if not skill_content.startswith("---"):
        return None
    end_idx = skill_content.find("---", 3)
    if end_idx == -1:
        return None
    frontmatter = skill_content[3:end_idx].strip()

    desc_match = re.search(r"^description:\s*(.+?)$", frontmatter, re.MULTILINE)
    if not desc_match:
        return None
    description = desc_match.group(1).strip().strip("\"'")
    if not _is_mostly_chinese(description):
        return None

    result: dict[str, str] = {"description_zh": description}
    name_match = re.search(r"^name:\s*(.+?)$", frontmatter, re.MULTILINE)
    raw_name = name_match.group(1).strip().strip("\"'") if name_match else skill_name
    if _is_mostly_chinese(raw_name):
        result["display_name"] = raw_name
    return result


def _build_skill_metadata_prompt(skill_name: str, skill_content: str) -> str:
    summary = _extract_skill_summary(skill_content)
    fields = _extract_frontmatter_fields(skill_content)
    raw_description = fields.get("description", "").strip()
    description_hint = (
        f"\n技能描述（原文，需作为 display_name/description_zh 的主要语义依据）：\n{raw_description}\n"
        if raw_description
        else ""
    )
    return f"""你是一个技能分析专家。请根据下面的 SKILL.md 内容，为技能生成用于列表展示的中文元数据。

要求：
1. 严格只返回 JSON 对象，不要包含任何解释文字、Markdown 标记或代码块标记。
2. 所有字段的值必须是中文，即使原始内容是英文或中英混合也必须返回中文。
3. display_name 必须是简洁的中文名称（2-8 个汉字），**必须结合「技能描述」的语义生成**，而不是仅翻译英文 slug。
   - 例如：slug 为 "llm-eval"、描述为 "Evaluate fine-tuned LLMs on medical QA benchmarks"，应为「医疗大模型评测」而非通用的「大模型评估」。
   - 例如：slug 为 "fault-diagnosis"、描述为 "Kubernetes pod OOM and network fault diagnosis"，应为「K8s 故障诊断」或「容器故障排查」。
4. description_zh 是一句话中文简介，直接翻译/改写「技能描述」为中文（若描述为空再回退到 SKILL.md 摘要）。
5. safety_level 只能是以下五个值之一：高、较高、中等、较低、低。
6. capabilities 是一个字符串，简明描述技能的具体能力，适合在产品列表中展示。
7. recommended_scenarios 是一个字符串，简明描述适用场景，适合在产品列表中展示。
8. 所有字段的值必须是字符串类型，不要使用数组。

请直接返回以下 JSON（不要用 ```json``` 包裹）：
{{"display_name": "中文名称", "description_zh": "一句话中文简介", "safety_level": "高", "capabilities": "具体能力描述", "recommended_scenarios": "适用场景描述"}}

技能名称（slug）：{skill_name}
{description_hint}
SKILL.md 内容：
{summary}"""


def _build_partial_metadata_prompt(skill_name: str, skill_content: str, extracted: dict[str, str]) -> str:
    """Shorter prompt when display_name/description_zh are already known."""
    fields = _extract_frontmatter_fields(skill_content)
    raw_description = fields.get("description", "").strip()
    dn = extracted.get("display_name", "")
    dz = extracted.get("description_zh", "")
    description_hint = (
        f"\n技能描述（原文，供 capabilities/recommended_scenarios 参考）：\n{raw_description}\n"
        if raw_description
        else ""
    )
    return f"""你是一个技能分析专家。以下技能的名称和描述已经确定，请你只需要补充其余三个字段。

已有信息：
- display_name: "{dn}"
- description_zh: "{dz}"
{description_hint}
要求：
1. 严格只返回 JSON 对象，不要包含任何解释文字。
2. 包含全部 5 个字段，display_name 和 description_zh 直接使用已有值。
3. safety_level 只能是以下五个值之一：高、较高、中等、较低、低。
4. capabilities 和 recommended_scenarios 必须结合「技能描述」语义，是具体的中文字符串（不要泛泛而谈）。

请直接返回 JSON：
{{"display_name": "{dn}", "description_zh": "{dz}", "safety_level": "高", "capabilities": "具体能力描述", "recommended_scenarios": "适用场景描述"}}"""


def _extract_json_object(raw_response: str) -> str | None:
    text = raw_response.strip()
    if text.startswith("{") and text.endswith("}"):
        return text

    fenced = re.search(r"```json\s*(\{[\s\S]*?\})\s*```", text, re.IGNORECASE)
    if fenced:
        return fenced.group(1)

    generic_fenced = re.search(r"```\s*(\{[\s\S]*?\})\s*```", text, re.IGNORECASE)
    if generic_fenced:
        return generic_fenced.group(1)

    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and start < end:
        return text[start : end + 1]
    return None


def _normalize_skill_metadata(payload: dict[str, Any]) -> dict[str, str]:
    normalized: dict[str, str] = {}
    for key in (
        "display_name",
        "description_zh",
        "safety_level",
        "capabilities",
        "recommended_scenarios",
    ):
        value = payload.get(key)
        if value is None:
            normalized[key] = ""
            continue
        if isinstance(value, list):
            value = "、".join(str(item) for item in value if item)
        if not isinstance(value, str):
            value = str(value)
        normalized[key] = value.strip()

    if not normalized["display_name"]:
        raise ValueError("Field 'display_name' is required")
    if not normalized["description_zh"]:
        raise ValueError("Field 'description_zh' is required")
    return normalized


def parse_skill_metadata_response(raw_response: str) -> dict[str, str]:
    json_text = _extract_json_object(raw_response)
    if json_text is None:
        raise ValueError("Model response did not contain a JSON object")
    try:
        payload = json.loads(json_text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Model returned invalid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise ValueError("Model response JSON must be an object")
    return _normalize_skill_metadata(payload)


def has_generated_metadata(metadata_entry: dict[str, Any] | None) -> bool:
    if not metadata_entry:
        return False
    for key in (
        "display_name",
        "description_zh",
        "safety_level",
        "capabilities",
        "recommended_scenarios",
    ):
        value = metadata_entry.get(key)
        if isinstance(value, str) and value.strip():
            return True
    return False


async def generate_skill_metadata_entry(
    skill_name: str,
    skill_content: str,
    model=None,
) -> dict[str, str]:
    """Generate Chinese metadata for a skill via the configured chat model."""
    if model is None:
        model = create_chat_model(thinking_enabled=False)

    extracted = try_extract_metadata_from_frontmatter(skill_name, skill_content)

    if extracted and "display_name" in extracted and "description_zh" in extracted:
        prompt = _build_partial_metadata_prompt(skill_name, skill_content, extracted)
    else:
        prompt = _build_skill_metadata_prompt(skill_name, skill_content)

    response = await model.ainvoke(
        prompt,
        config={
            "run_name": "SkillMetadataGeneration",
            "metadata": {
                "skill_name": skill_name,
                "task": "skill_metadata_generation",
            },
        },
    )
    result = parse_skill_metadata_response(str(response.content).strip())

    # Pre-extracted Chinese fields take priority over LLM output.
    if extracted:
        for key, value in extracted.items():
            if value:
                result[key] = value
    return result


async def generate_skill_metadata_with_retry(
    skill_name: str,
    skill_content: str,
    *,
    skip_existing: bool,
    retries: int,
    model=None,
    user_id: str | None = None,
) -> dict[str, Any]:
    """Generate metadata with retries; honors ``skip_existing``."""
    existing = get_skill_metadata_entry(skill_name, user_id)
    if skip_existing and has_generated_metadata(existing):
        return {
            "success": True,
            "skill_name": skill_name,
            "skipped": True,
            "attempts": 0,
            "metadata": existing,
            "message": "Skipped because metadata already exists",
        }

    last_error: Exception | None = None
    for attempt in range(1, retries + 2):
        try:
            entry = await generate_skill_metadata_entry(skill_name, skill_content, model=model)
            return {
                "success": True,
                "skill_name": skill_name,
                "skipped": False,
                "attempts": attempt,
                "metadata": entry,
                "message": "Skill metadata generated successfully",
            }
        except Exception as exc:
            last_error = exc
            logger.warning(
                "Failed to generate metadata for skill '%s' on attempt %s/%s: %s",
                skill_name,
                attempt,
                retries + 1,
                exc,
            )
            if attempt < retries + 1:
                await asyncio.sleep(1)

    raise RuntimeError(
        f"Failed to generate metadata for skill '{skill_name}': {last_error}"
    )

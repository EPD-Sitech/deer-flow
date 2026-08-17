"""AI-driven skill evolution service (simplified, file-backed).

Records live in ``<skill_dir>/.evolution/records.json``. ``propose_evolution``
asks the configured chat model to produce an improved SKILL.md; ``apply_evolution``
writes it through the versioned file service (so it is backed up and restorable).

The harness implementation relies on a DB-backed content repo with optimistic
locking; here the filesystem is the single source of truth.
"""
from __future__ import annotations

import json
import logging
import threading
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

logger = logging.getLogger(__name__)

EVOLUTION_DIR = ".evolution"
RECORDS_FILE = "records.json"

_record_lock = threading.Lock()


@dataclass
class EvolutionRecord:
    id: str
    feedback: str
    summary: str
    updated_skill_md: str
    status: str  # pending | applied | rejected
    created_at: str
    applied_at: str | None = None


def _records_path(skill_dir: Path) -> Path:
    return skill_dir / EVOLUTION_DIR / RECORDS_FILE


def _load_records(skill_dir: Path) -> list[dict]:
    path = _records_path(skill_dir)
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        logger.warning("evolution records unreadable: %s", path)
        return []


def _save_records(skill_dir: Path, records: list[dict]) -> None:
    path = _records_path(skill_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(records, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def list_records(skill_dir: Path) -> list[EvolutionRecord]:
    return [
        EvolutionRecord(
            id=rec.get("id", ""),
            feedback=rec.get("feedback", ""),
            summary=rec.get("summary", ""),
            updated_skill_md=rec.get("updated_skill_md", ""),
            status=rec.get("status", "pending"),
            created_at=rec.get("created_at", ""),
            applied_at=rec.get("applied_at"),
        )
        for rec in _load_records(skill_dir)
    ]


def get_record(skill_dir: Path, record_id: str) -> EvolutionRecord | None:
    for rec in list_records(skill_dir):
        if rec.id == record_id:
            return rec
    return None


def _build_propose_prompt(skill_name: str, skill_md: str, feedback: str) -> str:
    return (
        "你是一位技能工程专家。请根据用户的反馈意见改进下面的 AI 技能（SKILL.md）。\n\n"
        "要求：\n"
        "1. 保持 frontmatter 的 name 字段不变（必须是 " + skill_name + "）。\n"
        "2. 输出严格的 JSON（不要 markdown 代码块），格式：\n"
        '   {"summary": "改进要点概述（中文，50 字以内）", "updated_skill_md": "改进后的完整 SKILL.md 内容"}\n'
        "3. updated_skill_md 必须以 --- 开头且包含完整的 YAML frontmatter（name/description）。\n\n"
        "当前 SKILL.md：\n"
        "---\n"
        f"{skill_md}\n"
        "---\n\n"
        f"用户反馈意见：\n{feedback}\n"
    )


async def propose_evolution(
    skill_name: str,
    skill_dir: Path,
    feedback: str,
    model=None,
) -> EvolutionRecord:
    """Ask the LLM for an improved SKILL.md and store a pending record."""
    if model is None:
        from deerflow.models import create_chat_model

        model = create_chat_model(thinking_enabled=False)

    skill_md_path = skill_dir / "SKILL.md"
    if not skill_md_path.is_file():
        raise FileNotFoundError(f"SKILL.md 不存在: {skill_name}")

    prompt = _build_propose_prompt(
        skill_name,
        skill_md_path.read_text(encoding="utf-8"),
        feedback,
    )
    response = await model.ainvoke(
        prompt,
        config={
            "run_name": "SkillEvolutionProposal",
            "metadata": {"skill_name": skill_name, "task": "skill_evolution"},
        },
    )

    text = str(response.content).strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        # Tolerate a ```json fence around the payload.
        if "```" in text:
            inner = text.split("```")[1]
            inner = inner.removeprefix("json").strip()
            parsed = json.loads(inner)
        else:
            raise ValueError(f"AI 演进响应不是有效 JSON: {text[:200]}")

    summary = str(parsed.get("summary") or "").strip()
    updated_md = str(parsed.get("updated_skill_md") or "").strip()
    if not updated_md:
        raise ValueError("AI 演进响应缺少 updated_skill_md")

    record = EvolutionRecord(
        id=uuid.uuid4().hex[:12],
        feedback=feedback,
        summary=summary or "AI 改进建议",
        updated_skill_md=updated_md,
        status="pending",
        created_at=datetime.now(UTC).isoformat(),
    )

    with _record_lock:
        records = _load_records(skill_dir)
        records.insert(0, record.__dict__)
        _save_records(skill_dir, records)

    return record


def apply_evolution(skill_dir: Path, record_id: str) -> EvolutionRecord:
    """Write the proposed SKILL.md through the versioned file service."""
    from app.gateway.skill_file_service import write_file

    record = get_record(skill_dir, record_id)
    if record is None:
        raise FileNotFoundError(f"演进记录不存在: {record_id}")
    if record.status != "pending":
        raise ValueError(f"演进记录状态为 {record.status}，仅 pending 可应用")

    write_file(skill_dir, "SKILL.md", record.updated_skill_md, skill_name=None)

    with _record_lock:
        records = _load_records(skill_dir)
        for rec in records:
            if rec.get("id") == record_id:
                rec["status"] = "applied"
                rec["applied_at"] = datetime.now(UTC).isoformat()
                break
        _save_records(skill_dir, records)

    return get_record(skill_dir, record_id) or record


def reject_evolution(skill_dir: Path, record_id: str) -> EvolutionRecord:
    record = get_record(skill_dir, record_id)
    if record is None:
        raise FileNotFoundError(f"演进记录不存在: {record_id}")
    if record.status != "pending":
        raise ValueError(f"演进记录状态为 {record.status}，仅 pending 可拒绝")

    with _record_lock:
        records = _load_records(skill_dir)
        for rec in records:
            if rec.get("id") == record_id:
                rec["status"] = "rejected"
                break
        _save_records(skill_dir, records)

    return get_record(skill_dir, record_id) or record


SUGGESTION_PROMPTS: list[str] = [
    "为技能补充更详细的适用场景和使用步骤说明",
    "为技能增加常见问题（FAQ）与边界情况处理",
    "优化技能描述，让模型更容易在合适的时机触发它",
    "为技能补充参数说明与示例调用",
    "审查并修复 SKILL.md 中可能存在的安全隐患（提示注入、危险命令）",
]

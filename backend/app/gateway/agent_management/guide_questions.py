from __future__ import annotations

from typing import Any

import yaml

MAX_GUIDE_QUESTIONS = 6
MAX_WELCOME_SUGGESTIONS = 6
WELCOME_SUGGESTION_ICONS = {
    "sparkles",
    "pen",
    "microscope",
    "shapes",
    "graduation-cap",
    "lightbulb",
}


def validate_welcome_suggestions(document: dict[str, Any]) -> list[dict[str, str]] | None:
    """Validate ``ui.welcome_suggestions`` while preserving missing-vs-empty."""
    ui = document.get("ui")
    if ui is None:
        return None
    if not isinstance(ui, dict):
        raise ValueError("config.yaml 中 ui 必须是对象")
    if "welcome_suggestions" not in ui or ui["welcome_suggestions"] is None:
        return None
    raw = ui["welcome_suggestions"]
    if not isinstance(raw, list):
        raise ValueError("ui.welcome_suggestions 必须是数组")
    if len(raw) > MAX_WELCOME_SUGGESTIONS:
        raise ValueError(f"欢迎快捷选项最多配置 {MAX_WELCOME_SUGGESTIONS} 条")

    suggestions: list[dict[str, str]] = []
    for index, item in enumerate(raw, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"第 {index} 条欢迎快捷选项必须是对象")
        label = item.get("label")
        prompt = item.get("prompt")
        icon = item.get("icon", "lightbulb")
        if not isinstance(label, str) or not label.strip():
            raise ValueError(f"第 {index} 条欢迎快捷选项缺少显示名称")
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError(f"第 {index} 条欢迎快捷选项缺少提示词")
        if not isinstance(icon, str) or icon not in WELCOME_SUGGESTION_ICONS:
            raise ValueError(f"第 {index} 条欢迎快捷选项图标无效")
        suggestions.append(
            {
                "label": label.strip(),
                "prompt": prompt.strip(),
                "icon": icon,
            }
        )
    return suggestions


def welcome_suggestions_from_document(
    document: dict[str, Any],
) -> list[dict[str, str]] | None:
    """Return validated public-safe welcome shortcut data."""
    return validate_welcome_suggestions(document)


def validate_guide_questions(document: dict[str, Any]) -> list[dict[str, str]]:
    """Validate the migration-owned ``ui.guide_questions`` block."""
    ui = document.get("ui")
    if ui is None:
        return []
    if not isinstance(ui, dict):
        raise ValueError("config.yaml 中 ui 必须是对象")
    raw = ui.get("guide_questions")
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("ui.guide_questions 必须是数组")
    if len(raw) > MAX_GUIDE_QUESTIONS:
        raise ValueError(f"引导问题最多配置 {MAX_GUIDE_QUESTIONS} 条")
    questions: list[dict[str, str]] = []
    for index, item in enumerate(raw, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"第 {index} 条引导问题必须是对象")
        question = item.get("question")
        if not isinstance(question, str) or not question.strip():
            raise ValueError(f"第 {index} 条引导问题缺少问题文案")
        prompt = item.get("prompt")
        if prompt is not None and not isinstance(prompt, str):
            raise ValueError(f"第 {index} 条引导问题的 prompt 必须是字符串")
        entry = {"question": question.strip()}
        if isinstance(prompt, str) and prompt.strip():
            entry["prompt"] = prompt.strip()
        questions.append(entry)
    return questions


def guide_questions_from_document(document: dict[str, Any]) -> list[dict[str, str]]:
    """Return validated, public-safe guide question data from a config document."""
    return validate_guide_questions(document)


def read_raw_config(
    store: Any,
    name: str,
    user_id: str | None = None,
    *,
    state_dir: Any | None = None,
) -> dict[str, Any]:
    """Read the original config document without changing the native Agent schema."""
    reader = getattr(store, "get_raw_config", None)
    if reader is not None:
        return reader(name, user_id=user_id)
    session_factory = getattr(store, "_Session", None)
    row_reader = getattr(store, "_row", None)
    if session_factory is not None and row_reader is not None:
        with session_factory() as session:
            row = row_reader(session, name, user_id or "default")
        if row is None:
            raise FileNotFoundError(name)
        loaded = dict(row.config or {})
        loaded.setdefault("name", row.name)
        return loaded
    candidates = []
    if state_dir is not None:
        candidates.append(state_dir / "agents" / name.lower())
    if not candidates:
        from deerflow.config.paths import get_paths

        paths = get_paths()
        effective_user = user_id or "default"
        candidates = [paths.user_agent_dir(effective_user, name), paths.agent_dir(name)]
    for agent_dir in candidates:
        config_file = agent_dir / "config.yaml"
        if config_file.is_file():
            loaded = yaml.safe_load(config_file.read_text(encoding="utf-8")) or {}
            if not isinstance(loaded, dict):
                raise ValueError("config.yaml must contain an object")
            return loaded
    config = store.get(name, user_id=user_id)
    return config.model_dump(exclude_none=True, exclude_unset=True)

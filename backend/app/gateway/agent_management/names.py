from __future__ import annotations

import hashlib
import re
import unicodedata

MIGRATED_AGENT_NAME_PATTERN = re.compile(r"^(?:[^\W_]|-)+$", re.UNICODE)
NATIVE_AGENT_NAME_PATTERN = re.compile(r"^[A-Za-z0-9-]+$")


def normalize_migrated_agent_name(name: str) -> str:
    if not isinstance(name, str):
        raise ValueError("Agent name must be a string")
    normalized = unicodedata.normalize("NFC", name)
    if not MIGRATED_AGENT_NAME_PATTERN.fullmatch(normalized):
        raise ValueError(f"Invalid agent name '{name}'. Use Unicode letters, numbers, and hyphens only.")
    return normalized.lower()


def runtime_agent_name(name: str) -> str:
    normalized = normalize_migrated_agent_name(name)
    if NATIVE_AGENT_NAME_PATTERN.fullmatch(normalized):
        return normalized
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]
    return f"agent-{digest}"

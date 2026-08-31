"""Sub-agent package import: skip-by-default vs. overwrite semantics.

A ZIP sub-agent package carries ``skill/<name>/SKILL.md`` directories and
``agent/<role>.md`` definitions. Importing merges them into an existing agent:
skills land in custom skill storage, sub-agent definitions are appended to the
agent's SOUL.md as ``### <title>`` sections.

Without ``overwrite`` the import is purely additive (existing names are
skipped). With ``overwrite=True`` same-named skills and sub-agent sections are
replaced in place, which is what lets an operator ship a new package version.
"""

from __future__ import annotations

import asyncio
import importlib
import io
import zipfile

import pytest
import yaml
from fastapi import UploadFile

from deerflow.skills.installer import SkillAlreadyExistsError
from deerflow.skills.storage import LocalSkillStorage

router_module = importlib.import_module("app.gateway.agent_management.router")

SKILL_NAME = "demo-skill"
AGENT_NAME = "demo-agent"


def _make_package(skill_body: str, agent_body: str) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            f"skill/{SKILL_NAME}/SKILL.md",
            f"---\nname: {SKILL_NAME}\ndescription: Demo skill for tests\n---\n\n{skill_body}\n",
        )
        archive.writestr(
            f"agent/{AGENT_NAME}.md",
            f"---\nname: {AGENT_NAME}\ntools: [read_file]\n---\n\n{agent_body}\n",
        )
    return buffer.getvalue()


class _FakeService:
    """Minimal stand-in for AgentManagementService."""

    def __init__(self, soul: str = "") -> None:
        self.config: dict = {"name": "wealth-agent", "skills": []}
        self.soul = soul

    def describe(self, name: str) -> dict:
        return {**self.config, "soul": self.soul}

    def update_files(self, name: str, *, config_yaml: str | None = None, soul: str | None = None) -> bool:
        if config_yaml is not None:
            self.config = yaml.safe_load(config_yaml) or {}
        if soul is not None:
            self.soul = soul
        return True


def _import(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
    service: _FakeService,
    content: bytes,
    *,
    overwrite: bool = False,
    refresh=None,
) -> dict:
    monkeypatch.setattr(router_module, "_require_agents_api_enabled", lambda: None)
    monkeypatch.setattr(router_module, "_service", lambda scope, **kwargs: service)
    monkeypatch.setattr(router_module, "get_effective_user_id", lambda: "tester")
    monkeypatch.setattr(router_module, "get_app_config", lambda: None)
    monkeypatch.setattr(
        router_module,
        "get_or_new_user_skill_storage",
        lambda *args, **kwargs: LocalSkillStorage(host_path=str(tmp_path / "skills")),
    )
    monkeypatch.setattr(
        router_module,
        "refresh_user_skills_system_prompt_cache_async",
        refresh or (lambda user_id: asyncio.sleep(0)),
    )

    async def _skip_scan(*args, **kwargs):
        return []

    monkeypatch.setattr("deerflow.skills.installer._scan_skill_archive_contents_or_raise", _skip_scan)

    upload = UploadFile(file=io.BytesIO(content), filename="package.zip")
    return asyncio.run(router_module.import_sub_agent_package("wealth-agent", file=upload, scope="user", overwrite=overwrite))


def _installed_skill_body(tmp_path) -> str:
    return (tmp_path / "skills" / "custom" / SKILL_NAME / "SKILL.md").read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# First import
# ---------------------------------------------------------------------------


def test_first_import_installs_skills_and_merges_sub_agents(monkeypatch, tmp_path):
    service = _FakeService()

    result = _import(monkeypatch, tmp_path, service, _make_package("skill v1", "agent v1"))

    assert result["installed_skills"] == [SKILL_NAME]
    assert result["merged_sub_agents"] == [AGENT_NAME]
    assert result["updated_skills"] == []
    assert result["updated_sub_agents"] == []
    assert result["skipped_skills"] == []
    assert result["errors"] == []
    assert "agent v1" in service.soul
    assert service.config["skills"] == [SKILL_NAME]
    assert "skill v1" in _installed_skill_body(tmp_path)


# ---------------------------------------------------------------------------
# Re-import without overwrite stays purely additive
# ---------------------------------------------------------------------------


def test_reimport_without_overwrite_skips_existing_entries(monkeypatch, tmp_path):
    service = _FakeService()
    _import(monkeypatch, tmp_path, service, _make_package("skill v1", "agent v1"))

    result = _import(monkeypatch, tmp_path, service, _make_package("skill v2", "agent v2"))

    assert result["skipped_skills"] == [SKILL_NAME]
    assert result["skipped_sub_agents"] == [AGENT_NAME]
    assert result["installed_skills"] == []
    assert result["updated_skills"] == []
    assert result["updated_sub_agents"] == []
    assert "agent v1" in service.soul and "agent v2" not in service.soul
    assert "skill v1" in _installed_skill_body(tmp_path)


# ---------------------------------------------------------------------------
# Re-import with overwrite replaces in place
# ---------------------------------------------------------------------------


def test_reimport_with_overwrite_replaces_skills_and_sub_agents(monkeypatch, tmp_path):
    service = _FakeService()
    _import(monkeypatch, tmp_path, service, _make_package("skill v1", "agent v1"))

    result = _import(monkeypatch, tmp_path, service, _make_package("skill v2", "agent v2"), overwrite=True)

    assert result["updated_skills"] == [SKILL_NAME]
    assert result["updated_sub_agents"] == [AGENT_NAME]
    assert result["installed_skills"] == []
    assert result["skipped_skills"] == []
    assert result["skipped_sub_agents"] == []
    assert result["success"] is True
    assert "agent v2" in service.soul and "agent v1" not in service.soul
    assert service.soul.count(f"### {AGENT_NAME}") == 1
    assert "skill v2" in _installed_skill_body(tmp_path)


def test_overwrite_preserves_neighbouring_sub_agent_sections(monkeypatch, tmp_path):
    service = _FakeService(soul="# Soul\n\n## Sub-Agents\n\n### keeper\n\nkeeper body\n")
    _import(monkeypatch, tmp_path, service, _make_package("skill v1", "agent v1"))

    _import(monkeypatch, tmp_path, service, _make_package("skill v2", "agent v2"), overwrite=True)

    assert "### keeper" in service.soul
    assert "keeper body" in service.soul
    assert f"### {AGENT_NAME}" in service.soul
    assert "agent v2" in service.soul
    # The replaced section must not leave the previous body behind.
    assert "agent v1" not in service.soul


def test_overwrite_replaces_trailing_sub_agent_section(monkeypatch, tmp_path):
    """The last section in SOUL.md has no following heading to bound it."""
    service = _FakeService(soul="# Soul\n\n## Sub-Agents\n\n### keeper\n\nkeeper body\n")
    _import(monkeypatch, tmp_path, service, _make_package("skill v1", "agent v1"))
    # demo-agent is appended last, so its section is the trailing one.
    assert service.soul.index(f"### {AGENT_NAME}") > service.soul.index("### keeper")

    _import(monkeypatch, tmp_path, service, _make_package("skill v2", "agent v2"), overwrite=True)

    assert "agent v2" in service.soul
    assert "agent v1" not in service.soul
    assert "keeper body" in service.soul


def test_overwrite_refreshes_skill_prompt_cache(monkeypatch, tmp_path):
    refreshed: list[str] = []

    async def _record(user_id: str) -> None:
        refreshed.append(user_id)

    service = _FakeService()
    _import(monkeypatch, tmp_path, service, _make_package("skill v1", "agent v1"), refresh=_record)
    refreshed.clear()

    _import(monkeypatch, tmp_path, service, _make_package("skill v2", "agent v2"), overwrite=True, refresh=_record)

    assert refreshed == ["tester"]


# ---------------------------------------------------------------------------
# Storage contract
# ---------------------------------------------------------------------------


def test_storage_install_rejects_duplicate_unless_overwrite(monkeypatch, tmp_path):
    storage = LocalSkillStorage(host_path=str(tmp_path / "skills"))

    async def _skip_scan(*args, **kwargs):
        return []

    monkeypatch.setattr("deerflow.skills.installer._scan_skill_archive_contents_or_raise", _skip_scan)

    payload = _make_package("skill v1", "agent v1")
    result = asyncio.run(storage.ainstall_skill_from_archive(_write_archive(tmp_path, payload, "first")))
    assert result["skill_name"] == SKILL_NAME

    with pytest.raises(SkillAlreadyExistsError):
        asyncio.run(storage.ainstall_skill_from_archive(_write_archive(tmp_path, payload, "second")))

    updated = asyncio.run(storage.ainstall_skill_from_archive(_write_archive(tmp_path, payload, "third"), overwrite=True))
    assert updated["skill_name"] == SKILL_NAME


def _write_archive(tmp_path, payload: bytes, label: str):
    """Materialize the package's single skill as a ``.skill`` archive."""
    import zipfile as _zipfile

    work_dir = tmp_path / f"work-{label}"
    work_dir.mkdir()
    extracted = work_dir / "extracted"
    with _zipfile.ZipFile(io.BytesIO(payload)) as archive:
        archive.extractall(extracted)
    skill_dir = extracted / "skill" / SKILL_NAME
    target = work_dir / f"{SKILL_NAME}.skill"
    with _zipfile.ZipFile(target, "w", _zipfile.ZIP_DEFLATED) as skill_archive:
        for file_path in skill_dir.rglob("*"):
            if file_path.is_file():
                skill_archive.write(file_path, f"{SKILL_NAME}/{file_path.relative_to(skill_dir)}")
    return target

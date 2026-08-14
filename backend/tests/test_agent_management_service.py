from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest
import yaml

from app.gateway.agent_management.catalog import AgentCatalogService
from app.gateway.agent_management.names import (
    NATIVE_AGENT_NAME_PATTERN,
    normalize_migrated_agent_name,
    runtime_agent_name,
)
from app.gateway.agent_management.platform_store import PlatformAgentStore
from app.gateway.agent_management.service import AgentManagementService, InvalidAgentArchive
from app.gateway.agent_management.sharing import AgentShareRegistry, ShareConflict
from deerflow.config import agents_config as agents_config_module
from deerflow.config.agents_config import AgentConfig
from deerflow.config.paths import Paths
from deerflow.persistence.agents import AgentExistsError
from deerflow.persistence.agents.file import FileAgentStore


class MemoryAgentStore:
    def __init__(self) -> None:
        self.records: dict[tuple[str, str], tuple[dict, str]] = {}

    def _key(self, name: str, user_id: str | None) -> tuple[str, str]:
        return (user_id or "default", name.lower())

    def get(self, name: str, *, user_id: str | None = None) -> AgentConfig:
        try:
            config, _ = self.records[self._key(name, user_id)]
        except KeyError as exc:
            raise FileNotFoundError(name) from exc
        return AgentConfig(**config)

    def get_raw_config(self, name: str, *, user_id: str | None = None) -> dict:
        try:
            config, _ = self.records[self._key(name, user_id)]
        except KeyError as exc:
            raise FileNotFoundError(name) from exc
        return dict(config)

    def get_soul(self, name: str, *, user_id: str | None = None) -> str | None:
        try:
            _, soul = self.records[self._key(name, user_id)]
        except KeyError as exc:
            raise FileNotFoundError(name) from exc
        return soul or None

    def exists(self, name: str, *, user_id: str | None = None) -> bool:
        return self._key(name, user_id) in self.records

    def list(self, *, user_id: str | None = None) -> list[AgentConfig]:
        owner = user_id or "default"
        return [AgentConfig(**config) for (record_owner, _), (config, _) in self.records.items() if record_owner == owner]

    def create(self, name: str, config: dict, soul: str, *, user_id: str | None = None) -> None:
        key = self._key(name, user_id)
        if key in self.records:
            raise AgentExistsError(name)
        self.records[key] = (dict(config), soul)

    def update(self, name: str, config: dict | None, soul: str | None, *, user_id: str | None = None) -> None:
        key = self._key(name, user_id)
        previous_config, previous_soul = self.records.get(key, ({"name": name}, ""))
        self.records[key] = (dict(config) if config is not None else previous_config, previous_soul if soul is None else soul)

    def delete(self, name: str, *, user_id: str | None = None) -> str:
        key = self._key(name, user_id)
        if key not in self.records:
            return "missing"
        del self.records[key]
        return "deleted"


@pytest.fixture
def service(tmp_path: Path) -> AgentManagementService:
    store = MemoryAgentStore()
    store.create(
        "writer",
        {
            "name": "writer",
            "description": "Writes concise reports",
            "skills": ["research"],
            "ui": {"guide_questions": [{"question": "分析这份报告"}]},
        },
        "# Identity\n\nYou are a report writer with strict sourcing rules.",
        user_id="alice",
    )
    return AgentManagementService(store=store, user_id="alice", state_dir=tmp_path)


def test_export_import_and_clone_are_store_backed(service: AgentManagementService) -> None:
    archive = service.export_agent("writer", format="zip")
    with zipfile.ZipFile(io.BytesIO(archive.content)) as exported:
        assert set(exported.namelist()) == {"manifest.json", "config.yaml", "SOUL.md"}
        assert "memory.json" not in exported.namelist()

    clone = service.clone_agent("writer", "writer-copy")
    assert clone.name == "writer-copy"
    assert service.store.get_soul("writer-copy", user_id="alice") == service.store.get_soul("writer", user_id="alice")

    service.store.delete("writer-copy", user_id="alice")
    result = service.import_agent(archive.content, filename="writer.agent.zip", name_override="writer-copy")
    assert result.imported == [{"name": "writer-copy", "status": "created", "source": "upload"}]
    assert result.errors == []


def test_import_rejects_path_traversal(service: AgentManagementService) -> None:
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w") as archive:
        archive.writestr("../config.yaml", "name: escaped")

    with pytest.raises(InvalidAgentArchive, match="unsafe archive path"):
        service.import_agent(payload.getvalue(), filename="bad.zip")


def test_versions_restore_config_and_soul(service: AgentManagementService) -> None:
    version = service.create_version("writer", "before edit")
    service.update_files("writer", soul="# Changed\n\nTemporary content for the edited agent.")

    restored = service.restore_version("writer", version["version_id"])

    assert restored["restored"] is True
    assert service.store.get_soul("writer", user_id="alice").startswith("# Identity")
    assert len(service.list_versions("writer")) == 2
    assert service.get_version("writer", "../../outside") is None


def test_validate_and_batch_delete(service: AgentManagementService) -> None:
    validation = service.validate_agent("writer")
    assert validation["valid"] is True
    assert any(check["check"] == "soul_not_empty" for check in validation["checks"])

    result = service.batch_delete(["writer", "missing"])
    assert result.deleted == ["writer"]
    assert result.errors == [{"name": "missing", "error": "Agent 'missing' not found"}]


def test_direct_config_update_cannot_rename_agent(service: AgentManagementService) -> None:
    with pytest.raises(ValueError, match="does not match"):
        service.update_files("writer", config_yaml="name: another-agent\ndescription: renamed")

    with pytest.raises(ValueError, match="required name"):
        service.update_files("writer", config_yaml="description: missing name")


def test_describe_exposes_complete_editable_agent_document(service: AgentManagementService) -> None:
    details = service.describe("writer")

    assert details["name"] == "writer"
    assert details["skills"] == ["research"]
    assert details["soul"].startswith("# Identity")


def test_admin_can_manage_and_preserve_guide_questions(service: AgentManagementService) -> None:
    config = yaml.safe_dump(
        {
            "name": "writer",
            "description": "Writes concise reports",
            "skills": ["research"],
            "ui": {
                "guide_questions": [
                    {"question": "帮我写报告", "prompt": "请根据以下材料写报告"},
                    {"question": "总结重点"},
                ]
            },
        },
        allow_unicode=True,
    )

    updated = service.update_files("writer", config_yaml=config)

    assert updated["ui"]["guide_questions"][0]["question"] == "帮我写报告"
    exported = service.export_agent("writer")
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        exported_config = yaml.safe_load(archive.read("config.yaml"))
    assert exported_config["ui"] == updated["ui"]


def test_separate_guide_questions_override_stale_config_yaml_and_persist(
    service: AgentManagementService,
) -> None:
    updated = service.update_files(
        "writer",
        config_yaml=yaml.safe_dump(
            {
                "name": "writer",
                "description": "Writes concise reports",
                "skills": ["research"],
                "ui": {"guide_questions": []},
            },
            allow_unicode=True,
        ),
        guide_questions=[{"question": "帮我分析市场", "prompt": "分析以下市场数据"}],
    )

    reloaded_service = AgentManagementService(
        store=service.store,
        user_id="alice",
        state_dir=service.state_dir,
    )

    assert updated["ui"]["guide_questions"] == [{"question": "帮我分析市场", "prompt": "分析以下市场数据"}]
    assert reloaded_service.describe("writer")["ui"]["guide_questions"] == updated["ui"]["guide_questions"]


def test_non_admin_cannot_change_guide_questions(service: AgentManagementService) -> None:
    service.can_edit_guide_questions = False
    config = yaml.safe_dump(
        {
            "name": "writer",
            "description": "Writes concise reports",
            "ui": {"guide_questions": [{"question": "受限问题"}]},
        },
        allow_unicode=True,
    )

    with pytest.raises(PermissionError, match="Only administrators"):
        service.update_files("writer", config_yaml=config)


def test_non_admin_cannot_restore_guide_question_changes(service: AgentManagementService) -> None:
    config = yaml.safe_dump(
        {
            "name": "writer",
            "description": "Writes concise reports",
            "ui": {"guide_questions": [{"question": "管理员问题"}]},
        },
        allow_unicode=True,
    )
    service.update_files("writer", config_yaml=config)
    version = service.create_version("writer", "guide questions")
    service.update_files(
        "writer",
        config_yaml=("name: writer\ndescription: Writes concise reports\nui:\n  guide_questions: []\n"),
    )
    service.can_edit_guide_questions = False

    with pytest.raises(PermissionError, match="Only administrators"):
        service.restore_version("writer", version["version_id"])


@pytest.mark.parametrize(
    "guide_questions, message",
    [
        ([{"question": ""}], "缺少问题文案"),
        ([{"question": "问题"}] * 7, "最多配置 6 条"),
    ],
)
def test_guide_question_validation(
    service: AgentManagementService,
    guide_questions: list[dict],
    message: str,
) -> None:
    config = yaml.safe_dump(
        {
            "name": "writer",
            "description": "Writes concise reports",
            "ui": {"guide_questions": guide_questions},
        },
        allow_unicode=True,
    )

    with pytest.raises(ValueError, match=message):
        service.update_files("writer", config_yaml=config)


def test_public_sharing_is_explicit_and_resolves_alias(service: AgentManagementService, tmp_path: Path) -> None:
    paths = Paths(tmp_path)
    platform_store = PlatformAgentStore(paths)
    registry = AgentShareRegistry(
        store=service.store,
        platform_store=platform_store,
        state_file=tmp_path / "public-agent-shares.json",
    )

    assert registry.get("alice", "writer")["enabled"] is False

    share = registry.update("alice", "writer", enabled=True, public_slug="report-writer")
    assert share["public_name"] == "report-writer"
    assert share["public_path"] == "/public/agent/report-writer"

    resolved = registry.resolve("report-writer")
    assert resolved is not None
    assert resolved["config"].name == "writer"
    assert resolved["soul"].startswith("# Identity")
    assert resolved["runtime_name"] == "writer"
    published = platform_store.get("writer")
    assert published.description == "Writes concise reports"
    assert platform_store.get_soul("writer") == resolved["soul"]

    visitor_catalog = AgentCatalogService(
        store=service.store,
        user_id="bob",
        paths=paths,
        can_manage_public=False,
    ).list_agents()
    public_item = next(item for item in visitor_catalog if item["name"] == "writer")
    assert public_item["scope"] == "platform"
    assert public_item["can_manage"] is False
    assert public_item["can_view_details"] is True
    assert public_item["guide_questions"] == [{"question": "分析这份报告"}]

    registry.update("alice", "writer", enabled=False)
    assert platform_store.exists("writer") is False


def test_public_resolve_skips_stale_duplicate_before_valid_share(
    service: AgentManagementService,
    tmp_path: Path,
) -> None:
    state_file = tmp_path / "public-agent-shares.json"
    registry = AgentShareRegistry(store=service.store, state_file=state_file)
    state_file.write_text('{"version": 1, "shares": [{"owner_id": "missing", "agent_name": "writer", "enabled": true, "public_slug": "reports"},{"owner_id": "alice", "agent_name": "writer", "enabled": true, "public_slug": "reports"}]}')

    resolved = registry.resolve("reports")

    assert resolved is not None
    assert resolved["owner_id"] == "alice"

    registry.update("alice", "writer", enabled=False)
    assert registry.resolve("report-writer") is None


def test_deleted_shared_custom_agent_removes_its_public_copy(
    service: AgentManagementService,
    tmp_path: Path,
) -> None:
    platform_store = PlatformAgentStore(Paths(tmp_path))
    registry = AgentShareRegistry(
        store=service.store,
        platform_store=platform_store,
        state_file=tmp_path / "public-agent-shares.json",
    )
    registry.update("alice", "writer", enabled=True)
    service.store.delete("writer", user_id="alice")

    assert registry.resolve("writer") is None
    assert platform_store.exists("writer") is False


def test_public_slug_is_unique_across_local_agents(service: AgentManagementService, tmp_path: Path) -> None:
    service.store.create(
        "analyst",
        {"name": "analyst", "description": "Analyzes reports"},
        "# Analyst",
        user_id="bob",
    )
    registry = AgentShareRegistry(
        store=service.store,
        platform_store=PlatformAgentStore(Paths(tmp_path)),
        state_file=tmp_path / "public-agent-shares.json",
    )
    registry.update("alice", "writer", enabled=True, public_slug="reports")

    with pytest.raises(ShareConflict, match="already in use"):
        registry.update("bob", "analyst", enabled=True, public_slug="reports")


def test_catalog_separates_public_and_custom_local_agents(service: AgentManagementService, tmp_path: Path) -> None:
    paths = Paths(tmp_path)
    public_dir = paths.agent_dir("public-researcher")
    public_dir.mkdir(parents=True)
    (public_dir / "config.yaml").write_text(
        yaml.safe_dump(
            {
                "name": "public-researcher",
                "description": "Shared research Agent",
                "ui": {"guide_questions": [{"question": "研究这份报告"}]},
            }
        ),
        encoding="utf-8",
    )

    catalog = AgentCatalogService(store=service.store, user_id="alice", paths=paths, can_manage_public=False).list_agents()

    assert [(item["name"], item["scope"], item["can_manage"]) for item in catalog] == [
        ("writer", "user", True),
        ("public-researcher", "platform", False),
    ]
    assert catalog[1]["can_view_details"] is True
    assert catalog[1]["can_edit_guide_questions"] is False
    assert catalog[1]["can_export"] is False
    assert catalog[1]["can_clone"] is False
    assert catalog[1]["can_share"] is False
    assert catalog[1]["can_batch"] is False
    assert catalog[1]["runtime_name"] == "public-researcher"
    assert catalog[1]["guide_questions"] == [{"question": "研究这份报告"}]
    assert catalog[0]["can_share"] is False

    admin_catalog = AgentCatalogService(store=service.store, user_id="alice", paths=paths, can_manage_public=True).list_agents()
    assert admin_catalog[1]["can_manage"] is True
    assert admin_catalog[1]["can_edit_guide_questions"] is True
    assert admin_catalog[1]["can_export"] is True
    assert admin_catalog[1]["can_clone"] is True
    assert admin_catalog[1]["can_share"] is True
    assert admin_catalog[1]["can_batch"] is True
    assert admin_catalog[0]["can_share"] is True


@pytest.mark.parametrize("name", ["bad/name", "bad name", "bad.name", "bad_name", "../agent"])
def test_migrated_agent_names_reject_unsafe_path_characters(name: str) -> None:
    with pytest.raises(ValueError, match="Invalid agent name"):
        normalize_migrated_agent_name(name)


def test_chinese_public_agent_uses_native_runtime_alias(
    service: AgentManagementService,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    paths = Paths(tmp_path)
    name = "ai产品经理培训答疑"
    public_dir = paths.agent_dir(name)
    public_dir.mkdir(parents=True)
    (public_dir / "config.yaml").write_text(
        yaml.safe_dump({"name": name, "description": "中文公共智能体"}, allow_unicode=True),
        encoding="utf-8",
    )
    (public_dir / "SOUL.md").write_text("# 产品经理培训答疑", encoding="utf-8")

    platform_store = PlatformAgentStore(paths)
    alias = platform_store.ensure_runtime_alias(name)

    assert normalize_migrated_agent_name(name) == name
    assert alias == runtime_agent_name(name)
    assert alias == runtime_agent_name(name)
    assert NATIVE_AGENT_NAME_PATTERN.fullmatch(alias)
    assert paths.agent_dir(alias).is_symlink()
    assert paths.agent_dir(alias).resolve() == public_dir.resolve()

    monkeypatch.setattr(agents_config_module, "get_paths", lambda: paths)
    native_config = FileAgentStore().get(alias, user_id="alice")
    assert native_config.name == name

    catalog = AgentCatalogService(
        store=service.store,
        user_id="alice",
        paths=paths,
        can_manage_public=True,
    ).list_agents()
    chinese_item = next(item for item in catalog if item["name"] == name)
    assert chinese_item["runtime_name"] == alias
    assert [item["name"] for item in catalog].count(name) == 1

    registry = AgentShareRegistry(
        store=service.store,
        platform_store=platform_store,
        state_file=tmp_path / "public-agent-shares.json",
    )
    share = registry.update("__platform__", name, enabled=True, scope="platform")
    assert share["public_name"].startswith("agent-")
    assert registry.resolve(share["public_name"])["config"].name == name

    assert platform_store.delete(name) == "deleted"
    assert not public_dir.exists()
    assert not paths.agent_dir(alias).is_symlink()


def test_platform_agent_store_supports_admin_managed_files(tmp_path: Path) -> None:
    paths = Paths(tmp_path)
    public_dir = paths.agent_dir("public-researcher")
    public_dir.mkdir(parents=True)
    (public_dir / "config.yaml").write_text(
        yaml.safe_dump({"name": "public-researcher", "description": "Shared research Agent"}),
        encoding="utf-8",
    )
    (public_dir / "SOUL.md").write_text("# Public researcher", encoding="utf-8")
    service = AgentManagementService(
        store=PlatformAgentStore(paths),
        user_id="admin",
        state_dir=tmp_path / "admin",
    )

    updated = service.update_files(
        "public-researcher",
        config_yaml=("name: public-researcher\ndescription: Updated public Agent\nui:\n  guide_questions: []\n"),
        soul="# Updated public researcher",
        guide_questions=[{"question": "分析这份研报", "prompt": "请分析以下研报"}],
    )
    reloaded_service = AgentManagementService(
        store=PlatformAgentStore(paths),
        user_id="admin",
        state_dir=tmp_path / "admin",
    )

    assert updated["description"] == "Updated public Agent"
    assert service.store.get_soul("public-researcher", user_id="admin") == "# Updated public researcher"
    assert reloaded_service.describe("public-researcher")["ui"]["guide_questions"] == [{"question": "分析这份研报", "prompt": "请分析以下研报"}]


def test_public_sharing_resolves_platform_agents(service: AgentManagementService, tmp_path: Path) -> None:
    paths = Paths(tmp_path)
    public_dir = paths.agent_dir("public-researcher")
    public_dir.mkdir(parents=True)
    (public_dir / "config.yaml").write_text(
        yaml.safe_dump({"name": "public-researcher", "description": "Shared research Agent"}),
        encoding="utf-8",
    )
    (public_dir / "SOUL.md").write_text("# Public researcher", encoding="utf-8")
    registry = AgentShareRegistry(
        store=service.store,
        platform_store=PlatformAgentStore(paths),
        state_file=tmp_path / "public-agent-shares.json",
    )

    registry.update(
        "__platform__",
        "public-researcher",
        enabled=True,
        public_slug="shared-research",
        scope="platform",
    )

    resolved = registry.resolve("shared-research")
    assert resolved is not None
    assert resolved["config"].name == "public-researcher"
    assert resolved["soul"] == "# Public researcher"

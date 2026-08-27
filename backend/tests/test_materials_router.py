from types import SimpleNamespace

import pytest

from app.gateway.routers.materials import (
    KNOWLEDGE_BASE_ID,
    KNOWLEDGE_UPLOAD_TOOL,
    _file_type,
    _presented_paths,
    _scan_output_files,
    _upload_args,
    _upload_tool,
)


def test_presented_paths_only_accepts_output_files_from_present_files() -> None:
    content = {
        "by_tool": {
            "present_files": [
                "/mnt/user-data/outputs/report.pdf",
                "/mnt/user-data/uploads/private.txt",
                "relative.txt",
            ]
        },
        "presented_paths": ["/mnt/user-data/outputs/fallback.txt"],
    }

    assert _presented_paths(content) == ["/mnt/user-data/outputs/report.pdf"]
    assert _presented_paths({"presented_paths": ["/mnt/user-data/outputs/fallback.txt"]}) == ["/mnt/user-data/outputs/fallback.txt"]


def test_file_type_uses_known_extensions() -> None:
    assert _file_type("report.docx", "application/octet-stream") == "doc"
    assert _file_type("photo.png", "application/octet-stream") == "image"
    assert _file_type("report.html", "text/html") == "web"
    assert _file_type("notes.txt", "text/plain") == "other"


def test_scan_output_files_includes_files_but_skips_internal_dirs(tmp_path) -> None:
    (tmp_path / "静夜思.md").write_text("床前明月光", encoding="utf-8")
    (tmp_path / ".tool-results" / "internal.txt").parent.mkdir()
    (tmp_path / ".tool-results" / "internal.txt").write_text("internal", encoding="utf-8")

    paths = _scan_output_files(tmp_path)

    assert [path for path, _ in paths] == ["/mnt/user-data/outputs/静夜思.md"]


def test_upload_args_requires_knowledge_and_file_fields() -> None:
    tool = SimpleNamespace(args_schema=SimpleNamespace(model_fields={"knowledge_base_id": object(), "file_path": object(), "title": object()}))

    assert _upload_args(tool, "/mnt/user-data/outputs/report.pdf") == {
        "knowledge_base_id": KNOWLEDGE_BASE_ID,
        "file_path": "/mnt/user-data/outputs/report.pdf",
        "title": "report.pdf",
    }


def test_upload_args_fails_closed_without_file_field() -> None:
    tool = SimpleNamespace(args_schema=SimpleNamespace(model_fields={"knowledge_base_id": object()}))

    with pytest.raises(ValueError, match="工具参数不匹配"):
        _upload_args(tool, "/mnt/user-data/outputs/report.pdf")


def test_upload_args_supports_pydantic_v1_schema() -> None:
    tool = SimpleNamespace(args_schema=SimpleNamespace(__fields__={"kb_id": object(), "file_path": object()}))

    assert _upload_args(tool, "/mnt/user-data/outputs/report.pdf") == {
        "kb_id": KNOWLEDGE_BASE_ID,
        "file_path": "/mnt/user-data/outputs/report.pdf",
    }


def test_upload_args_supports_tool_args_fallback() -> None:
    tool = SimpleNamespace(args={"dataset": object(), "upload_file": object()})

    assert _upload_args(tool, "/mnt/user-data/outputs/report.pdf") == {
        "dataset": KNOWLEDGE_BASE_ID,
        "upload_file": "/mnt/user-data/outputs/report.pdf",
    }


def test_upload_tool_uses_weknora_tool_namespace(monkeypatch) -> None:
    list_tool = SimpleNamespace(
        name="shopProduct-server_weknora-list-knowledge-bases",
        args_schema=SimpleNamespace(model_fields={}),
    )
    upload_tool = SimpleNamespace(
        name=KNOWLEDGE_UPLOAD_TOOL,
        args_schema=SimpleNamespace(model_fields={"knowledge_base_id": object(), "file_path": object()}),
    )
    monkeypatch.setattr(
        "app.gateway.routers.materials.get_cached_mcp_tools",
        lambda: [list_tool, upload_tool],
    )

    assert _upload_tool() is upload_tool

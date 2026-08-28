import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.gateway.routers.materials import (
    KNOWLEDGE_BASE_ID,
    _file_type,
    _presented_paths,
    _read_markdown,
    _scan_output_files,
    _upload_args,
    _upload_tool,
    upload_knowledge,
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


def test_upload_args_uses_markdown_title_and_content() -> None:
    tool = SimpleNamespace(
        args_schema=SimpleNamespace(
            model_fields={
                "kb_id": object(),
                "title": object(),
                "content": object(),
            }
        )
    )

    assert _upload_args(tool, title="静夜思", content="# 静夜思\n\n床前明月光") == {
        "kb_id": KNOWLEDGE_BASE_ID,
        "title": "静夜思",
        "content": "# 静夜思\n\n床前明月光",
    }


def test_upload_args_omits_optional_status_and_tag_ids() -> None:
    tool = SimpleNamespace(
        args_schema=SimpleNamespace(
            model_fields={
                "kb_id": object(),
                "title": object(),
                "content": object(),
                "status": object(),
                "tag_ids": object(),
            }
        )
    )

    assert _upload_args(tool, title="静夜思", content="床前明月光") == {
        "kb_id": KNOWLEDGE_BASE_ID,
        "title": "静夜思",
        "content": "床前明月光",
    }


@pytest.mark.parametrize(
    "fields",
    [
        {"kb_id": object(), "content": object()},
        {"kb_id": object(), "title": object()},
    ],
)
def test_upload_args_fails_closed_without_title_or_content(fields) -> None:
    tool = SimpleNamespace(args_schema=SimpleNamespace(model_fields=fields))

    with pytest.raises(ValueError, match="工具参数不匹配"):
        _upload_args(tool, title="静夜思", content="床前明月光")


def test_upload_args_supports_pydantic_v1_schema() -> None:
    tool = SimpleNamespace(
        args_schema=SimpleNamespace(
            __fields__={
                "kb_id": object(),
                "title": object(),
                "content": object(),
            }
        )
    )

    assert _upload_args(tool, title="静夜思", content="床前明月光") == {
        "kb_id": KNOWLEDGE_BASE_ID,
        "title": "静夜思",
        "content": "床前明月光",
    }


def test_upload_args_supports_tool_args_fallback() -> None:
    tool = SimpleNamespace(args={"dataset": object(), "name": object(), "markdown": object()})

    assert _upload_args(tool, title="静夜思", content="床前明月光") == {
        "dataset": KNOWLEDGE_BASE_ID,
        "name": "静夜思",
        "markdown": "床前明月光",
    }


def test_upload_tool_uses_hyphenated_create_knowledge_from_text(monkeypatch) -> None:
    upload_tool = SimpleNamespace(
        name="shopProduct-server_weknora-create-knowledge-from-text",
        args_schema=SimpleNamespace(
            model_fields={
                "kb_id": object(),
                "title": object(),
                "content": object(),
            }
        ),
    )
    monkeypatch.setattr(
        "app.gateway.routers.materials.get_cached_mcp_tools",
        lambda: [upload_tool],
    )

    assert _upload_tool() is upload_tool


def test_read_markdown_returns_utf8_source(tmp_path) -> None:
    path = tmp_path / "静夜思.md"
    path.write_text("# 静夜思\n\n床前明月光", encoding="utf-8")

    assert _read_markdown(path) == "# 静夜思\n\n床前明月光"


def test_read_markdown_rejects_non_utf8_source(tmp_path) -> None:
    path = tmp_path / "invalid.md"
    path.write_bytes(b"\xff\xfe")

    with pytest.raises(ValueError, match="UTF-8"):
        _read_markdown(path)


def test_upload_knowledge_rejects_non_markdown() -> None:
    request = Request({"type": "http", "headers": []})
    request.state.user = SimpleNamespace(id="user-1", system_role="admin")

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            upload_knowledge.__wrapped__(
                "thread-1",
                request,
                path="/mnt/user-data/outputs/report.pdf",
            )
        )

    assert exc_info.value.status_code == 400
    assert ".md" in exc_info.value.detail


def test_upload_knowledge_reads_markdown_and_invokes_text_tool(tmp_path, monkeypatch) -> None:
    path = "/mnt/user-data/outputs/静夜思.md"
    actual = tmp_path / "静夜思.md"
    actual.write_text("# 静夜思\n\n床前明月光", encoding="utf-8")
    request = Request({"type": "http", "headers": []})
    request.state.user = SimpleNamespace(id="user-1", system_role="admin")
    invoked = {}

    async def collect(*_args, **_kwargs):
        return [{"thread_id": "thread-1", "path": path, "status": "ready"}]

    async def invoke(args):
        invoked.update(args)
        return {"id": "knowledge-1"}

    monkeypatch.setattr("app.gateway.routers.materials._collect", collect)
    monkeypatch.setattr(
        "app.gateway.routers.materials.get_paths",
        lambda: SimpleNamespace(resolve_virtual_path=lambda *_args, **_kwargs: actual),
    )
    monkeypatch.setattr(
        "app.gateway.routers.materials.get_extensions_config",
        lambda: SimpleNamespace(mcp_servers={"weknora": SimpleNamespace(enabled=True)}),
    )
    monkeypatch.setattr(
        "app.gateway.routers.materials._upload_tool",
        lambda: SimpleNamespace(
            args_schema=SimpleNamespace(model_fields={"kb_id": object(), "title": object(), "content": object()}),
            ainvoke=invoke,
        ),
    )

    response = asyncio.run(upload_knowledge.__wrapped__("thread-1", request, path=path))

    assert response.status == "uploaded"
    assert response.remote_id == "knowledge-1"
    assert invoked == {
        "kb_id": KNOWLEDGE_BASE_ID,
        "title": "静夜思",
        "content": "# 静夜思\n\n床前明月光",
    }

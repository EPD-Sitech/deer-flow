from types import SimpleNamespace

import pytest
from starlette.requests import Request

from app.gateway.routers.materials import (
    KNOWLEDGE_BASE_ID,
    _file_type,
    _presented_paths,
    _preview_url,
    _scan_output_files,
    _upload_args,
    _upload_tool,
    _validate_preview_url,
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


def test_upload_args_requires_knowledge_and_url_fields() -> None:
    tool = SimpleNamespace(
        args_schema=SimpleNamespace(
            model_fields={
                "kb_id": object(),
                "url": object(),
                "enable_multimodel": object(),
            }
        )
    )

    assert _upload_args(tool, "https://deerflow.example/api/threads/thread-1/artifacts/mnt/user-data/outputs/report.pdf") == {
        "kb_id": KNOWLEDGE_BASE_ID,
        "url": "https://deerflow.example/api/threads/thread-1/artifacts/mnt/user-data/outputs/report.pdf",
        "enable_multimodel": True,
    }


def test_upload_args_fails_closed_without_url_field() -> None:
    tool = SimpleNamespace(args_schema=SimpleNamespace(model_fields={"knowledge_base_id": object()}))

    with pytest.raises(ValueError, match="工具参数不匹配"):
        _upload_args(tool, "https://deerflow.example/report.pdf")


def test_upload_args_supports_pydantic_v1_schema() -> None:
    tool = SimpleNamespace(args_schema=SimpleNamespace(__fields__={"kb_id": object(), "url": object()}))

    assert _upload_args(tool, "https://deerflow.example/report.pdf") == {
        "kb_id": KNOWLEDGE_BASE_ID,
        "url": "https://deerflow.example/report.pdf",
    }


def test_upload_args_supports_tool_args_fallback() -> None:
    tool = SimpleNamespace(args={"dataset": object(), "source_url": object()})

    assert _upload_args(tool, "https://deerflow.example/report.pdf") == {
        "dataset": KNOWLEDGE_BASE_ID,
        "source_url": "https://deerflow.example/report.pdf",
    }


def test_upload_tool_uses_hyphenated_create_knowledge_from_url(monkeypatch) -> None:
    upload_tool = SimpleNamespace(
        name="shopProduct-server_weknora-create-knowledge-from-url",
        args_schema=SimpleNamespace(model_fields={"kb_id": object(), "url": object(), "enable_multimodel": object()}),
    )
    monkeypatch.setattr(
        "app.gateway.routers.materials.get_cached_mcp_tools",
        lambda: [upload_tool],
    )

    assert _upload_tool() is upload_tool


def test_validate_preview_url_accepts_current_material_url(monkeypatch) -> None:
    url = "https://deerflow.example/api/public/artifacts/thread-1/mnt/user-data/outputs/%E9%9D%99%E5%A4%9C%E6%80%9D.md?artifact_token=signed"
    monkeypatch.setattr(
        "app.gateway.routers.materials.verify_artifact_token",
        lambda token: {"thread_id": "thread-1", "path": "/mnt/user-data/outputs/静夜思.md"} if token == "signed" else None,
    )

    assert _validate_preview_url("thread-1", "/mnt/user-data/outputs/静夜思.md", url, "deerflow.example") == url


def test_validate_preview_url_accepts_https_default_port_from_request_host(monkeypatch) -> None:
    url = "https://deerflow.example/api/public/artifacts/thread-1/mnt/user-data/outputs/report.pdf?artifact_token=signed"
    monkeypatch.setattr(
        "app.gateway.routers.materials.verify_artifact_token",
        lambda token: {"thread_id": "thread-1", "path": "/mnt/user-data/outputs/report.pdf"} if token == "signed" else None,
    )

    assert _validate_preview_url("thread-1", "/mnt/user-data/outputs/report.pdf", url, "deerflow.example:443") == url


def test_preview_url_uses_gateway_request_host(monkeypatch) -> None:
    monkeypatch.setattr("app.gateway.routers.materials.create_artifact_token", lambda **_kwargs: "signed")
    request = Request({"type": "http", "scheme": "http", "server": ("127.0.0.1", 8001), "path": "/api/materials", "headers": [(b"host", b"127.0.0.1:8001")]})

    url = _preview_url(request, "thread-1", "/mnt/user-data/outputs/静夜思.md", "user-1")

    assert url == "http://127.0.0.1:8001/api/public/artifacts/thread-1/mnt/user-data/outputs/%E9%9D%99%E5%A4%9C%E6%80%9D.md?artifact_token=signed"


def test_preview_url_uses_forwarded_https_host_and_removes_default_port(monkeypatch) -> None:
    monkeypatch.setattr("app.gateway.routers.materials.create_artifact_token", lambda **_kwargs: "signed")
    request = Request(
        {
            "type": "http",
            "scheme": "http",
            "server": ("gateway", 8001),
            "path": "/api/materials",
            "headers": [
                (b"host", b"gateway:8001"),
                (b"x-forwarded-host", b"fintech.teamshub.com:443"),
                (b"x-forwarded-proto", b"https"),
            ],
        }
    )

    url = _preview_url(request, "thread-1", "/mnt/user-data/outputs/静夜思.md", "user-1")

    assert url.startswith("https://fintech.teamshub.com/api/public/artifacts/thread-1/")


def test_preview_url_inferrs_https_from_host_port_when_proxy_protocol_is_missing(monkeypatch) -> None:
    monkeypatch.setattr("app.gateway.routers.materials.create_artifact_token", lambda **_kwargs: "signed")
    request = Request(
        {
            "type": "http",
            "scheme": "http",
            "server": ("gateway", 8001),
            "path": "/api/materials",
            "headers": [(b"host", b"fintech.teamshub.com:443")],
        }
    )

    url = _preview_url(request, "thread-1", "/mnt/user-data/outputs/静夜思.md", "user-1")

    assert url.startswith("https://fintech.teamshub.com/api/public/artifacts/thread-1/")


@pytest.mark.parametrize(
    "url",
    [
        "https://other.example/api/public/artifacts/thread-1/mnt/user-data/outputs/report.pdf?artifact_token=signed",
        "https://deerflow.example/api/public/artifacts/other/mnt/user-data/outputs/report.pdf?artifact_token=signed",
        "https://deerflow.example/api/public/artifacts/thread-1/mnt/user-data/outputs/other.pdf?artifact_token=signed",
        "https://deerflow.example/api/public/artifacts/thread-1/mnt/user-data/outputs/report.pdf?artifact_token=invalid",
        "https://deerflow.example/api/public/artifacts/thread-1/mnt/user-data/outputs/report.pdf?artifact_token=signed&other=value",
        "https://[invalid/api/public/artifacts/thread-1/mnt/user-data/outputs/report.pdf?artifact_token=signed",
    ],
)
def test_validate_preview_url_rejects_other_hosts_threads_files_and_tokens(monkeypatch, url: str) -> None:
    monkeypatch.setattr(
        "app.gateway.routers.materials.verify_artifact_token",
        lambda token: {"thread_id": "thread-1", "path": "/mnt/user-data/outputs/report.pdf"} if token == "signed" else None,
    )
    with pytest.raises(ValueError, match="预览 URL"):
        _validate_preview_url("thread-1", "/mnt/user-data/outputs/report.pdf", url, "deerflow.example")

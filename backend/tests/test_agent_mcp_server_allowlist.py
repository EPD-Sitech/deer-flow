from types import SimpleNamespace
from unittest.mock import patch

from langchain_core.tools import StructuredTool

from deerflow.tools.mcp_metadata import get_mcp_server_name, tag_mcp_tool
from deerflow.tools.tools import get_available_tools


def _tool(name: str) -> StructuredTool:
    return StructuredTool.from_function(lambda: name, name=name, description=name)


def _app_config():
    return SimpleNamespace(
        tools=[],
        models=[],
        acp_agents={},
        skill_evolution=SimpleNamespace(enabled=False),
    )


def test_mcp_tool_source_metadata_survives_tagging() -> None:
    tool = tag_mcp_tool(_tool("analytics_query"), server_name="analytics")

    assert get_mcp_server_name(tool) == "analytics"


def test_get_available_tools_filters_mcp_tools_by_server_allowlist() -> None:
    analytics = tag_mcp_tool(_tool("query"), server_name="analytics")
    browser = tag_mcp_tool(_tool("browse"), server_name="browser")
    unknown_source = tag_mcp_tool(_tool("legacy"))
    extensions = SimpleNamespace(get_enabled_mcp_servers=lambda: {"analytics": object(), "browser": object()})

    with (
        patch("deerflow.config.extensions_config.ExtensionsConfig.from_file", return_value=extensions),
        patch("deerflow.mcp.cache.get_cached_mcp_tools", return_value=[analytics, browser, unknown_source]),
    ):
        tools = get_available_tools(mcp_servers=["analytics"], app_config=_app_config())

    assert {tool.name for tool in tools} >= {"query"}
    assert "browse" not in {tool.name for tool in tools}
    assert "legacy" not in {tool.name for tool in tools}


def test_empty_mcp_server_allowlist_disables_all_mcp_tools() -> None:
    analytics = tag_mcp_tool(_tool("query"), server_name="analytics")
    extensions = SimpleNamespace(get_enabled_mcp_servers=lambda: {"analytics": object()})

    with (
        patch("deerflow.config.extensions_config.ExtensionsConfig.from_file", return_value=extensions),
        patch("deerflow.mcp.cache.get_cached_mcp_tools", return_value=[analytics]),
    ):
        tools = get_available_tools(mcp_servers=[], app_config=_app_config())

    assert "query" not in {tool.name for tool in tools}

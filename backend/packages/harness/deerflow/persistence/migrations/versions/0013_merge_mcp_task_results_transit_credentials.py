"""merge MCP task result and transit credential migration branches.

Revision ID: 0013_merge_mcp_transit
Revises: 0012_mcp_task_results, 0012_transit_credentials
Create Date: 2026-08-18
"""

from __future__ import annotations

from collections.abc import Sequence

revision: str = "0013_merge_mcp_transit"
down_revision: str | Sequence[str] | None = (
    "0012_mcp_task_results",
    "0012_transit_credentials",
)
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Join the two migration branches without applying additional DDL."""


def downgrade() -> None:
    """Split the migration graph back to both parent revisions."""

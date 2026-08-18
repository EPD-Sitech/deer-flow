"""Retired transit credential storage migration.

Revision ID: 0012_transit_credentials
Revises: 0011_mcp_tasks
Create Date: 2026-08-14
"""

from __future__ import annotations

from collections.abc import Sequence

revision: str = "0012_transit_credentials"
down_revision: str | Sequence[str] | None = "0011_mcp_tasks"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Transit credentials are fetched live from YiXin and kept only in the
    # process-local cache. The original draft of this revision created a
    # dormant table with no ORM model; keeping the revision as a no-op makes
    # fresh create_all databases and upgraded databases converge.
    pass


def downgrade() -> None:
    # No table was created by this retired migration.
    pass

"""merge operation inventory snapshot and personal access token migration branches.

Revision ID: 0018_merge_inventory_pat
Revises: 0015_inventory_snapshots, 0017_personal_access_tokens
Create Date: 2026-08-31
"""

from __future__ import annotations

from collections.abc import Sequence

revision: str = "0018_merge_inventory_pat"
down_revision: str | Sequence[str] | None = (
    "0015_inventory_snapshots",
    "0017_personal_access_tokens",
)
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Join the two migration branches without applying additional DDL."""


def downgrade() -> None:
    """Split the migration graph back to both parent revisions."""

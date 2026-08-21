"""operations dashboard inventory snapshots.

Revision ID: 0015_inventory_snapshots
Revises: 0014_operation_events
Create Date: 2026-08-21
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0015_inventory_snapshots"
down_revision: str | Sequence[str] | None = "0014_operation_events"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    if sa.inspect(bind).has_table("operation_inventory_snapshots"):
        return

    op.create_table(
        "operation_inventory_snapshots",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("total_artifacts", sa.Integer(), nullable=False),
        sa.Column("total_agents", sa.Integer(), nullable=False),
        sa.Column("total_skills", sa.Integer(), nullable=False),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("operation_inventory_snapshots", schema=None) as batch_op:
        batch_op.create_index("ix_operation_inventory_snapshots_captured_at", ["captured_at"], unique=False)
        batch_op.create_index(
            "ix_operation_inventory_snapshots_captured_id",
            ["captured_at", "id"],
            unique=False,
        )


def downgrade() -> None:
    op.drop_table("operation_inventory_snapshots")

"""platform operation events.

Revision ID: 0014_operation_events
Revises: 0013_merge_mcp_transit
Create Date: 2026-08-19
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0014_operation_events"
down_revision: str | Sequence[str] | None = "0013_merge_mcp_transit"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    if sa.inspect(bind).has_table("operation_events"):
        return

    op.create_table(
        "operation_events",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("event_type", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.String(length=64), nullable=True),
        sa.Column("actor_kind", sa.String(length=16), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("event_metadata", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("operation_events", schema=None) as batch_op:
        batch_op.create_index("ix_operation_events_event_type", ["event_type"], unique=False)
        batch_op.create_index("ix_operation_events_user_id", ["user_id"], unique=False)
        batch_op.create_index("ix_operation_events_created_at", ["created_at"], unique=False)
        batch_op.create_index("ix_operation_events_type_created", ["event_type", "created_at"], unique=False)
        batch_op.create_index("ix_operation_events_actor_created", ["actor_kind", "created_at"], unique=False)


def downgrade() -> None:
    op.drop_table("operation_events")

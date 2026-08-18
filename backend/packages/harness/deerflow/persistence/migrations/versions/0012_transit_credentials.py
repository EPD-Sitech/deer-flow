"""user_transit_credentials (Yixin SSO + oneai apiKey).

Revision ID: 0012_transit_credentials
Revises: 0011_mcp_tasks
Create Date: 2026-08-14
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0012_transit_credentials"
down_revision: str | Sequence[str] | None = "0011_mcp_tasks"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    if sa.inspect(bind).has_table("user_transit_credentials"):
        return

    op.create_table(
        "user_transit_credentials",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("yx_uuid", sa.String(length=64), nullable=False),
        sa.Column("api_key_encrypted", sa.Text(), nullable=False),
        sa.Column("default_model", sa.String(length=128), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("yx_uuid", name="uq_user_transit_credentials_yx_uuid"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_user_transit_credentials_user",
            ondelete="CASCADE",
        ),
    )
    with op.batch_alter_table("user_transit_credentials", schema=None) as batch_op:
        batch_op.create_index("idx_transit_credentials_user_id", ["user_id"], unique=False)


def downgrade() -> None:
    with op.batch_alter_table("user_transit_credentials", schema=None) as batch_op:
        batch_op.drop_index("idx_transit_credentials_user_id")
    op.drop_table("user_transit_credentials")

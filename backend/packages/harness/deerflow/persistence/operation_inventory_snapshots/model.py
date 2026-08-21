"""ORM model for operations dashboard inventory snapshots."""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import DateTime, Index
from sqlalchemy.orm import Mapped, mapped_column

from deerflow.persistence.base import Base


class OperationInventorySnapshotRow(Base):
    """Point-in-time totals that cannot be reconstructed from run history."""

    __tablename__ = "operation_inventory_snapshots"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    total_artifacts: Mapped[int] = mapped_column(nullable=False)
    total_agents: Mapped[int] = mapped_column(nullable=False)
    total_skills: Mapped[int] = mapped_column(nullable=False)
    captured_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(UTC),
        nullable=False,
        index=True,
    )

    __table_args__ = (Index("ix_operation_inventory_snapshots_captured_id", "captured_at", "id"),)

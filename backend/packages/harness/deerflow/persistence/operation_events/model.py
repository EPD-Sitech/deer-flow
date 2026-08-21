"""ORM model for platform operation events.

These rows capture product-level activity that does not naturally belong to a
thread run, such as successful logins or dashboard views. Run and token metrics
continue to come from the existing ``runs`` and ``run_events`` tables.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import JSON, DateTime, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from deerflow.persistence.base import Base


class OperationEventRow(Base):
    __tablename__ = "operation_events"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    user_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    actor_kind: Mapped[str] = mapped_column(String(16), nullable=False, default="registered")
    source: Mapped[str] = mapped_column(String(32), nullable=False, default="gateway")
    event_metadata: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(UTC), index=True)

    __table_args__ = (
        Index("ix_operation_events_type_created", "event_type", "created_at"),
        Index("ix_operation_events_actor_created", "actor_kind", "created_at"),
    )

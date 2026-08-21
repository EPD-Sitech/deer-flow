"""Best-effort recording for platform operation events."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from deerflow.persistence.engine import get_session_factory
from deerflow.persistence.operation_events.model import OperationEventRow

logger = logging.getLogger(__name__)


async def record_operation_event(
    event_type: str,
    *,
    user_id: str | None = None,
    actor_kind: str = "registered",
    source: str = "gateway",
    metadata: dict[str, Any] | None = None,
) -> None:
    """Persist a product-level event without affecting the caller's workflow."""
    sf = get_session_factory()
    if sf is None:
        return
    try:
        async with sf() as session:
            session.add(
                OperationEventRow(
                    event_type=event_type[:64],
                    user_id=user_id,
                    actor_kind=(actor_kind or "registered")[:16],
                    source=(source or "gateway")[:32],
                    event_metadata=metadata or {},
                    created_at=datetime.now(UTC),
                )
            )
            await session.commit()
    except Exception:
        logger.warning("Failed to record operation event %s", event_type, exc_info=True)

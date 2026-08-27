"""Short-lived, file-bound access tokens for external artifact fetches."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import jwt

from app.gateway.auth.config import get_auth_config

ARTIFACT_TOKEN_TYPE = "deerflow-artifact"
ARTIFACT_TOKEN_TTL = timedelta(hours=1)


def create_artifact_token(*, thread_id: str, path: str, user_id: str) -> str:
    now = datetime.now(UTC)
    payload = {
        "typ": ARTIFACT_TOKEN_TYPE,
        "sub": user_id,
        "thread_id": thread_id,
        "path": path,
        "iat": now,
        "exp": now + ARTIFACT_TOKEN_TTL,
    }
    return jwt.encode(payload, get_auth_config().jwt_secret, algorithm="HS256")


def verify_artifact_token(token: str) -> dict[str, Any] | None:
    try:
        payload = jwt.decode(token, get_auth_config().jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        return None
    if payload.get("typ") != ARTIFACT_TOKEN_TYPE or not isinstance(payload.get("sub"), str) or not isinstance(payload.get("thread_id"), str) or not isinstance(payload.get("path"), str):
        return None
    return payload

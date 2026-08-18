"""User Pydantic models for authentication."""

from datetime import UTC, datetime
from typing import Literal
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, EmailStr, Field


def _utc_now() -> datetime:
    """Return current UTC time (timezone-aware)."""
    return datetime.now(UTC)


class User(BaseModel):
    """Internal user representation."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID = Field(default_factory=uuid4, description="Primary key")
    email: EmailStr = Field(..., description="Unique email address")
    password_hash: str | None = Field(None, description="bcrypt hash, nullable for OAuth users")
    system_role: Literal["admin", "user"] = Field(default="user")
    created_at: datetime = Field(default_factory=_utc_now)

    # OAuth linkage (optional)
    oauth_provider: str | None = Field(None, description="e.g. 'github', 'google'")
    oauth_id: str | None = Field(None, description="User ID from OAuth provider")

    # Auth lifecycle
    needs_setup: bool = Field(default=False, description="True when a reset account must complete setup")
    token_version: int = Field(default=0, description="Incremented on password change to invalidate old JWTs")


class UserResponse(BaseModel):
    """Response model for user info endpoint."""

    id: str
    email: str
    system_role: Literal["admin", "user"]
    needs_setup: bool = False
    oauth_provider: str | None = Field(None, description="OAuth/SSO provider ID if the user logged in via SSO (e.g. 'keycloak')")

    # Yixin transit integration (optional — shared with /register, /initialize)
    is_yixin_user: bool = Field(
        default=False,
        description="True when the session carries a Yixin onconUUID (Yixin SSO + oneai apiKey, resolved live).",
    )
    has_api_key: bool = Field(
        default=False,
        description="True when the user's oneai apiKey was resolved live from YiXin (never stored).",
    )
    default_model: str | None = Field(
        default=None,
        description="The user's last selected model (null until first selection).",
    )

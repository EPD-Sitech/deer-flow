"""CAS SSO endpoints for Yixin/Teamshub single sign-on.

Provides:
  - GET /api/v1/auth/cas/login     — return the CAS login URL
  - GET /api/v1/auth/cas/callback  — handle CAS callback, validate ticket, create session
  - GET /api/v1/auth/cas/logout    — clear session cookie, return CAS logout URL

This module adapts the original ai-agent-harness SSO implementation
for use with DeerFlow 2.0's authentication system.
"""

from __future__ import annotations

import logging
import os

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel

from app.gateway.auth import create_access_token
from app.gateway.auth.cas_auth import (
    _decode_oncon_param,
    build_cas_login_url,
    build_cas_logout_url,
    decode_email_and_name,
    get_cas_config,
    is_cas_enabled,
    validate_ticket,
)
from app.gateway.transit.service import ensure_transit_credential
from app.gateway.auth.session_cookie import (
    ACCESS_TOKEN_COOKIE_NAME,
    SESSION_PERSISTENCE_COOKIE_NAME,
    set_session_cookie,
)
from app.gateway.auth.session_cookie_state import SKIP_AUTH_CSRF_COOKIE_STATE_ATTR
from app.gateway.csrf_middleware import CSRF_COOKIE_NAME, auth_csrf_cookie_settings, generate_csrf_token, is_secure_request
from app.gateway.deps import get_local_provider
from app.gateway.routers.auth import validate_next_param

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/auth/cas", tags=["cas-sso"])

BASE_PATH = os.getenv("DEER_FLOW_BASE_PATH", "").rstrip("/")


class LoginUrlResponse(BaseModel):
    """Response model for CAS login URL."""

    loginUrl: str


class LogoutUrlResponse(BaseModel):
    """Response model for CAS logout URL."""

    logoutUrl: str


def _set_csrf_cookie(response, request: Request) -> None:
    """Set the CSRF double-submit cookie."""
    csrf_token = generate_csrf_token()
    secure, max_age = auth_csrf_cookie_settings(request)
    response.set_cookie(
        key=CSRF_COOKIE_NAME,
        value=csrf_token,
        httponly=False,
        secure=secure,
        samesite="strict",
        max_age=max_age,
    )


@router.get("/login", response_model=LoginUrlResponse)
async def cas_login():
    """Return the CAS login URL as JSON.

    The frontend reads loginUrl from the response and navigates
    the browser there via window.location.href.
    """
    if not is_cas_enabled():
        raise HTTPException(status_code=400, detail="CAS SSO 未启用")

    login_url = build_cas_login_url()
    logger.info("CAS login requested, redirecting to: %s", login_url)
    return LoginUrlResponse(loginUrl=login_url)


@router.get("/callback")
async def cas_callback(
    request: Request,
    ticket: str | None = None,
    lsu: str | None = None,
):
    """Handle CAS callback after user authenticates on the CAS server.

    Flow:
      1. Validate the CAS ticket against the CAS serviceValidate endpoint
      2. Extract username from the CAS response
      3. Find or create the user in the DeerFlow database
      4. Create a session token
      5. Set the session cookie
      6. Redirect to the workspace
    """
    if not is_cas_enabled():
        return RedirectResponse(url=f"{BASE_PATH}/", status_code=302)

    if not ticket:
        logger.warning("CAS callback missing ticket parameter")
        raise HTTPException(status_code=400, detail="缺少 ticket 参数")

    # The CAS `service` MUST match the one used to obtain the ticket at login,
    # so we always validate against the configured service_url (never a URL
    # carrying runtime params like `lsu`). `lsu` only drives the final redirect.
    result = await validate_ticket(ticket, service_url=None)
    if not result.authenticated or not result.identifier:
        logger.warning("CAS ticket validation failed for ticket=%s", ticket[:20])
        raise HTTPException(status_code=401, detail="CAS 认证失败")

    identifier = result.identifier
    config = get_cas_config()
    if not config.email_domain:
        logger.error("CAS email_domain is not configured; cannot derive user email")
        raise HTTPException(status_code=500, detail="CAS email_domain 未配置")
    email, display_name, mobile = decode_email_and_name(identifier, result.oncon_param)

    # YiXin identity (onconUUID) — a non-secret user identifier carried in the
    # session JWT so transit credential resolution needs no DB lookup.
    yx_uuid = _decode_oncon_param(result.oncon_param).get("onconUUID")

    logger.info(
        "CAS authentication successful: identifier=%s, email=%s, display_name=%s, mobile=%s",
        identifier,
        email,
        display_name,
        mobile,
    )

    token, display_name, user_id = await _create_user_and_session(
        email, display_name or identifier, mobile, yx_uuid=yx_uuid
    )

    # Provision the oneai transit credential for Yixin users. The onconUUID is
    # extracted from the CAS onconParam and carried in the session JWT; if
    # present, we fetch the user's oneai apiKey live from the YiXin token
    # interface (never persisted). Failures never block the login — the user
    # still lands in the workspace with has_api_key=false (retry via refresh).
    try:
        if yx_uuid:
            has_api_key = await ensure_transit_credential(yx_uuid)
            logger.info("CAS transit credential provisioning: user=%s has_api_key=%s", user_id, has_api_key)
    except Exception:  # noqa: BLE001 - transit provisioning must never block login
        logger.exception("CAS transit credential provisioning failed for user %s", user_id)

    # Only allow a same-origin relative path for the post-login redirect;
    # mirrors OIDC's validate_next_param to avoid an open redirect via `lsu`.
    resolved = validate_next_param(lsu)
    redirect_url = f"{BASE_PATH}{resolved}" if resolved else f"{BASE_PATH}/workspace"

    response = RedirectResponse(url=redirect_url, status_code=302)

    set_session_cookie(response, request, token, remember_me=True, default_remember_me=True)
    _set_csrf_cookie(response, request)

    logger.info("CAS session cookie set, redirecting to %s", redirect_url)
    return response


@router.get("/logout", response_model=LogoutUrlResponse)
async def cas_logout(request: Request):
    """Clear the session cookie and return the CAS logout URL.

    The frontend should:
      1. Call this endpoint to get the CAS logout URL
      2. Clear local state
      3. Navigate to the CAS logout URL
    """
    cas_logout_url = build_cas_logout_url(service_url=f"{BASE_PATH}/")

    response = JSONResponse({"logoutUrl": cas_logout_url})

    is_https = is_secure_request(request)
    response.delete_cookie(key=ACCESS_TOKEN_COOKIE_NAME, secure=is_https, samesite="lax", path="/")
    response.delete_cookie(key=SESSION_PERSISTENCE_COOKIE_NAME, secure=is_https, samesite="lax", path="/")
    response.delete_cookie(key=CSRF_COOKIE_NAME, secure=is_https, samesite="strict", path="/")
    setattr(request.state, SKIP_AUTH_CSRF_COOKIE_STATE_ATTR, True)

    logger.info("CAS logout, CAS logout URL: %s", cas_logout_url)
    return response


async def _create_user_and_session(
    email: str, name: str, mobile: str | None = None, yx_uuid: str | None = None
) -> tuple[str, str, str]:
    """Find or create a user in DeerFlow, create a session, return the token, display name, and user id.

    Args:
        email: User email address
        name: User display name
        mobile: Optional mobile number
        yx_uuid: Optional YiXin onconUUID (Yixin SSO), stamped into the session
            JWT so transit credential resolution needs no DB lookup.

    Returns:
        Tuple of (session token, display name, user id)
    """
    provider = get_local_provider()

    existing = await provider.get_user_by_email(email)

    if existing:
        user_id = str(existing.id)
        token_version = existing.token_version
        logger.info("Found existing CAS user: id=%s, email=%s", user_id, email)
        display_name = existing.email.split("@")[0] if not name else name
    else:
        user = await provider.create_user(
            email=email,
            password=None,
            system_role="user",
        )
        user_id = str(user.id)
        token_version = user.token_version
        logger.info("Created new CAS user: id=%s, email=%s", user_id, email)
        display_name = name

    token = create_access_token(user_id, token_version=token_version, yx_uuid=yx_uuid)
    return token, display_name, user_id

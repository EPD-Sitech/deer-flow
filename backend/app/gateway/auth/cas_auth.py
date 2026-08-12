"""CAS (Central Authentication Service) client for Yixin/Teamshub SSO.

Validates CAS 2.0/3.0 tickets against the configured CAS server.
Used by the /api/v1/auth/cas/callback endpoint after the user
authenticates on the Yixin (易信) platform.

This module is adapted from the original ai-agent-harness CAS implementation
for use with DeerFlow 2.0's authentication system.
"""

from __future__ import annotations

import base64
import json
import logging
import re
import urllib.parse
from dataclasses import dataclass

import httpx

from app.gateway.auth.cas_config import get_cas_config, is_cas_enabled

logger = logging.getLogger(__name__)


@dataclass
class CasValidationResult:
    """Result of a CAS ticket validation.

    Attributes:
        authenticated: Whether the ticket validation succeeded
        username: CAS username (im_username)
        identifier: Unique identifier (workId > mobile > username)
        ticket: The CAS ticket string (ST-XXXXX)
        oncon_param: Base64-encoded user info from CAS response
    """

    authenticated: bool
    username: str | None = None
    identifier: str | None = None
    ticket: str | None = None
    oncon_param: str | None = None


def get_login_url() -> str:
    """Get the CAS login URL from configuration."""
    return get_cas_config().login_url


def get_logout_url() -> str:
    """Get the CAS logout URL from configuration."""
    return get_cas_config().logout_url


def get_service_url() -> str:
    """Get the CAS service (callback) URL from configuration."""
    return get_cas_config().service_url


def build_cas_login_url(service_url: str | None = None) -> str:
    """Build the full CAS login URL with the service parameter.

    Args:
        service_url: The callback URL to redirect after successful auth.
                      Falls back to CAS_SERVICE_URL if not provided.

    Returns:
        Complete CAS login URL with service parameter
    """
    config = get_cas_config()
    svc = service_url or config.service_url

    if not svc:
        logger.warning("CAS service URL is not configured")
        return config.login_url

    sep = "&" if "?" in config.login_url else "?"
    return f"{config.login_url}{sep}service={urllib.parse.quote(svc, safe='')}"


def build_cas_logout_url(service_url: str | None = None) -> str:
    """Build the full CAS logout URL with optional service parameter.

    Args:
        service_url: Optional URL to redirect after logout

    Returns:
        Complete CAS logout URL
    """
    config = get_cas_config()
    url = config.logout_url

    if not url:
        return ""

    if service_url:
        sep = "&" if "?" in url else "?"
        url = f"{url}{sep}service={urllib.parse.quote(service_url, safe='')}"

    return url


async def validate_ticket(
    ticket: str,
    service_url: str | None = None,
) -> CasValidationResult:
    """Validate a CAS ticket against the CAS server.

    Makes a GET request to the CAS serviceValidate endpoint and parses
    the CAS XML response to extract im_username and onconParam attributes.

    Args:
        ticket: The CAS ticket string (ST-XXXXX)
        service_url: The service URL used when requesting the ticket.
                     Falls back to CAS_SERVICE_URL if not provided.

    Returns:
        CasValidationResult with authenticated=True on success
    """
    if not is_cas_enabled():
        logger.warning("CAS is disabled, skipping ticket validation")
        return CasValidationResult(authenticated=False)

    if not ticket:
        logger.warning("CAS ticket is empty")
        return CasValidationResult(authenticated=False)

    config = get_cas_config()
    if not config.validate_url:
        logger.error("CAS validate_url is not configured")
        return CasValidationResult(authenticated=False)

    svc = service_url or config.service_url
    query = urllib.parse.urlencode({"ticket": ticket, "service": svc})
    sep = "&" if "?" in config.validate_url else "?"
    validation_url = f"{config.validate_url}{sep}{query}"

    logger.info("Validating CAS ticket against: %s", config.validate_url)

    try:
        async with httpx.AsyncClient(timeout=15.0, verify=True) as client:
            resp = await client.get(validation_url)
            resp.raise_for_status()
            body = resp.text

        logger.debug("CAS validation response (first 500 chars): %s", body[:500])

        username = _extract_attribute(body, "im_username")
        oncon_param = _extract_attribute(body, "onconParam")

        if username:
            decoded_info = _decode_oncon_param(oncon_param)
            logger.info(
                "CAS onconParam decoded: %s",
                json.dumps(decoded_info, ensure_ascii=False),
            )

            work_id = decoded_info.get("workId") or decoded_info.get("workid")
            mobile = decoded_info.get("mobile")
            identifier = work_id or mobile or username

            logger.info(
                "CAS validation successful: username=%s, identifier=%s",
                username,
                identifier,
            )
            return CasValidationResult(
                authenticated=True,
                username=username,
                oncon_param=oncon_param,
                identifier=identifier,
                ticket=ticket,
            )

        logger.warning("CAS validation failed: could not extract username from response")
        return CasValidationResult(authenticated=False)

    except httpx.HTTPStatusError as exc:
        logger.error(
            "CAS validation HTTP error: %s %s",
            exc.response.status_code,
            exc.response.text[:200],
        )
        return CasValidationResult(authenticated=False)
    except Exception:
        logger.exception("CAS validation request failed")
        return CasValidationResult(authenticated=False)


def _extract_attribute(xml_text: str, attr_name: str) -> str | None:
    """Extract an attribute value from CAS XML response using regex.

    The CAS response typically contains attributes like:
        <cas:attributes im_username="zhangsan" onconParam="..." />

    Args:
        xml_text: The CAS XML response text
        attr_name: The attribute name to extract

    Returns:
        The attribute value if found, None otherwise
    """
    pattern = rf'{attr_name}="([^"]*)"'
    match = re.search(pattern, xml_text)
    if match:
        return match.group(1)
    return None


def _decode_oncon_param(oncon_param: str | None) -> dict:
    """Decode Base64-encoded onconParam JSON to a dict.

    Args:
        oncon_param: Base64-encoded JSON string

    Returns:
        Decoded dictionary or empty dict on failure
    """
    if not oncon_param:
        return {}

    try:
        normalized = oncon_param.replace("-", "+").replace("_", "/")
        pad = 4 - len(normalized) % 4
        if pad != 4:
            normalized += "=" * pad
        decoded = base64.b64decode(normalized).decode("utf-8")
        return json.loads(decoded)
    except Exception:
        logger.warning(
            "Failed to decode onconParam: %s...",
            oncon_param[:50] if oncon_param else "",
        )
        return {}


def decode_email_and_name(identifier: str, oncon_param: str | None) -> tuple[str, str | None, str | None]:
    """Parse CAS identifier into email, display name, and mobile.

    Args:
        identifier: CAS identifier (workId > mobile > username)
        oncon_param: Base64-encoded user info from CAS

    Returns:
        Tuple of (email, display_name, mobile)
    """
    config = get_cas_config()
    decoded = _decode_oncon_param(oncon_param) if oncon_param else {}

    display_name = None
    for key in ("name", "displayName", "realName", "real_name", "cn", "userName", "user_name", "username"):
        if key in decoded and decoded[key]:
            display_name = decoded[key]
            break

    mobile = decoded.get("mobile")

    email = f"{identifier}@{config.email_domain}"

    logger.info(
        "CAS user: email=%s, display_name=%s, mobile=%s, decoded_oncon=%s",
        email,
        display_name,
        mobile,
        json.dumps(decoded, ensure_ascii=False),
    )

    return email, display_name, mobile
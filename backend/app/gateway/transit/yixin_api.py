"""易信易token 接口客户端 (Python 版，对标 Java YXInterfaceCallUtil + JkDemo)。

流程：
1. ``get_access_token()``：POST {baseurl}/oncon-service/token（form：appid/secret/grant_type）
   换取 access_token，进程内带 TTL 缓存（有效期 2 小时，提前 5 分钟续期）。
2. ``_invoke()``：POST {baseurl}/oncon-service/sys_credential/{name}/v{ver}，
   JSON body（version/id/type/action/resource + 业务字段），Authorization 带 token，
   校验 ``status == "0"``，否则抛 ``YiXinAPIError``。
"""

from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# 调试日志默认开启：每次都打印请求/响应参数（secret、access_token、apiKey 打码），
# 便于复现 status != "0" 的调用现场。对敏感字段值脱敏后再落日志。
_SENSITIVE_KEYS = {"secret", "access_token", "apiKey"}


def _mask_value(value: Any) -> Any:
    """对敏感字段值打码，其余原样返回。"""
    if isinstance(value, str) and value:
        return "***"
    return value


def _mask_payload(body: Any) -> Any:
    """递归脱敏 dict/list 中的敏感字段值。"""
    if isinstance(body, dict):
        return {k: (_mask_value(v) if k in _SENSITIVE_KEYS else _mask_payload(v)) for k, v in body.items()}
    if isinstance(body, list):
        return [_mask_payload(v) for v in body]
    return body


def _dump_request(method: str, url: str, *, headers: dict[str, str], body: Any) -> None:
    # 打印请求参数（敏感值打码），便于对照契约排查。
    safe_headers = {k: (_mask_value(v) if k.lower() in {"authorization", "app-secret", "secret"} else v) for k, v in headers.items()}
    logger.info(
        "YiXin DEBUG >> REQUEST %s %s headers=%s body=%s",
        method,
        url,
        json.dumps(safe_headers, ensure_ascii=False),
        json.dumps(_mask_payload(body), ensure_ascii=False) if body is not None else "null",
    )


def _dump_response(method: str, url: str, *, status: int, headers: Any, text: str) -> None:
    # 打印响应参数全文（敏感字段打码）。
    try:
        raw = json.loads(text) if text else None
        safe = json.dumps(_mask_payload(raw), ensure_ascii=False) if isinstance(raw, (dict, list)) else text
    except Exception:  # noqa: BLE001 - 非 JSON 响应原样输出（截断）
        safe = text[:2000] if text else ""
    logger.info(
        "YiXin DEBUG << RESPONSE %s %s -> %s body=%s",
        method,
        url,
        status,
        safe,
    )

_TOKEN_TTL_SECONDS = 2 * 60 * 60  # 2 小时
_TOKEN_RENEW_MARGIN = 5 * 60  # 提前 5 分钟续期，避免边界失效
_TOKEN_RETRY_ONCE = True


class YiXinAPIError(RuntimeError):
    """易token 业务接口返回失败（status != "0"）或调用异常。"""


class _TokenCache:
    """进程级 access_token 缓存（易token 按 appid 签发，全局单例即可）。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._token: str | None = None
        self._expires_at: float = 0.0

    def get(self) -> str | None:
        with self._lock:
            if self._token is not None and time.time() < self._expires_at - _TOKEN_RENEW_MARGIN:
                return self._token
            return None

    def set(self, token: str) -> None:
        with self._lock:
            self._token = token
            self._expires_at = time.time() + _TOKEN_TTL_SECONDS

    def invalidate(self) -> None:
        with self._lock:
            self._token = None
            self._expires_at = 0.0


_token_cache = _TokenCache()


class YiXinAPIClient:
    """易信易token 开放接口客户端。"""

    def __init__(
        self,
        appid: str,
        secret: str,
        base_url: str,
        resource: str = "",
        *,
        timeout: float = 15.0,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.appid = appid
        self.secret = secret
        self.base_url = base_url.rstrip("/")
        self.resource = resource
        self.timeout = timeout
        self._client = client

    async def _http_client(self) -> httpx.AsyncClient:
        if self._client is None:
            return httpx.AsyncClient(timeout=self.timeout)
        return self._client

    async def get_access_token(self) -> str:
        """Return a cached or freshly-fetched access_token."""
        cached = _token_cache.get()
        if cached:
            return cached

        url = f"{self.base_url}/oncon-service/token"
        logger.info("YiXin: fetching access_token from %s", url)
        body = {
            "appid": self.appid,
            "secret": self.secret,
            "grant_type": "sys_credential",
        }
        headers = {"Content-Type": "application/x-www-form-urlencoded", "Accept-Encoding": ""}
        _dump_request("POST", url, headers=headers, body=body)
        client = await self._http_client()
        resp = await client.post(url, data=body, headers=headers)
        _dump_response("POST", url, status=resp.status_code, headers=resp.headers, text=resp.text)
        resp.raise_for_status()
        data = resp.json()
        token = (data or {}).get("access_token")
        if not token:
            raise YiXinAPIError(f"易token 接口未返回 access_token: {data}")
        _token_cache.set(token)
        return token

    async def _invoke(self, api_name: str, version: str, body: dict[str, Any]) -> dict[str, Any]:
        """Call a business interface with the access_token; retries once on token expiry.

        The token is passed as a URL query parameter (``?access_token=...``),
        matching the Java reference implementation's legacy style
        (``Ppfv3Test`` comments) rather than an ``Authorization`` header — the
        relay returns ``errcode=44001 access_token为空`` when the token is not
        carried the way it expects.
        """
        for attempt in (1, 2) if _TOKEN_RETRY_ONCE else (1,):
            token = await self.get_access_token()
            url = f"{self.base_url}/oncon-service/sys_credential/{api_name}/v{version}"
            # 与 Java 旧版注释一致：token 放 URL query，而不是 Authorization header。
            url += f"?access_token={token}"
            payload: dict[str, Any] = {
                "version": version,
                "id": str(int(time.time() * 1000))[-6:],
                "type": api_name,
                "action": "request",
                **body,
            }
            if self.resource:
                payload["resource"] = self.resource

            client = await self._http_client()
            # 与 oneai 相同：易token 业务接口可能默认压缩响应，禁用压缩以拿到可解析 JSON。
            headers = {"Content-Type": "application/json", "Accept-Encoding": ""}
            _dump_request("POST", url, headers=headers, body=payload)
            resp = await client.post(url, json=payload, headers=headers)
            _dump_response("POST", url, status=resp.status_code, headers=resp.headers, text=resp.text)
            if resp.status_code in (401, 403):
                if attempt == 1:
                    _token_cache.invalidate()
                    continue
                resp.raise_for_status()
            resp.raise_for_status()

            data = resp.json()
            status = str((data or {}).get("status", "1"))
            if status != "0":
                raise YiXinAPIError(
                    f"易token 接口 {api_name} 失败: status={status} desc={(data or {}).get('desc')}"
                )
            return data
        raise YiXinAPIError(f"易token 接口 {api_name} 调用失败（重试后仍失败）")

    async def get_user_api_key(self, yx_uuid: str) -> str:
        """查询 oneai 用户 apiKey。"""
        data = await self._invoke("getUserApiKeyByUuid", "1.0", {"uuid": yx_uuid})
        api_key = ((data.get("data") or {}) or {}).get("apiKey")
        if not api_key:
            raise YiXinAPIError(f"getUserApiKeyByUuid 未返回 apiKey for uuid={yx_uuid}")
        return api_key

    async def get_user_quota(self, yx_uuid: str) -> dict[str, Any]:
        """查询 oneai 用户余额（本阶段仅接入，不展示）。"""
        data = await self._invoke("getUserQuotaByUuid", "1.0", {"uuid": yx_uuid})
        return dict(data.get("data") or {})

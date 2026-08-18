"""Transit integration (Yixin SSO + oneai dynamic models).

- ``config.py``          — read ``oncon.*`` / ``transit.*`` from config.yaml
- ``yixin_api.py``       — 易token client (token + getUserApiKeyByUuid + getUserQuotaByUuid)
- ``credential_cache.py`` — live API-key fetch + last-good fallback (no at-rest storage)
- ``service.py``         — JWT-claim resolution + credential provisioning helpers;
  this is the façade routers import from

The oneai /v1/models fetch (OpenAI-compatible, requires ``Accept-Encoding: ""``)
lives in the harness at ``deerflow.runtime.transit.get_transit_catalog`` so both
the list path (``service.fetch_transit_models``) and the run path
(``worker._resolve_transit_model_overrides``) share one implementation.

The oneai apiKey is **never persisted**: it is fetched live from the YiXin
token interface on every use and carried only in memory / the session JWT
(``yx_uuid`` claim). The YiXin interface is the durable source of truth.

Import the submodules directly (``from app.gateway.transit.service import ...``);
this package intentionally re-exports nothing, so importing a router does not
eagerly pull in the whole transit stack.
"""

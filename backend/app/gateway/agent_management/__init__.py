"""Incremental local-agent management extension for the Gateway."""

from fastapi import APIRouter

from .catalog import router as catalog_router
from .router import router as management_router
from .sharing_router import management_router as sharing_router
from .sharing_router import public_router

router = APIRouter()
router.include_router(catalog_router)
router.include_router(management_router)
router.include_router(sharing_router)
router.include_router(public_router)

__all__ = ["router"]
